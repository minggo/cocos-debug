import * as EE from 'events';

export class CocosFXEvent {
	event: string;
	body: any;

	public constructor(event: string, body?: any) {
		this.event = event;
		if (body) {
			this.body = body;
		}
	}
}

/**
 * Set of protocol messages that affect thread state, and the
 * state the actor is in after each message.
 */
export const ThreadStateTypes = {
  'paused': 'paused',
  'resumed': 'attached',
  'detached': 'detached'
};

/**
 * Set of protocol messages that are sent by the server without a prior request
 * by the client.
 */
export const UnsolicitedNotifications = {
  'consoleAPICall': 'consoleAPICall',
  'eventNotification': 'eventNotification',
  'fileActivity': 'fileActivity',
  'lastPrivateContextExited': 'lastPrivateContextExited',
  'logMessage': 'logMessage',
  'networkEvent': 'networkEvent',
  'networkEventUpdate': 'networkEventUpdate',
  'newGlobal': 'newGlobal',
  'newScript': 'newScript',
  'tabDetached': 'tabDetached',
  'tabListChanged': 'tabListChanged',
  'reflowActivity': 'reflowActivity',
  'addonListChanged': 'addonListChanged',
  'tabNavigated': 'tabNavigated',
  'frameUpdate': 'frameUpdate',
  'pageError': 'pageError',
  'documentLoad': 'documentLoad',
  'enteredFrame': 'enteredFrame',
  'exitedFrame': 'exitedFrame',
  'appOpen': 'appOpen',
  'appClose': 'appClose',
  'appInstall': 'appInstall',
  'appUninstall': 'appUninstall',
  'evaluationResult': 'evaluationResult'
};

/**
 * Set of pause types that are sent by the server and not as an immediate
 * response to a client request.
 */
export const UnsolicitedPauses = {
  'resumeLimit': 'resumeLimit',
  'debuggerStatement': 'debuggerStatement',
  'breakpoint': 'breakpoint',
  'DOMEvent': 'DOMEvent',
  'watchpoint': 'watchpoint',
  'exception': 'exception'
};

export class CocosFXProtocol extends EE.EventEmitter {

    private _writableStream: NodeJS.WritableStream;
	// first call back is null for response of root
	private _pendingRequests = [null];
	private _rawData = '';

	private _bodyStartIndex: number = 0;
	private _bodyLength: number = 0;

	public startDispatch(inStream: NodeJS.ReadWriteStream, outStream: NodeJS.WritableStream): void {
		this._writableStream = outStream;
		inStream.on('data', (data) => this.execute(data));
		inStream.on('close', () => {
			this.emitEvent(new CocosFXEvent('close'));
		});
		inStream.on('error', (error) => {
			this.emitEvent(new CocosFXEvent('error', 'input stream error'));
		});

		outStream.on('error', (error) => {
			this.emitEvent(new CocosFXEvent('error', 'error happend in send request'));
		});

		inStream.resume();
	}

	public command(request: any, cb?: (result) => void) : void {
		this._command(request, cb);
	}

	public command2(request: any) : Promise<any> {
		return new Promise((resolve, reject) => {
			this._command(request, result => {
				resolve(result);
			});
		});
	}

    /**
	 * This command doesn't send any request, it just to skip one packet received.
	 */
	public dummyCommand() {
		this._pendingRequests.push(null);
	}

	private _command(request: any, cb: (result) => void) : void {

        if (cb) {
		    this._pendingRequests.push(cb);
		}
		else {
			this._pendingRequests.push(null);
		}

		this.send(request);
	}

    private emitEvent(event: CocosFXEvent) {
		this.emit(event.event, event);
	}

	private send(request: any) {
		let content = JSON.stringify(request);
		let length = content.length;
		let packet = length.toString() + ':' + content;
		if (this._writableStream) {
			this._writableStream.write(packet);
		}
	}

	private execute(data): void {
		this._rawData += data.toString();
		let packet;
        while(packet = this.extractPacket()) {

			try {

				let body = JSON.parse(packet);

                let cb;
				if (!(body.type in UnsolicitedNotifications) &&
				    !(body.type === ThreadStateTypes.paused &&
					  body.why.type in UnsolicitedPauses)) {

					cb = this._pendingRequests.shift();
				}

				if (body.type in ThreadStateTypes) {
					this.emitEvent(new CocosFXEvent('threadState', body));
				}

				if (cb) {
					cb(body);
				}

			} catch (e) {
				// Can not parse the message from remote.
				this.emitEvent(new CocosFXEvent('error', 'received error packet: invalid content: ' + packet));
			}
		}
	}

	private extractPacket() {

        if (this._rawData === '') {
			return;
		}

		if (this._bodyStartIndex === 0) {
			let sep = this._rawData.indexOf(':');
			if (sep < 0) {
				// not enough data received
				return;
			}

			this._bodyStartIndex = sep + 1;
		}

        if (this._bodyLength === 0) {
			let countString = this._rawData.substring(0, this._bodyStartIndex - 1);
			if (!/^[0-9]+$/.test(countString)) {
				this.emitEvent(new CocosFXEvent('error', 'received error packet: invalid length ' + countString));
				return;
			}

			this._bodyLength = parseInt(countString);
		}

		// The body length is byte length
		const resRawByteLength = Buffer.byteLength(this._rawData, 'utf8');

		if (resRawByteLength - this._bodyStartIndex  >= this._bodyLength) {
			const buf = new Buffer(resRawByteLength);
			buf.write(this._rawData);

			let packet = buf.slice(this._bodyStartIndex, this._bodyStartIndex + this._bodyLength).toString('utf8');
			this._rawData = buf.slice(this._bodyStartIndex + this._bodyLength).toString();

			console.log('_bodyStartIndex: ' + this._bodyStartIndex);
			console.log('_bodyLength: ' + this._bodyLength);
			console.log('resRawByteLength: ' + resRawByteLength);

			this._bodyStartIndex = 0;
			this._bodyLength = 0;

			return packet;
		}
	}
}