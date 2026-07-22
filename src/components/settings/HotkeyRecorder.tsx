import { useState, useCallback, useEffect, useRef } from "react";
import styles from "../Settings.module.css";

/** 归一化组合键用于冲突比较（修饰键顺序固定，主键小写） */
function normalizeCombo(combo: string): string {
  const order = ["ctrl", "alt", "shift", "meta"];
  const parts = combo.toLowerCase().split("+").filter(Boolean);
  const mods = order.filter((m) => parts.includes(m));
  const keys = parts.filter((p) => !order.includes(p));
  return [...mods, ...keys].join("+");
}

/**
 * 快捷键录制器
 * - 必须包含修饰键（Ctrl/Alt/Win），避免劫持全局普通按键
 * - Esc 退出录制（而非录成 esc 热键）
 * - taken 列表做冲突校验，冲突时拒绝并提示
 * - 捕获阶段只 preventDefault 不 stopPropagation，保证 ctrl+space 等能录到
 */
export function HotkeyRecorder({ value, onChange, taken = [] }: { value: string; onChange: (v: string) => void; taken?: string[] }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | null>(null);

  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => { setHint(null); hintTimer.current = null; }, 1800);
  }, []);

  useEffect(() => () => { if (hintTimer.current) window.clearTimeout(hintTimer.current); }, []);

  useEffect(() => {
    if (!recording) return;
    // 只阻止默认行为（Tab 移焦 / F5 刷新 / 空格翻页等）；
    // 不能 stopPropagation — 否则事件到不了录制按钮（ctrl+space 录不上的根因）
    const handler = (e: KeyboardEvent) => {
      if (["control", "shift", "alt", "meta"].includes(e.key.toLowerCase())) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      const rawKey = e.key;
      // Esc = 退出录制
      if (rawKey === "Escape" || rawKey === "Esc") {
        setRecording(false);
        return;
      }
      // 单独按修饰键时忽略，等待主键
      if (["control", "shift", "alt", "meta"].includes(rawKey.toLowerCase())) return;

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      if (e.metaKey) parts.push("meta");
      const keyMap: Record<string, string> = {
        " ": "space", "Spacebar": "space",
        "Tab": "tab",
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

      // 必须带修饰键（Ctrl/Alt/Win），否则录成单键会劫持全局正常输入
      if (!parts.some((p) => p === "ctrl" || p === "alt" || p === "meta")) {
        showHint("需要修饰键 Ctrl/Alt/Win");
        return;
      }

      parts.push(mappedKey);
      const combo = parts.join("+");

      // 与其他快捷键冲突时拒绝
      if (taken.some((t) => t && normalizeCombo(t) === normalizeCombo(combo))) {
        showHint("与其他快捷键冲突");
        return;
      }

      onChange(combo);
      setRecording(false);
    },
    [recording, onChange, taken, showHint],
  );

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setRecording(true); setHint(null); }}
      onKeyDown={handleKeyDown}
      onBlur={() => setRecording(false)}
      className={`${styles.sKbd}${recording ? ` ${styles.recording}` : ""}`}>
      {recording ? (hint ? `⚠ ${hint}` : "按下组合键...") : value}
    </button>
  );
}
