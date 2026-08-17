const { Duplex } = require("node:stream");

class HostShellSocket extends Duplex {
    constructor(ws) {
        super();
        this.ws = ws;

        ws.on("message", (data, isBinary) => {
            if (isBinary === false || typeof data === "string") return;
            this.push(data);
        });
        ws.on("close", () => { this.push(null); this.destroy(); });
        ws.on("error", () => { this.push(null); this.destroy(); });
    }

    _read() {}

    _write(chunk, _enc, cb) {
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(chunk);
        cb();
    }

    resize(cols, rows) {
        if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
    }

    _destroy(err, cb) {
        try { this.ws.close(); } catch { /* already closing */ }
        cb(err);
    }
}

module.exports = HostShellSocket;
