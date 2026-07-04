import { useState, useCallback, useEffect } from "react";
import styles from "../Settings.module.css";

export function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      const blocked = ["Tab", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", " "];
      if (blocked.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      if (e.metaKey) parts.push("meta");
      const rawKey = e.key;
      if (["control", "shift", "alt", "meta"].includes(rawKey.toLowerCase())) return;
      const keyMap: Record<string, string> = {
        " ": "space", "Spacebar": "space",
        "Tab": "tab",
        "Escape": "esc", "Esc": "esc",
        "Enter": "return", "Return": "return",
        "Backspace": "backspace",
        "Delete": "delete",
        "Home": "home", "End": "end",
        "PageUp": "pageup", "PageDown": "pagedown",
        "ArrowUp": "up", "ArrowDown": "down",
        "ArrowLeft": "left", "ArrowRight": "right",
        "Insert": "insert",
        "CapsLock": "capslock",
        "PrintScreen": "printscreen",
        "ScrollLock": "scrolllock",
        "Pause": "pause",
        "ContextMenu": "contextmenu",
        "NumLock": "numlock",
      };
      let mappedKey: string;
      if (/^F\d{1,2}$/i.test(rawKey)) {
        mappedKey = rawKey.toLowerCase();
      } else {
        mappedKey = keyMap[rawKey] || rawKey.toLowerCase();
      }
      parts.push(mappedKey);
      onChange(parts.join("+"));
      setRecording(false);
    },
    [recording, onChange],
  );

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setRecording(true); }}
      onKeyDown={handleKeyDown}
      onBlur={() => setRecording(false)}
      className={`${styles.sKbd}${recording ? ` ${styles.recording}` : ""}`}>
      {recording ? "按下组合键..." : value}
    </button>
  );
}
