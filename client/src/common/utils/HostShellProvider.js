import { isTauri, getActiveServerUrl } from "@/common/utils/TauriUtil.js";

const ENABLED_KEY = "nexterm_expose_shell";
const DEVICE_ID_KEY = "nexterm_device_id";
const DEVICE_NAME_KEY = "nexterm_device_name";

const invoke = async (cmd, args) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
};

export const isHostShellSupported = () => isTauri();

export const isHostShellEnabled = () => localStorage.getItem(ENABLED_KEY) === "true";

export const getDeviceName = () => localStorage.getItem(DEVICE_NAME_KEY) || "";

export const setDeviceName = (name) => localStorage.setItem(DEVICE_NAME_KEY, name || "");

const getDeviceId = () => {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = (crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
};

export const applyHostShell = async (token, enabled) => {
    if (!isTauri()) return;
    localStorage.setItem(ENABLED_KEY, enabled ? "true" : "false");

    await invoke("set_host_shell", {
        enabled,
        serverUrl: getActiveServerUrl() || window.location.origin,
        token: token || "",
        deviceId: getDeviceId(),
        deviceName: getDeviceName(),
    });
};

export const syncHostShell = async (token) => {
    if (!isTauri() || !token) return;
    if (isHostShellEnabled()) {
        try { await applyHostShell(token, true); } catch (err) { console.error("Failed to expose shell:", err); }
    }
};
