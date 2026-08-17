const Session = require("../models/Session");
const Account = require("../models/Account");
const SessionManager = require("../lib/SessionManager");
const hostShellRegistry = require("../lib/HostShellRegistry");
const HostShellFsClient = require("../lib/HostShellFsClient");

module.exports = async (ws, req) => {
    const { sessionToken, sessionId } = req.query;
    if (!sessionToken) return ws.close(4001, "Missing sessionToken");
    if (!sessionId) return ws.close(4002, "Missing sessionId");

    const client = new HostShellFsClient(ws);
    const reject = (code, reason) => {
        ws.close(code, reason);
        client.close();
    };

    const session = await Session.findOne({ where: { token: sessionToken } });
    if (!session) return reject(4003, "Invalid session");

    const user = await Account.findByPk(session.accountId);
    if (!user) return reject(4004, "Account not found");

    const serverSession = SessionManager.get(sessionId);
    if (!serverSession || serverSession.accountId !== user.id) {
        return reject(4007, "Unknown session");
    }

    if (!hostShellRegistry.resolveData(`fs:${sessionId}`, client)) {
        return reject(4014, "No pending fs channel for this session");
    }
};
