"use strict";

import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, ErrorDestination} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as net from 'net';
import * as nls from 'vscode-nls';

import {CocosFXProtocol, CocosFXEvent} from './cocosFirefoxProtocol';

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

enum ProjectType {
	// The project is a cocos tests
	TESTS,
	JSB
}

class CocosDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private static ATTACH_TIMEOUT = 10000;

	private _trace: boolean = true;
    private _cocos: CocosFXProtocol;
	private _isTerminated: boolean = false;
	private _localize: nls.LocalizeFunc = nls.loadMessageBundle();
	private _sourceActorMap = {};
	private _breakpointSourceActorMap = new Map<string, string>();
	private _threadActor: string;
	private _localScriptRoot: string;
	private _prefixIndex: number;
	private _projectType: ProjectType = ProjectType.TESTS;

	/**
	 * Creates a new debug adapter.
	 * We configure the default implementation of a debug adapter here
	 * by specifying that this 'debugger' uses zero-based lines and columns.
	 */
	public constructor() {
		super();

		// this debugger uses zero-based lines and columns which is the default
		// so the following two calls are not really necessary.
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._cocos = new CocosFXProtocol();

		this._cocos.on('error', (event: CocosFXEvent) => {
			this._termiated('cocos firefox protocol error: ' + event.reason)
		});

		this._cocos.on('close', (event: CocosFXEvent) => {
			this._termiated('cocos firefox protocol close');
		});

		this._cocos.on('diagnostic', (event: CocosFXEvent) => {
			console.error(event.reason);
		})

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
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

		let address = args.address ? args.address : '127.0.0.1';
		let timeout = args.timeout ? args.timeout : CocosDebugSession.ATTACH_TIMEOUT;

		this.log('ar', `attachRequest: address: ${address} port: ${args.port}`);

		let connected = false;
        const socket: net.Socket = new net.Socket();
		socket.connect(args.port, address);

		socket.on('connect', (err: any) => {
			this.log('ar', 'attachRequest: connected');
			connected = true;
			this._localScriptRoot = args.cwd;
			this._prefixIndex = this._localScriptRoot.length + 1;
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
						this.sendErrorResponse(response, 2009, this._localize('VSND2009', "cannot connect to remote (timeout after {_timeout}ms)"), { _timeout: timeout });
					}
				}
				else {
					this.sendErrorResponse(response, 2010, this._localize('VSND2010', "cannot connect to remote (reason: {_error})"), { _error: err.message });
				}
			}
		});

		socket.on('end', (err: any) => {
			this._termiated('socket end');
		});
	}

    /**
	 * Should get resources from remote and record the corredponding actors.
	 */
	private _initialize(respond: DebugProtocol.Response): void {

		this._listTabs().then(tabActor => {
			// listTabs request
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
		let request = {
			to: 'root',
			"type": 'listTabs'
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return Promise.reject('error in listTabs: ' + result.error);
			}

			let selected = result.selected;
			let selectedTab = result.tabs[selected];
			return selectedTab.actor;
		}).catch(e => {
			return Promise.reject(e);
		});
	}

	private _attachTab(tabActor: string): Promise<void> {
		let request = {
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
		let request = {
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

            let sources = result.sources;
            let prefix = this._getRoot(sources);
			let prefixLength = prefix.length;
			for (let source of sources) {
				let url = source.url.substring(prefixLength + 1);
				this._sourceActorMap[url] = source.actor;
			};
		}).catch(e => {
			return Promise.reject(e);
		});
	}

	private _resumeThreadActor(): Promise<void> {
		let request = {
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
	private _getRoot(sources: any): string {
		let length = Number.MAX_VALUE;
		let findPath = '';
		for (let source of sources) {
			let url = source.url;
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

	//----------------set breakpoints request ----------------------------------------------------------

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		this.log('bp', `setBreakPointsRequest: ${JSON.stringify(args.source)} ${JSON.stringify(args.breakpoints)}`);

		let path = args.source.path;

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

        // get source actor
		let scriptPath = args.source.path;
		let actor = this._getActor(scriptPath);
		if (!actor) {
			this.sendErrorResponse(response, 2012, 'no valid source specified', null, ErrorDestination.Telemetry);
			return;
		}

        this._clearBreakpoints().then(() => {
			return this._interruptThreadActor();
		}).then(breakpointActor => {
			return Promise.all(lbs.map(b => this._setBreakpoint(actor, b, scriptPath, breakpointActor)));
		}).then(result => {
			response.body = {
				breakpoints: result
			};
			this.sendResponse(response);
			this.log('bp', `_updateBreakpoints: result ${JSON.stringify(result)}`);

			this._resumeThreadActor();
		}).catch(e => {
			this._sendCocosResponse(response, e);
		});
	}

	private _getActor(path: string): string {
		path = path.substring(this._prefixIndex);
		return this._sourceActorMap[path];
	}

	private _interruptThreadActor(): Promise<string> {
		let request = {
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

	private _clearBreakpoints(): Promise<void> {
		let promises = [];
		this._breakpointSourceActorMap.forEach( (actor, _) => {
			promises.push(this._clearBreakpoint(actor));
		});
		this._breakpointSourceActorMap.clear();

		return Promise.all(promises).then(() => {
			return;
		}).catch((e) => {
			return;
		});
	}

	private _clearBreakpoint(actor: string): Promise<void> {
		let request = {
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

    private _setBreakpoint(actor: string, b: DebugProtocol.SourceBreakpoint, scriptPath: string, breakpointActor: string): Promise<Breakpoint> {
		let request = {
			to: actor,
			type: 'setBreakpoint',
			location: {
				line: b.line
			}
		};
		return this._cocos.command2(request).then(result => {
			if (result.error) {
				return new Breakpoint(false);
			}

			let actualLine = b.line;
            if (result.actualLocation) {
				actualLine = result.actualLocation.line;
			}
			let breakpointId = scriptPath + b.line;
			this._breakpointSourceActorMap.set(breakpointId, result.actor);
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

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {


	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {


	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {


	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {


	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {


	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

	}

	private _sendCocosResponse(response: DebugProtocol.Response, message: string) {
		this.sendErrorResponse(response, 2013, `cocos request failed (reason: ${message})`, ErrorDestination.Telemetry);
	}
}

DebugSession.run(CocosDebugSession);
