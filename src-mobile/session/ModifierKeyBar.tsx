import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard } from "lucide-react";
import { MOD_KEYS } from "./useModifierKeys";
import type { MobileKeyMode } from "./SessionToolbar";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice, type MobileNoticeTone } from "../ui/MobileNotice";
import { SessionSettingFeedback } from "./SessionSettingFeedback";
import { MobileChoice } from "../ui/MobileChoice";
import type { SessionSettingState } from "./useSessionSettings";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcMobileSession.module.css";

export function ModifierKeyBar({
  open,
  onHide,
  onSendText,
  pending,
  onToggleMod,
  onFunctionKey,
  keyMode,
  onPickKeyMode,
  setting, onRetryMode, onSettingDismiss,
}: {
  open: boolean;
  onHide: () => void;
  onSendText: (text: string) => Promise<void>;
  pending: string[];
  onToggleMod: (id: string) => void;
  onFunctionKey: (vk: number) => void;
  keyMode: MobileKeyMode;
  onPickKeyMode: (mode: MobileKeyMode) => void;
  setting?: SessionSettingState;
  onRetryMode?: () => void;
  onSettingDismiss?: () => void;
}) {
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState("");
  const [hintTone, setHintTone] = useState<MobileNoticeTone>("info");
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && keyMode === "type" && !more) field.current?.focus();
  }, [open, keyMode, more]);
  useEffect(() => {
    if (!open) {
      field.current?.blur();
      setMore(false);
    }
  }, [open]);
  return (
    <>
      <section hidden={!open} className={styles.modifierBar} aria-label="电脑键盘">
        <div className={styles.keyboardTop}>
          <div
            className={styles.quickKeys}
            onPointerDown={(event) => {
              if (event.target instanceof HTMLButtonElement) event.preventDefault();
            }}
          >
            {MOD_KEYS.slice(0, 2).map((key) => (
              <button
                key={key.id}
                type="button"
                className={styles.mkKey}
                aria-pressed={pending.includes(key.id)}
                onClick={() => onToggleMod(key.id)}
              >
                {key.label}
              </button>
            ))}
            {(
              [
                ["Tab", 0x09],
                ["Esc", 0x1b],
                ["Enter", 0x0d],
              ] as const
            ).map(([label, vk]) => (
              <button key={label} type="button" className={styles.mkKey} onClick={() => onFunctionKey(vk)}>
                {label}
              </button>
            ))}
            <button type="button" className={styles.mkKey} onClick={() => setMore(true)}>
              扩展
            </button>
          </div>
          <button type="button" className={styles.mkKey} onClick={onHide}>
            收起
          </button>
        </div>
        <div className={styles.modeRow} role="radiogroup" aria-label="输入方式" onPointerDown={event => {
          if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
        }}>
          <MobileChoice value="type" checked={keyMode === "type"} title="文字输入" onSelect={() => onPickKeyMode("type")} />
          <MobileChoice value="direct" checked={keyMode === "direct"} title="逐键直传" onSelect={() => onPickKeyMode("direct")} />
        </div>
        {keyMode === "type" ? (
          <form
            className={styles.textEntry}
            onSubmit={async (event) => {
              event.preventDefault();
              if (submitting.current) return;
              if (!draft.trim()) {
                setHintTone("warning");
                setHint("先输入要发送的文字");
                return;
              }
              const submitted = draft;
              submitting.current = true;
              setSending(true);
              setHintTone("pending");
              setHint("正在提交文字…");
              try {
                await onSendText(submitted);
                setDraft(current => current === submitted ? "" : current);
                setHintTone("success");
                setHint("文字已发送，等待电脑显示");
              } catch {
                setHintTone("error");
                setHint("文字未能提交，请重试");
              } finally {
                submitting.current = false;
                setSending(false);
                field.current?.focus();
              }
            }}
          >
            <input
              ref={field}
              aria-label="输入到电脑的文字"
              placeholder="输入文字，发送到电脑"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setHint("");
              }}
            />
            <button type="submit" className={styles.mkKey} disabled={sending}>
              {sending ? "正在发送…" : "发送"}
            </button>
          </form>
        ) : (
          <p className={styles.panelHint}>逐键直传 · 中文请点上方「文字输入」。</p>
        )}
        {hint && (
          <MobileNotice compact tone={hintTone} title={hint} />
        )}
        {!more && <SessionSettingFeedback state={setting} onRetry={() => onRetryMode?.()} onDismiss={onSettingDismiss} />}
      </section>
      <MobileSheet open={more && open} title="扩展按键" onClose={() => setMore(false)}
        footer={setting && <SessionSettingFeedback state={setting} onRetry={() => onRetryMode?.()} onDismiss={onSettingDismiss} />}>
        <div className={styles.panelActions}>
          <div className={styles.modRow}>
            {MOD_KEYS.slice(2).map((key) => (
              <button
                key={key.id}
                type="button"
                className={styles.mkKey}
                aria-pressed={pending.includes(key.id)}
                onClick={() => onToggleMod(key.id)}
              >
                {key.label}
              </button>
            ))}
            <button type="button" className={styles.mkKey} onClick={() => onFunctionKey(0x2e)}>
              Delete
            </button>
            {(
              [
                [ArrowLeft, "向左", 0x25],
                [ArrowUp, "向上", 0x26],
                [ArrowDown, "向下", 0x28],
                [ArrowRight, "向右", 0x27],
              ] as const
            ).map(([Icon, label, vk]) => (
              <button key={label} type="button" className={styles.mkKey} onClick={() => onFunctionKey(vk)}>
                <Icon size={18} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <p className={styles.panelHint}>修饰键高亮表示按住；执行文字、点击或功能键后自动释放。</p>
          <button type="button" className={ui.secondary} onClick={() => setMore(false)}>
            <Keyboard size={18} aria-hidden="true" />
            返回键盘
          </button>
        </div>
      </MobileSheet>
    </>
  );
}
