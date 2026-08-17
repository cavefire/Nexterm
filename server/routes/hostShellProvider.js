const Session = require("../models/Session");
const Account = require("../models/Account");
const hostShellRegistry = require("../lib/HostShellRegistry");
const logger = require("../utils/logger");

module.exports = async (ws, req) => {
    const { sessionToken, deviceId, name, os } = req.query;
    if (!sessionToken) return ws.close(4001, "Missing sessionToken");
    if (!deviceId) return ws.close(4002, "Missing deviceId");

    const session = await Session.findOne({ where: { token: sessionToken } });
    if (!session) return ws.close(4003, "Invalid session");

    const user = await Account.findByPk(session.accountId);
    if (!user) return ws.close(4004, "Account not found");

    const deviceName = (name && name.trim()) || "My PC";

    try {
        await hostShellRegistry.register(user.id, deviceId, deviceName, os || "unknown", ws);
    } catch (err) {
        logger.error("Failed to register host shell device", { error: err.message });
        return ws.close(4005, "Failed to register device");
    }

    ws.on("message", (msg) => {
        try {
            const { type } = JSON.parse(msg);
            if (type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        } catch { /* ignore non-JSON */ }
    });

    const cleanup = () => hostShellRegistry.unregister(user.id, deviceId, ws).catch(() => {});
    ws.on("close", cleanup);
    ws.on("error", cleanup);
};
