import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";

loader.config({ monaco });

const BASE_OPTIONS = {
    minimap: { enabled: false },
    fontSize: 14,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    automaticLayout: true,
    wordWrap: "off",
    tabSize: 4,
    insertSpaces: true,
};

export const CodeEditor = ({ options, ...props }) => {
    const { theme } = usePreferences();

    return (
        <Editor
            theme={theme === "dark" || theme === "oled" ? "vs-dark" : "vs-light"}
            options={{ ...BASE_OPTIONS, ...options }}
            {...props}
        />
    );
};

export default CodeEditor;
