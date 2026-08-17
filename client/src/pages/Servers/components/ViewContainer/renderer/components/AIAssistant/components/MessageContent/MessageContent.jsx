import { renderMarkdown } from "@/common/utils/markdown.jsx";
import "./styles.sass";

export const MessageContent = ({ text }) => (
    <div className="message-content">
        {renderMarkdown(text)}
    </div>
);
