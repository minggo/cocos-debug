
import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	    Thread, StackFrame, Scope, Source, Handles, Breakpoint, ErrorDestination, Variable} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as net from 'net';
import * as nls from 'vscode-nls';

import * as Path from 'path';
import * as Fs from 'fs';

import {CocosFXProtocol, CocosFXEvent, ThreadStateTypes, UnsolicitedPauses} from './cocosFirefoxProtocol';

export interface AttachRequestArguments {

	// The debug port to attach to.
	port: number;
	// The file folder opened by VSCode
	cwd: string;
	// The TCP/IP address of the port (remote addresses only supported for node >= 5.0).
	address?: string;
	// Timeout to attach to remote.
	timeout?: number;
}

interface Expandable {
	expand(session: CocosDebugSession, results: Array<Variable>, done: () => void): void;
}

class ScopeExpander implements Expandable {

	_scope: any;

	public constructor(scope: any) {
		this._scope = scope;
	}

	public expand(session: CocosDebugSession, results: Array<Variable>, done: () => void): void {
		session._addScopeVariables(this._scope, results, done);
	}
}

class PropertyExpander implements Expandable {

	actor: string;
	name: string; // used for log

	public constructor(actor: string, name: string) {
		this.actor = actor;
		this.name = name;
	}

	public expand(session: CocosDebugSession, results: Array<Variable>, done: () => void): void {
		session._addPropertyVariables(this, results, () => {
			done();
		});
	}
}

class BreakpointInfo {

	actor: string;
	line: number;
	column: number;
	actualLine: number;

	public constructor(actor: string, line: number, column: number, actualLine: number) {
		this.actor = actor;
		this.line = line;
		this.column = column;
		this.actualLine = actualLine;
	}
}

class CocosDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;
	private static ATTACH_TIMEOUT = 10000;

	private _trace: boolean = false;
    private _cocos: CocosFXProtocol;
	private _localize: nls.LocalizeFunc = nls.loadMessageBundle();
	private _breakpoints = new Map<string, Array<BreakpointInfo>>();
	private _localRoot: string;
	private _localEngineRoot: string;
	private _localScriptStartIndex: number;
	private _remoteRoot: string;
	private _lastStoppedEvent;
	private _inShutDown:boolean;
	private _isTerminated: boolean;

	private _threadActor: string;
	private _remotePaused: boolean;
	private _tabActor:string;
	private _sourceActorMap = {};

	private _frameHandles = new Handles<any>();
	private _variableHandles = new Handles<Expandable>();
	private _variableCache = new Map<string, Array<Variable>>();

	public constructor() {

		super();

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._cocos = new CocosFXProtocol();

		this._cocos.on('error', (event: CocosFXEvent) => {
			this._termiated('cocos firefox protocol error: ' + event.body)
		});

		this._cocos.on('close', (event: CocosFXEvent) => {
			this._termiated('cocos firefox protocol close');
		});

		this._cocos.on('diagnostic', (event: CocosFXEvent) => {
			console.error(event.body);
		});

		this._cocos.on('threadState', (event: CocosFXEvent) => {

			this._remotePaused = (event.body.type === ThreadStateTypes.paused);

            if (this._remotePaused) {

				let stopEvent = this._createStoppedEvent(event.body);
				if (stopEvent) {

					this._stopped('threadState');

					this._lastStoppedEvent = stopEvent;
					this.sendEvent(this._lastStoppedEvent);
				}
			}
		});
	}

	public log(category: string, message: string): void {

		if (this._trace) {
			message = `${category}: ${message} \n`;
			this.sendEvent(new OutputEvent(message));
		}
	}

    /**
	 * The debug session has terminated
	 */
	private _termiated(reason: string): void {

		this.log('ar', `_termiated: ${reason}`);

		if (!this._isTerminated) {
			this._isTerminated = true;
			this.sendEvent(new TerminatedEvent);
		}
	}

	/**
	 * clear every thing that is no longer valid after a new stopped event
	 */
	private _stopped(reason: string): void {

		this.log('la', `_stopped: got ${reason} event from JSB`);
		this._frameHandles.reset();
		this._variableHandles.reset();
		this._variableCache = new Map<string, Array<Variable>>();
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// This debug adapter supports configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// This debug adapter supports function breakpoints.
		response.body.supportsFunctionBreakpoints = true;

		// TODO: supports conditional breakpoint
		response.body.supportsConditionalBreakpoints = false;

		// TODO: supports evaluate for hovers
		response.body.supportsEvaluateForHovers = false;

		this.sendResponse(response);
	}

    // -------------attach request-----------------------------------------------------------------

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {

		const address = args.address ? args.address : '127.0.0.1';
		const timeout = args.timeout ? args.timeout : CocosDebugSession.ATTACH_TIMEOUT;

		this.log('ar', `attachRequest: address: ${address} port: ${args.port}`);

		let connected = false;
        let socket: net.Socket = new net.Socket();
		socket.connect(args.port, address);

		socket.on('connect', (err: any) => {
			this.log('ar', 'attachRequest: connected');
			connected = true;
			this._localRoot = args.cwd;
			this._localScriptStartIndex = this._localRoot.length + 1;
			this._localEngineRoot = this._getLocalEngineRoot(this._localRoot);
			this._cocos.startDispatch(socket, socket);
			this._initialize(response);
		});

        const endTime = new Date().getTime() + timeout;
		socket.on('error', (err: any) => {
			if (connected) {
				// error happpend after connected
				this._termiated('socket error');
			}
			else {
				if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
					const now = new Date().getTime();
					if (now < endTime) {
						setTimeout(() => {
							this.log('ar', 'attachRequest: retry socket.connect');
							socket.connect(args.port);
						}, 200);  // retry afater 200 ms
					}
					else {
						this.sendErrorResponse(response, 2009, this._localize('VSND2009', "cannot connect to JSB (timeout after {_timeout}ms)"), { _timeout: timeout });
					}
				}
				else {
					this.sendErrorResponse(response, 2010, this._localize('VSND2010', "cannot connect to JSB (reason: {_error})"), { _error: err.message });
				}
			}
		});

		socket.on('end', (err: any) => {
			this._termiated('socket end');
		});
	}

	/**
	 * local engine root will be different in different modes
	 * TODO: implement debug mode
	 *  - creator project
	 */
	private _getLocalEngineRoot(scriptRoot: string): string {

		// cocos jstests?
		let engineRoot = Path.join(scriptRoot, '../../cocos/scripting/js-bindings');
		if (CocosDebugSession._dirExists(engineRoot)) {
			return engineRoot;
		}

		// project created by cocos console?
		engineRoot = Path.join(scriptRoot, 'frameworks/cocos2d-x/cocos/scripting/js-bindings');
		if (CocosDebugSession._dirExists(engineRoot)) {
			return engineRoot;
		}
	}

    /**
	 * Should get resources from remote and record the corredponding actors.
	 */
	private _initialize(respond: DebugProtocol.Response): void {

        // listTabs request
		this._listTabs().then(tabActor => {

			this._tabActor = tabActor;

			// attach tab
			return this._attachTab(tabActor);
		}).then(() => {
			// attach thread actor
			return this._attachThreadActor();
		}).then(() => {
			// get sources
			return this._getSources();
		}).then(() => {
			// resume thread actor
			return this._resumeThreadActor();
		}).then(() => {
			// can set breakpoint now
			this.sendEvent(new InitializedEvent());
			this.sendResponse(respond);
		}).catch(e => {
			console.error(e);
			this._sendCocosResponse(respond, e);
		});
	}

	private _listTabs(): Promise<string> {

		const request = {
			to: 'root',
			"type": 'listTabs'
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return Promise.reject('error in listTabs: ' + result.error);
			}

			const selectedTab = result.tabs[result.selected];
			return selectedTab.actor;
		}).catch(e => {
			return Promise.reject(e);
		});
	}

	private _attachTab(tabActor: string): Promise<void> {

		const request = {
			to: tabActor,
			type: "attach"
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return Promise.reject('error in attach tab: ' + result.error);
			}

			this._threadActor = result.threadActor;
		}).catch(e => {
			return Promise.reject(e);
		});
	}

	private _attachThreadActor(): Promise<void> {

		const request = {
			to: this._threadActor,
			type: 'attach',
			useSourceMaps: true,
			autoBlackBox: true
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return Promise.reject('error in attach thread actor: ' + result.error)
			}
		}).catch(e => {
			return Promise.reject(e);
		});
	}

    private _getSources(): Promise<void> {

		const request = {
			to: this._threadActor,
			type: 'sources'
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return Promise.reject('error in resources request: ' + result.error);
			}

            const sources = result.sources;
            this._remoteRoot = this._getRemoteRoot(sources);
			for (const source of sources) {
                // TODO: support eval source
				if (!source.url) {
					continue;
				}
				let url = this._getRemoteScriptPath(source.url);
				this._sourceActorMap[url] = source.actor;
			};
		}).catch(e => {
			return Promise.reject(e);
		});
	}

	private _resumeThreadActor(): Promise<void> {

		const request = {
			to: this._threadActor,
			type: 'resume',
			resumeLimit: null,
			ignoreCaughtExceptions: true
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return Promise.reject('error in resume thread actor: ' + result.error);
			}
		}).catch(e => {
			return Promise.reject(e);
		});
	}

	/**
	 * Get remote project root path.
	 * We use the 'main.js' the get the root path.
	 */
	private _getRemoteRoot(sources: any): string {

		let length = Number.MAX_VALUE;
		let findPath = '';
		for (let source of sources) {
			let url = source.url;
			if (!url) {
				continue;
			}
			if (url.endsWith('main.js') && url.length < length) {
				length = url.length;
				findPath = url;
			}
		}

        // can not find main.js, an error happened
		if (findPath.length === 0) {
			this.log('ar', 'can not find main.js');
			return '';
		}

        // remote '.main.js'
        return findPath.slice(0, -8);
	}

	//---------------- disconnect request -------------------------------------------------------------

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {

		super.disconnectRequest(response, args);
	}

	public shutdown(): void {

		if (!this._inShutDown) {
			this._inShutDown = true;

			// detach tab actor
			let request = {
				to: this._tabActor,
				type: 'detach'
			};
			this._cocos.command(request);

			// TODO: stop listers to web console if we support web console

			super.shutdown();
		}
	}

	//---------------- set breakpoints request ----------------------------------------------------------

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		this.log('bp', `setBreakPointsRequest: ${JSON.stringify(args.source)} ${JSON.stringify(args.breakpoints)}`);

		const path = args.source.path;

		// get source actor
		const actor = this._getActor(path);
		if (!actor) {
			this.sendErrorResponse(response, 2012, 'no valid source specified', null, ErrorDestination.Telemetry);
			return;
		}

		let lbs = args.breakpoints;
		if (!lbs) {
			// deprecated API: convert line number array
			lbs = new Array<DebugProtocol.SourceBreakpoint>();
			for (let l of args.lines) {
				lbs.push({
					line: l,
					column: 0
				});
			}
		}

		// compute breakpoints that already set
		let lbsAlreadSet = new Array<DebugProtocol.SourceBreakpoint>();
		let bps = this._breakpoints[path] || [];
		let tmpBps = new Array<BreakpointInfo>();
		for (let l of lbs) {
			for (let i = 0; i < bps.length; i++) {
				let b = bps[i];
				if (l.line === b.line && l.column === b.column) {
					l.line = b.actualLine;
					lbsAlreadSet.push(l);

                    tmpBps.push(b);
					bps.splice(i, 1);

					break;
				}
			}
		}
		this._breakpoints[path] = tmpBps;

        let needToResume = false;
		const needSetBreakpoint = lbs.length !== lbsAlreadSet.length;
        this._clearBreakpoints(bps).then(() => {

            // remote should be in paused to set breakpoint
			if (needSetBreakpoint && !this._remotePaused) {
				needToResume = true;
				return this._interruptThreadActor();
			}

		}).then( () => {

			return Promise.all(lbs.map(b => {
				let index = lbsAlreadSet.indexOf(b);
				if (index !== -1) {
					return new Breakpoint(true, lbsAlreadSet[index].line);
				}
				else {
					return this._setBreakpoint(actor, b, path);
				}
			}));

		}).then(result => {

			response.body = {
				breakpoints: result
			};
			this.sendResponse(response);
			this.log('bp', `_updateBreakpoints: result ${JSON.stringify(result)}`);

            if (needToResume) {
				this._resumeThreadActor();
			}

		}).catch(e => {
			this._sendCocosResponse(response, e);
		});
	}

	private _getActor(path: string): string {
		path = path.substring(this._localScriptStartIndex);
		return this._sourceActorMap[path];
	}

	private _interruptThreadActor(): Promise<string> {

		const request = {
			to: this._threadActor,
			type: 'interrupt',
			when: null
		};
		return this._cocos.command2(request).then(result => {

			if (result.error) {
				return Promise.reject('can not interrupe thread actor: ' + result.error);
			}
			else {
				return result.actor;
			}

		}).catch(e => {
			return Promise.reject(e);
		})
	}

	private _clearBreakpoints(breakpointsToDelete: Array<BreakpointInfo>): Promise<void> {

		let promises = [];
		for (let bp of breakpointsToDelete) {
			promises.push(this._clearBreakpoint(bp));
		}

		return Promise.all(promises).then(() => {
			return;
		}).catch((e) => {
			return;
		});
	}

	private _clearBreakpoint(breakpointActorInfo: BreakpointInfo): Promise<void> {

		const actor = breakpointActorInfo.actor;
		const request = {
			to: actor,
			type: 'delete'
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return Promise.reject(`can not delete breakpoint ${actor}: ${result.error} `)
			}
		}).catch(e => {
			return Promise.reject(e);
		});
	}

    private _setBreakpoint(actor: string, b: DebugProtocol.SourceBreakpoint, scriptPath: string): Promise<Breakpoint> {

		const request = {
			to: actor,
			type: 'setBreakpoint',
			location: {
				line: b.line,
				column: b.column
			}
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return new Breakpoint(false);
			}

			let actualLine = b.line;
            if (result.actualLocation) {
				actualLine = result.actualLocation.line;

				this.log('bp', `line:${b.line}  actualLine:${actualLine}`);
			}

			this._breakpoints[scriptPath].push(new BreakpointInfo(result.actor, b.line, b.column, actualLine));
			return new Breakpoint(true, actualLine);
		}).catch(e => {
			return new Breakpoint(false);
		});
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// return the default thread
		response.body = {
			threads: [
				new Thread(CocosDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	//----------- statcktrace request ------------------------------------------------------

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const threadReference = args.threadId;
		const maxLevels = args.levels;

		if (threadReference !== CocosDebugSession.THREAD_ID) {
			this.sendErrorResponse(response, 2014, 'unexpected thread reference {_thread}', { _thread: threadReference }, ErrorDestination.Telemetry);
			return;
		}

		const request = {
			to: this._threadActor,
			type: 'frames',
			start: 0,
			count: maxLevels
		};
		this._cocos.command2(request).then(backtraceResponse => {

			if (backtraceResponse.error) {
				return Promise.reject('can not get stacktraces: ' + backtraceResponse.error);
			}

			const responseFrames = backtraceResponse.frames;
			const frames = new Array<Promise<StackFrame>>();
			for (let frame of responseFrames) {
				// TODO: support eval frame, skip now
				if (! frame.where.source.url) {
					continue;
				}

				frames.push(this._createStackFrame(frame));
			}

			return Promise.all(frames);

		}).then(stackframes => {

			response.body = {
				stackFrames: stackframes
			};
			this.sendResponse(response);

		}).catch(error => {

			response.body = {
				stackFrames: []
			};
			this._sendCocosResponse(response, 'can not create stackframes: ' + error);

		});
	}

	private _createStackFrame(frame: any): Promise<StackFrame> {

		const line = frame.where.line;
		const column = frame.where.column;
		const frameRefrence = this._frameHandles.create(frame);

		let url = this._getValidUrl(frame.source);
		let localPath = this._getLocalPath(url);
		const source = new Source(Path.basename(localPath), localPath);

        if (frame.type === 'call') {
			return this._getFrameName(frame.callee.actor).then(functionName => {

				functionName = functionName || 'anonymous function';
				return new StackFrame(frameRefrence, functionName, source, line, column);
			});
		}
		else {
			return Promise.resolve(new StackFrame(frameRefrence, 'anonymous function', source, line, column));
		}
	}

	private _getFrameName(actor: string): Promise<string> {

		const request = {
			to: actor,
			type: 'name'
		};
		return this._cocos.command2(request).then(result => {
			if (result.error || !result.name) {
				return null;
			}

			return result.name;
		});
	}

	private _getLocalPath(remotePath: string): string {

		const remoteScriptPath = this._getRemoteScriptPath(remotePath);
		const pathCompoents = remoteScriptPath.split('/');

		if (pathCompoents[0] === 'script') {
			return Path.join(this._localEngineRoot, remoteScriptPath);
		}
		else {
			return Path.join(this._localRoot, remoteScriptPath);
		}
	}

    //------------------ scopes request -----------------------------------------------------

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        const frame = this._frameHandles.get(args.frameId);
		if (!frame) {
			this.sendErrorResponse(response, 2020, this._localize('VSND2020', 'stack is not valid'));
		    return;
		}

        // first scope is frame
		let scopes = new Array<Scope>();
		let expensive: boolean;
		let scopeName: string;

		// retrieve other scopes
		let scope = frame;
		while (scope) {

			// global scope
			if (scope.type === 'object' && scope.object.class === 'global'){
				scopeName = 'Global';
				expensive = true;
			}
			else {
				scopeName = this._getScopeName(scope);
			    expensive = false;
			}

			let s = new Scope(scopeName, this._variableHandles.create(new ScopeExpander(scope)), true);
			scopes.push(s);

            if (scope.environment) {
				// first scope
				scope = scope.environment.parent;
			}
			else {
				scope = scope.parent;
			}
		}

		response.body = {
			scopes: scopes
		}
		this.sendResponse(response);
	}

	private _getScopeName(scope: any): string {

        const firstScope = (scope.environment !== undefined);
		let scopeName: string;

        // handle frame type
        if (firstScope) {
			let frameType = scope.type;
			switch (frameType) {
				case 'global':
					scopeName = 'Global';
					break;
				case 'call':
				case 'eval':
				case 'clientEvaluate':
				    scopeName = 'Local';
                    break;
				default:
				    scopeName = `Unknown ${frameType}`;
					break;
			}
		}
		else {
			scopeName = scope.type;
		}

		return scopeName;
	}

	//-------------- variables request ------------------------------------------------------------------

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

        const reference = args.variablesReference;
		const expander = this._variableHandles.get(reference);
		if (expander) {
			let variables = new Array<Variable>();
			expander.expand(this, variables, () => {

				response.body = {
					variables: variables
				};

				this.sendResponse(response);
			});
		}
		else {
			response.body = {
				variables: []
			};
			this.sendResponse(response);
		}
	}

	public _addScopeVariables(scope: any, results: Array<Variable>, done: () => void): void {

		const firstScope = (scope.environment !== undefined);
		let type = scope.type;

		// first scope, should add 'this' property
		if (firstScope) {
			let expanderThis = new PropertyExpander(scope.this.actor, 'this');
			let varThis = new Variable('this', scope.this.class, this._variableHandles.create(expanderThis));
			results.push(varThis);

			type = scope.environment.type;
			scope = scope.environment;
		}

        switch (type) {
			// function and block should add variables from scope.bindings
			// scope.bindings.variables contains scope.bindings.arguments,
			// so only have to handle scope.bindings.variables
			case 'function':
			case 'block':
			    const variables = scope.bindings.variables;
				for (const key in variables) {
				    const value = variables[key];
					let variable = this._createVariableFromValue(key, value.value);
					results.push(variable);
				}
				done();
				break;

			case 'object':
			case 'with':
			    let expanderObj = new PropertyExpander(scope.object.actor, '');
				this._addPropertyVariables(expanderObj, results, () => {
					done();
				});

			    break;
			default:
			    done();
				break;
		}
	}

	private _createVariableFromValue(name:string, value: any): Variable {

		const type = value.type;
		let v: Variable;
		if (type) {
			if (value.class) {
				const expander = new PropertyExpander(<string>(value.actor), name);
			    v = new Variable(name, value.class, this._variableHandles.create(expander));
			}
			else {
				// null, undefined, NaN..., don't have class property
				v = new Variable(name, type);
			}
		}
		else {
			let dataType = typeof(value);
			switch (dataType) {
				case 'string':
				    if (value !== '') {
						value = value.replace('\n', '\\n').replace('\r', '\\r');
					}
					// need to wrap it with ""
					v = new Variable(name, ('"' + value + '"'));
				    break;
				case 'boolean':
				case 'number':
				    v = new Variable(name, ('' + value).toLocaleLowerCase());
				    break;
				default:
				    // an error happened
					this.log('vr', 'can not resolve type: ' + dataType);
					v = new Variable('' + value, 'unknown type');
				    break;
			}
		}

		return v;
	}

	public _addPropertyVariables(expander: PropertyExpander, results: Array<Variable>, done: () => void): void {

        // return cache value if exists
		const cacheValue = this._variableCache.get(expander.actor);
		if (cacheValue) {
			results = cacheValue;
			done();

			return;
		}

		const request = {
			to: expander.actor,
			type: 'prototypeAndProperties'
		};
		this._cocos.command2(request).then(response => {

			if (response.error) {
				this.log('vr' ,`error in get property of ${expander.name}: ${response.error}`);
				done();
				return;
			}

			// own properties
			let ownProperties = response.ownProperties;
			if (ownProperties) {
				for (let propName in ownProperties) {
					let variable = this._createVariableFromValue(propName, ownProperties[propName].value);
					results.push(variable);
				}
			}

			// // safeGetterValues
			const safeGetterValues = response.safeGetterValues;
			if (safeGetterValues) {
				for (let propName in safeGetterValues) {
					let variable = this._createVariableFromValue(propName, safeGetterValues[propName].getterValue);
					results.push(variable);
				}
			}

			done();

			// cache the result
			this._variableCache.set(expander.actor, results);
		}).catch(error => {
			// ignore the error
			this.log('vr' , `error in get property of ${expander.name}: ${error}`);
			done();
		});
	}

	// ---------------- pause request ----------------------------------------------------------------

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) : void {

		this._interruptThreadActor().then(()=> {
			this._stopped('pause');
			this._lastStoppedEvent = new StoppedEvent(this._localize('reason.user.request', 'user request'), CocosDebugSession.THREAD_ID);
			this.sendResponse(response);
			this.sendEvent(this._lastStoppedEvent);
		});
	}

	//-------------------- continue request -----------------------------------------------------

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

		const request = {
			to: this._threadActor,
			type: 'resume',
			resumeLimit: null,
			ignoreCaughtExceptions: true
		};
		this._cocos.command(request, (result) => {

            this.sendResponse(response);

		});

	}

    //-------------------- step request ----------------------------------------------------------

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

		const request = {
			to: this._threadActor,
			type: 'resume',
			resumeLimit: {
				type: 'next'
			},
			ignoreCaughtExceptions: true
		};
		this._cocos.command(request, (result) => {

            this.sendResponse(response);

		});
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) : void {

		const request = {
			to: this._threadActor,
			type: 'resume',
			resumeLimit: {
				type: 'step'
			},
			ignoreCaughtExceptions: true
		};
		this._cocos.command(request, (result) => {

            this.sendResponse(response);

		});
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) : void {

		const request = {
			to: this._threadActor,
			type: 'resume',
			resumeLimit: {
				type: 'finish'
			},
			ignoreCaughtExceptions: true
		};
		this._cocos.command(request, (result) => {

            this.sendResponse(response);

		});
	}

	//----------------- evaluate request -------------------------------------------------------------

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

	    const expression = args.expression;

		if (args.frameId <= 0) {
			this.sendErrorResponse(response, 2020, 'stack frame not valid', null, ErrorDestination.Telemetry);
			return;
		}

		const frame = this._frameHandles.get(args.frameId);
		if (!frame) {
			this.sendErrorResponse(response, 2020, 'stack frame not valid', null, ErrorDestination.Telemetry);
			return;
		}

		const request = {
			to: this._threadActor,
			type: 'clientEvaluate',
			frame: frame.actor,
			expression: this._createEvaluateExpression(expression)
		};

		// skip first reply
		this._cocos.dummyCommand();

		this._cocos.command2(request).then(evalResponse => {
			if (evalResponse.error) {
				response.success = false;
				response.message = evalResponse.error;
			}
			else {
				let frameFinished = evalResponse.why.frameFinished;
				if (frameFinished.throw || frameFinished.terminated) {
					response.success = false;
				    response.message = this._localize('eval.not.available', "not available");
				}
				else {
					let v = this._createVariableFromValue('evaluate', frameFinished.return);
					response.body = {
						result: v.value,
						variablesReference: v.variablesReference
					};
				}
			}

			this.sendResponse(response);
		});
	}

	private _createEvaluateExpression(expression: string): string {
		return `eval(\"try {${expression}\" + '\\n' + \"} catch (e) {e.name + ': ' + e.message;}\")`;
	}

	//--------- private functions ------------------------------------------------

	private _sendCocosResponse(response: DebugProtocol.Response, message: string) {
		this.sendErrorResponse(response, 2013, `cocos request failed (reason: ${message})`, ErrorDestination.Telemetry);
	}

    /**
	 * If some codes is generated dynamically, thre is not a url for it,
	 * but we can get its introductionUrl.
	 */
	private _getValidUrl(source: any): string {
		if (source.url) {
			return source.url;
		}
		else {
			return source.introductionUrl;
		}
	}

	private _createStoppedEvent(body: any): DebugProtocol.StoppedEvent {

		let reason: string;

		switch (body.why.type) {
			case UnsolicitedPauses.breakpoint:
				reason = this._localize('reason.breakpoint', 'breakpoint');
				break;
			case UnsolicitedPauses.resumeLimit:
				// step over, step into, step out
				reason = this._localize('reason.step', 'step');
				break;

			default:
				break;
		}

        if (reason) {
			return new StoppedEvent(reason, CocosDebugSession.THREAD_ID);
		}
		else {
			return null;
		}
	}

	/**
	 * extract script path that not include remote root
	 */
	private _getRemoteScriptPath(remoteFullPath: string): string {
		const remoteRootLength = this._remoteRoot.length;
		return remoteFullPath.substring(remoteRootLength+1);
	}

	private static _dirExists(path: string): boolean {
		try {
			let stat = Fs.statSync(path);
			return stat.isDirectory();
		}
        catch (error) {
			return false;
		}
	}
}

DebugSession.run(CocosDebugSession);
