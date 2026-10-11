import { useState, useCallback, useEffect, useRef } from "react";
import styles from "../Settings.module.css";

import { formatHotkey, normalizeHotkeyCombo, hotkeyMainKey } from "@/lib/utils";
export { formatHotkey } from "@/lib/utils";

/** 允许作为「单键」注册的全局快捷键白名单：全部是不参与文字输入的功能键/系统键。
 *  Snipaste/PixPin 截图默认 F1 就是这个模型。裸字母/数字会劫持所有应用里的打字输入，
 *  Delete/Home/方向键等编辑导航键会劫持系统功能——都不在白名单里，必须加 Ctrl/Alt/Win。 */
const SAFE_SINGLE_KEYS = new Set([
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24",
  "printscreen", "scrolllock", "pause",
]);

/**
 * 快捷键录制器
 * - 组合键必须包含修饰键（Ctrl/Alt/Win）之一；**单键仅限功能键白名单**
 *   （F1-F24 / PrtSc / ScrollLock / Pause，见 SAFE_SINGLE_KEYS）——裸字母/数字/编辑导航键
 *   会劫持全局输入或系统功能，一律拒绝
 * - Esc 退出录制（而非录成 esc 热键）
 * - taken 列表做冲突校验，冲突时拒绝并提示
 * - 捕获阶段只 preventDefault 不 stopPropagation，保证 ctrl+space 等能录到
 */
export function HotkeyRecorder({ value, onChange, taken = [], allowClear = false }: { value: string; onChange: (v: string) => void; taken?: string[]; allowClear?: boolean }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | null>(null);

  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => { setHint(null); hintTimer.current = null; }, 3500);
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
      const rawKey = hotkeyMainKey(e);
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

      // 单键限制（方案 A）：允许「非字符功能键」单键（F1-F24 / PrtSc / ScrollLock / Pause），
      // 它们不参与文字输入，全局注册安全（Snipaste/PixPin 截图默认 F1 同款模型）。
      // 裸字母/数字/符号会劫持所有应用里的打字输入，编辑/导航键（Delete/Home/方向键/CapsLock 等）
      // 会劫持系统功能——一律拒绝，必须加 Ctrl/Alt/Win。
      if (!parts.some((p) => p === "ctrl" || p === "alt" || p === "meta")) {
        if (!SAFE_SINGLE_KEYS.has(mappedKey)) {
          showHint(`字母/数字单键会劫持输入 · 请加 ${formatHotkey("ctrl+alt+meta").split(" + ").join("/")} 或选 F1-F24`);
          return;
        }
      }

      parts.push(mappedKey);
      const combo = parts.join("+");

      // 与其他快捷键冲突时拒绝
      if (taken.some((t) => t && normalizeHotkeyCombo(t) === normalizeHotkeyCombo(combo))) {
        showHint("与其他快捷键冲突");
        return;
      }

      onChange(combo);
      setRecording(false);
    },
    [recording, onChange, taken, showHint],
  );

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setRecording(true); setHint(null); }}
        onKeyDown={handleKeyDown}
        onBlur={() => setRecording(false)}
        // 🔴 录制态要挂这个标记：本组件的按键只走按钮自己的 onKeyDown，没有 window 监听，
        // 而 `SettingsView` 的 `/` 与 Ctrl+F 挂在 window 捕获期、跑得比这里早——
        // 它一抢焦点，`onBlur` 就把录制取消了（按 `/` 录不进、还看不到原因）。
        // 判据收口在 `lib/modalLayers.ts`（规则 #11.1）。
        {...(recording ? { "data-hotkey-recording": "true" } : {})}
        className={`${styles.sKbd}${recording ? ` ${styles.recording}` : ""}`}>
        {recording ? (hint ? `⚠ ${hint}` : "按下组合键…（Esc 取消）") : formatHotkey(value)}
      </button>
      {allowClear && !recording && value && value.trim() && (
        <button
          onClick={(e) => { e.stopPropagation(); onChange(""); }}
          title="清除（禁用该快捷键）"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, border: "none", borderRadius: 6,
            background: "transparent", color: "var(--text-muted)", cursor: "pointer",
            fontSize: 13, lineHeight: 1,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          ×
        </button>
      )}
    </span>
  );
}
