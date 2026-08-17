const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const REQUEST_TIMEOUT = 30000;
const READY_TIMEOUT = 10000;
const WRITE_END_TIMEOUT = 120000;
const WRITE_CHUNK_SIZE = 262144;
const MAX_BUFFERED = WRITE_CHUNK_SIZE * 4;

class HostShellFsClient extends EventEmitter {
    constructor(ws) {
        super();
        this._ws = ws;
        this._requestId = 0;
        this._pending = new Map();
        this._reads = new Map();
        this._closed = false;

        this._readyPromise = new Promise((resolve, reject) => {
            this._readyResolve = resolve;
            this._readyReject = reject;
        });
        this._readyPromise.catch(() => {});

        ws.on("message", (data, isBinary) => {
            if (isBinary === false || typeof data === "string") this._handleText(data.toString());
            else this._handleChunk(data);
        });
        ws.on("close", () => this._abort(new Error("Connection closed"), true));
        ws.on("error", (err) => this._abort(err, true));
    }

    waitForReady() {
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timed out waiting for the device")), READY_TIMEOUT).unref?.());
        return Promise.race([this._readyPromise, timeout]);
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        try { this._ws.close(); } catch { /* already closing */ }
        this._rejectAll(new Error("Connection closed"));
    }

    listDir(path) { return this._request("list", { path }); }
    stat(path) { return this._request("stat", { path }); }
    mkdir(path) { return this._request("mkdir", { path }); }
    unlink(path) { return this._request("unlink", { path }); }
    realpath(path) { return this._request("realpath", { path }); }
    rmdir(path, recursive = false) { return this._request("rmdir", { path, recursive }); }
    rename(oldPath, newPath) { return this._request("rename", { path: oldPath, newPath }); }
    chmod(path, mode) { return this._request("chmod", { path, mode }); }
    searchDirs(searchPath, maxResults = 20) { return this._request("searchDirs", { searchPath, maxResults }); }

    async mkdirRecursive(path) {
        if ((await this.stat(path).catch(() => null))?.isDir) return [];

        const segments = path.split("/").filter(Boolean);
        const created = [];
        let current = path.startsWith("/") ? "" : ".";

        for (const segment of segments) {
            current = `${current}/${segment}`;
            if ((await this.stat(current).catch(() => null))?.isDir) continue;
            try {
                await this.mkdir(current);
                created.push(current);
            } catch (err) {
                if (!(await this.stat(current).catch(() => null))?.isDir) throw err;
            }
        }

        return created;
    }

    readFile(path) {
        const id = ++this._requestId;
        const stream = new PassThrough();
        stream.on("error", () => {});

        let sizeResolved = false;
        let resolveTotalSize;
        const totalSizePromise = new Promise((r) => { resolveTotalSize = r; });

        let resolveDone, rejectDone;
        const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

        const emitSize = (size) => {
            if (sizeResolved) return;
            sizeResolved = true;
            resolveTotalSize(size);
        };

        this._reads.set(id, {
            stream,
            emitSize,
            finish: () => {
                emitSize(0);
                stream.end();
                this._reads.delete(id);
                resolveDone();
            },
            fail: (msg) => {
                emitSize(0);
                if (!stream.destroyed) stream.destroy(new Error(msg));
                this._reads.delete(id);
                rejectDone(new Error(msg));
            },
        });

        this._send({ id, op: "read", path });
        done.catch(() => {});
        return { stream, totalSizePromise, done };
    }

    async writeFile(path, source) {
        const id = ++this._requestId;
        await this._requestWithId(id, "write-open", { path });

        const sendChunk = (chunk) => {
            const frame = Buffer.allocUnsafe(4 + chunk.length);
            frame.writeUInt32BE(id, 0);
            chunk.copy(frame, 4);
            if (this._ws.readyState === this._ws.OPEN) this._ws.send(frame);
        };

        if (Buffer.isBuffer(source)) {
            for (let off = 0; off < source.length; off += WRITE_CHUNK_SIZE) {
                sendChunk(source.subarray(off, Math.min(off + WRITE_CHUNK_SIZE, source.length)));
            }
        } else {
            await new Promise((resolve, reject) => {
                source.on("data", (chunk) => {
                    sendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    if (this._ws.bufferedAmount > MAX_BUFFERED) {
                        source.pause();
                        this._waitDrain().then(() => source.resume());
                    }
                });
                source.on("end", resolve);
                source.on("error", reject);
            });
        }

        return this._requestWithId(id, "write-close", {}, WRITE_END_TIMEOUT);
    }

    exec() { return Promise.reject(new Error("Shell operations are not supported on this device")); }
    thumbnail() { return Promise.reject(new Error("Thumbnails are not supported on this device")); }

    _waitDrain() {
        return new Promise((resolve) => {
            const check = () => {
                if (this._closed || this._ws.bufferedAmount <= MAX_BUFFERED) return resolve();
                setTimeout(check, 50);
            };
            check();
        });
    }

    _request(op, params, timeoutMs) {
        return this._requestWithId(++this._requestId, op, params, timeoutMs);
    }

    _requestWithId(id, op, params, timeoutMs = REQUEST_TIMEOUT) {
        return new Promise((resolve, reject) => {
            if (this._closed) return reject(new Error("Connection closed"));
            const timeout = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error("Request timeout"));
            }, timeoutMs);
            this._pending.set(id, {
                resolve: (v) => { clearTimeout(timeout); resolve(v); },
                reject: (e) => { clearTimeout(timeout); reject(e); },
            });
            this._send({ id, op, ...params });
        });
    }

    _send(obj) {
        if (this._ws.readyState === this._ws.OPEN) this._ws.send(JSON.stringify(obj));
    }

    _handleText(text) {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }

        if (msg.ready) {
            this._readyResolve?.();
            this._readyResolve = null;
            return;
        }

        const read = this._reads.get(msg.id);
        if (read) {
            if (msg.done) read.finish();
            else if (msg.ok) read.emitSize(Number(msg.data?.size) || 0);
            else read.fail(msg.error || "Operation failed");
            return;
        }

        const pending = this._pending.get(msg.id);
        if (!pending) return;
        this._pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || "Operation failed"));
    }

    _handleChunk(buf) {
        if (buf.length < 4) return;
        const read = this._reads.get(buf.readUInt32BE(0));
        read?.stream.write(buf.subarray(4));
    }

    _rejectAll(error) {
        for (const [, p] of this._pending) p.reject(error);
        this._pending.clear();
        for (const [, r] of this._reads) r.fail(error.message);
        this._reads.clear();
    }

    _abort(error, emitClose = false) {
        this._closed = true;
        if (this._readyReject) {
            this._readyReject(error);
            this._readyReject = null;
        }
        this._rejectAll(error);
        if (emitClose) this.emit("close");
    }
}

module.exports = HostShellFsClient;
