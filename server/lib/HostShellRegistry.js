const Entry = require("../models/Entry");
const stateBroadcaster = require("./StateBroadcaster");
const logger = require("../utils/logger");

const DATA_CONNECTION_TIMEOUT = 15000;

class HostShellRegistry {
    constructor() {
        this._devices = new Map();   // accountId -> Map<deviceId, { ws, deviceId, name, os, entryId }>
        this._pendingData = new Map(); // sessionId -> { resolve, reject, timeout }
    }

    async register(accountId, deviceId, name, os, ws) {
        const entry = await this._upsertEntry(accountId, deviceId, name, os, "online");

        if (!this._devices.has(accountId)) this._devices.set(accountId, new Map());
        this._devices.get(accountId).set(deviceId, { ws, deviceId, name, os, entryId: entry.id });

        stateBroadcaster.broadcast("ENTRIES", { accountId });
        logger.info("Host shell device online", { accountId, deviceId, name });
        return entry;
    }

    async unregister(accountId, deviceId, ws) {
        const devices = this._devices.get(accountId);
        const device = devices?.get(deviceId);
        if (!device || device.ws !== ws) return; // superseded by a newer connection

        devices.delete(deviceId);
        if (devices.size === 0) this._devices.delete(accountId);

        await this._setEntryStatus(accountId, deviceId, "offline");
        stateBroadcaster.broadcast("ENTRIES", { accountId });
        logger.info("Host shell device offline", { accountId, deviceId });
    }

    getDevice(accountId, deviceId) {
        return this._devices.get(accountId)?.get(deviceId) || null;
    }

    requestShell(accountId, deviceId, sessionId, cwd = null) {
        const device = this.getDevice(accountId, deviceId);
        if (!device) return Promise.reject(new Error("Device is offline"));

        const dataPromise = this._waitForData(sessionId);
        device.ws.send(JSON.stringify({ type: "open", sessionId, ...(cwd ? { cwd } : {}) }));
        return dataPromise;
    }

    requestFs(accountId, deviceId, sessionId) {
        const device = this.getDevice(accountId, deviceId);
        if (!device) return Promise.reject(new Error("Device is offline"));

        const dataPromise = this._waitForData(`fs:${sessionId}`);
        device.ws.send(JSON.stringify({ type: "open-fs", sessionId }));
        return dataPromise;
    }

    _waitForData(sessionId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._pendingData.delete(sessionId);
                reject(new Error("Timed out waiting for the device to open the shell"));
            }, DATA_CONNECTION_TIMEOUT);
            this._pendingData.set(sessionId, { resolve, reject, timeout });
        });
    }

    resolveData(sessionId, socket) {
        const pending = this._pendingData.get(sessionId);
        if (!pending) return false;
        clearTimeout(pending.timeout);
        this._pendingData.delete(sessionId);
        pending.resolve(socket);
        return true;
    }

    async _upsertEntry(accountId, deviceId, name, os, status) {
        const entries = await Entry.findAll({ where: { accountId, type: "host-shell" } });
        const existing = entries.find(e => e.config?.deviceId === deviceId);

        if (existing) {
            await Entry.update({ name, status, config: { ...existing.config, os } }, { where: { id: existing.id } });
            return existing;
        }

        return Entry.create({
            accountId,
            type: "host-shell",
            renderer: "terminal",
            name,
            icon: "mdiLaptop",
            status,
            config: { deviceId, os },
        });
    }

    async _setEntryStatus(accountId, deviceId, status) {
        const entries = await Entry.findAll({ where: { accountId, type: "host-shell" } });
        const existing = entries.find(e => e.config?.deviceId === deviceId);
        if (existing) await Entry.update({ status }, { where: { id: existing.id } });
    }

    async markAllOffline() {
        await Entry.update({ status: "offline" }, { where: { type: "host-shell" } });
    }
}

module.exports = new HostShellRegistry();
