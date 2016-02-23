import * as EE from 'events';

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
		this._rawData += data;
		let packet;
        while(packet = this.extractPacket()) {
			if (!packet) {
				break;
			}

			try {
				let body = JSON.parse(packet);

                let cb = this._pendingRequests.shift();
				if (cb) {
					cb(body);
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
			// not enough data received
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