import * as EE from 'events';


export class CocosFXResponse {
	success: boolean;
	message: string;
	body: any;

	constructor(message?: string) {
		if (message) {
			this.success = false;
			this.message = message;
		}
		else {
			this.success = true;
		}
	}
}

export class CocosFXEvent {
	event: string;
	reason: string;

	public constructor(event: string, reason?: string) {
		this.event = event;
		if (reason) {
			this.reason = reason;
		}
	}
}

export class CocosFXProtocol extends EE.EventEmitter {
	private static TIMEOUT = 3000;

    private _writableStream: NodeJS.WritableStream;
	// first call back is null for response of root
	private _pendingRequests = [null];
	private _rawData = '';

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

	public command(request: any, cb?: (response: CocosFXResponse) => void) : void {
		this._command(request, CocosFXProtocol.TIMEOUT, cb);
	}

	public command2(request: any, timeout: number = CocosFXProtocol.TIMEOUT) : Promise<CocosFXResponse> {
		return new Promise((completeDispatch, errorDispatch) => {
			this._command(request, timeout, (result: CocosFXResponse) => {
				if (result.success) {
					completeDispatch(result);
				}
				else {
					errorDispatch(result);
				}
			});
		});
	}

	private _command(request: any, timeout: number, cb: (response: CocosFXResponse) => void) : void {

		// if (this._unresponsiveMode) {
		// 	if (cb) {
		// 		cb(new CocosFXResponse('cancelled because remote is unresponsive'));
		// 	}
		// 	return;
		// }

        if (cb) {
			// this._pendingRequests[request.to] = cb;
		    this._pendingRequests.push(cb);
		}
		else {
			this._pendingRequests.push(null);
		}

		this.send(request);

		// if (cb) {
		// 	let sequence = this._sendSequence++;
		// 	this._pendingRequests[sequence] = cb;
		// 	setTimeout(() => {
		// 		const clb = this._pendingRequests[sequence];
		// 		if (clb) {
		// 			delete this._pendingRequests[sequence];
		// 			clb(new CocosFXResponse('timeout after ' + timeout + 'ms'));

		// 			this._unresponsiveMode = true;
		// 			this.emitEvent(new CocosFXEvent('diagnostic', 'unresponsive of ' + JSON.stringify(request)));
		// 		}
		// 	}, timeout);
		// }
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
		this._rawData += data;
		let packet;
        while(packet = this.extractPacket()) {
			try {
				let body = JSON.parse(packet);

				let cb = this._pendingRequests.shift();
				if (cb) {
					let respond = new CocosFXResponse();
					respond.body = body;
					cb(respond);
				}
			} catch (e) {
				// Can not parse the message from remote.
				this.emitEvent(new CocosFXEvent('error', 'received error packet: invalid content: ' + data));
			}
		}
	}

	private extractPacket() {
		let sep = this._rawData.indexOf(':');
		if (sep < 0) {
			return;
		}

        let countString = this._rawData.substring(0, sep);
		if (!/^[0-9]+$/.exec(countString)) {
			this.emitEvent(new CocosFXEvent('error', 'received error packet: invalid length'));
			return;
        }

        let count = parseInt(countString);
		// should include ':'
		let packet = this._rawData.slice(sep + 1, count + sep + 1);
		if (packet.length < count){
			// no enough data received
			return;
		}
		let newPacketStart = sep + 1 + count;
		this._rawData = this._rawData.slice(newPacketStart);

        return packet;
	}
}