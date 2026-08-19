import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import "./styles.sass";

export const ShareLinkDialog = ({ open, link, onClose }) => {
    const { t } = useTranslation();

    return (
        <DialogProvider open={open} onClose={onClose}>
            <div className="share-link-dialog">
                <h2>{t("servers.tabs.shareLinkDialog.title")}</h2>
                <p>{t("servers.tabs.shareLinkDialog.description")}</p>
                <input type="text" readOnly value={link || ""} autoFocus
                       onFocus={(e) => e.target.select()} onClick={(e) => e.target.select()} />
                <div className="btn-area">
                    <Button text={t("common.actions.close")} onClick={onClose} />
                </div>
            </div>
        </DialogProvider>
    );
};
