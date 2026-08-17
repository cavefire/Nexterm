import { mdiFormTextbox, mdiIp, mdiEthernet } from "@mdi/js";
import Input from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import IconChooser from "../components/IconChooser";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { getRequest } from "@/common/utils/RequestUtil.js";

const PROTOCOL_OPTIONS = [
    { label: "SSH", value: "ssh" },
    { label: "Telnet", value: "telnet" },
    { label: "Serial", value: "serial" },
    { label: "RDP", value: "rdp" },
    { label: "VNC", value: "vnc" },
    { label: "SFTP", value: "sftp" },
    { label: "FTP", value: "ftp" },
    { label: "FTPS", value: "ftps" }
];

const BAUD_RATE_OPTIONS = ["9600", "19200", "38400", "57600", "115200", "230400"]
    .map(rate => ({ label: rate, value: rate }));

const DetailsPage = ({name, setName, icon, setIcon, config, setConfig, fieldConfig}) => {
    const { t } = useTranslation();
    const [engines, setEngines] = useState([]);

    useEffect(() => {
        getRequest("engines").then(data => setEngines(data || [])).catch(() => {});
    }, []);

    const engineOptions = engines.map(e => ({
        label: `${e.name}${e.connected ? "" : " " + t("servers.dialog.engineOffline")}`,
        value: String(e.id),
    }));

    const serial = fieldConfig.showSerialSettings;
    const showEngineSelect = engines.length > 1 || (serial && engines.length > 0);

    const selectedEngine = useMemo(() => serial
        ? (config.engineId
            ? engines.find(e => String(e.id) === String(config.engineId))
            : engines[0])
        : null, [serial, engines, config.engineId]);

    const serialPortOptions = useMemo(() => {
        if (!serial) return [];
        const ports = [...new Set([config.device, ...(selectedEngine?.serialPorts || [])].filter(Boolean))];
        return ports.map(port => ({ label: port, value: port }));
    }, [serial, selectedEngine, config.device]);

    const firstSerialPort = serialPortOptions[0]?.value;
    useEffect(() => {
        if (!serial || engines.length === 0) return;
        setConfig(prev => {
            const engineId = prev.engineId || String(engines[0].id);
            const device = prev.device || firstSerialPort;
            if (engineId === prev.engineId && device === prev.device) return prev;
            return { ...prev, engineId, ...(device ? { device } : {}) };
        });
    }, [serial, engines, firstSerialPort, setConfig]);
    
    return (
        <>
            <div className="name-row">
                <div className="form-group">
                    <label htmlFor="name">{t("servers.dialog.fields.name")}</label>
                    <Input icon={mdiFormTextbox} type="text" placeholder={t("servers.dialog.placeholders.serverName")} 
                           id="name" autoComplete="off" value={name} setValue={setName} />
                </div>
                <div className="form-group">
                    <label>{t("servers.dialog.fields.icon")}</label>
                    <IconChooser selected={icon} setSelected={setIcon} />
                </div>
            </div>

            {showEngineSelect && (
                <div className="form-group">
                    <label>{t("servers.dialog.fields.engine")}</label>
                    <SelectBox
                        options={engineOptions}
                        selected={config.engineId ? String(config.engineId) : engineOptions[0]?.value}
                        setSelected={(value) => setConfig(prev => ({ ...prev, engineId: value }))}
                    />
                </div>
            )}
            
            {serial && (
                <>
                    <div className="form-group">
                        <label>{t("servers.dialog.fields.serialDevice")}</label>
                        {serialPortOptions.length > 0 ? (
                            <SelectBox
                                options={serialPortOptions}
                                selected={config.device}
                                setSelected={(value) => setConfig(prev => ({ ...prev, device: value }))}
                            />
                        ) : (
                            <p className="serial-ports-hint">
                                {selectedEngine?.connected
                                    ? t("servers.dialog.noSerialPorts")
                                    : t("servers.dialog.serialEngineOffline")}
                            </p>
                        )}
                    </div>
                    <div className="form-group">
                        <label>{t("servers.dialog.fields.baudRate")}</label>
                        <SelectBox
                            options={BAUD_RATE_OPTIONS}
                            selected={config.baudRate ? String(config.baudRate) : "115200"}
                            setSelected={(value) => setConfig(prev => ({ ...prev, baudRate: value }))}
                        />
                    </div>
                </>
            )}

            {fieldConfig.showIpPort && (
                <>
                    <div className="address-row">
                        <div className="form-group">
                            <label htmlFor="ip">{t("servers.dialog.fields.serverIp")}</label>
                            <Input icon={mdiIp} type="text" placeholder={t("servers.dialog.placeholders.serverIp")} 
                                   id="ip" autoComplete="off" value={config.ip || ""} 
                                   setValue={(value) => setConfig(prev => ({ ...prev, ip: value }))} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="port">{t("servers.dialog.fields.port")}</label>
                            <input type="text" placeholder={t("servers.dialog.placeholders.port")} 
                                   value={config.port || ""} className="small-input" id="port"
                                   onChange={(e) => setConfig(prev => ({ ...prev, port: e.target.value }))} />
                        </div>
                    </div>
                    {fieldConfig.showProtocol && (
                        <div className="form-group">
                            <label>{t("servers.dialog.fields.protocol")}</label>
                            <SelectBox options={PROTOCOL_OPTIONS} selected={config.protocol} 
                                       setSelected={(value) => setConfig(prev => ({ ...prev, protocol: value }))} />
                        </div>
                    )}
                    {config.wakeOnLanEnabled && (
                        <>
                            <div className="form-group">
                                <label htmlFor="macAddress">{t("servers.dialog.fields.macAddress")}</label>
                                <Input icon={mdiEthernet} type="text" placeholder={t("servers.dialog.placeholders.macAddress")}
                                       id="macAddress" autoComplete="off" value={config.macAddress || ""}
                                       setValue={(value) => setConfig(prev => ({ ...prev, macAddress: value }))} />
                            </div>
                            <div className="form-group">
                                <label htmlFor="wolBroadcastAddress">{t("servers.dialog.fields.wolBroadcastAddress")}</label>
                                <Input icon={mdiIp} type="text" placeholder={t("servers.dialog.placeholders.wolBroadcastAddress")}
                                       id="wolBroadcastAddress" autoComplete="off" value={config.wolBroadcastAddress || ""}
                                       setValue={(value) => setConfig(prev => ({ ...prev, wolBroadcastAddress: value }))} />
                            </div>
                        </>
                    )}
                </>
            )}
        </>
    );
}

export default DetailsPage;