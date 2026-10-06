import { useCallback, useEffect, useRef, useState } from "react";
import { rcApplySetting, type RcSettingKey } from "@/lib/api/rcCommands";
import { qualityLabel } from "@/lib/rcQuality";
import { rcErrorText } from "../devices/rcErrorText";
import type { MobileFeedback } from "../ui/MobileNotice";

export type SessionSettingState = { status: "pending" | "accepted" | "unconfirmed" | "error"; value: string; feedback: MobileFeedback };
type Confirmed = Record<RcSettingKey, string | null>;
const INITIAL: Confirmed = { quality: null, audio: "off", key_mode: "type" };
const LABELS: Record<RcSettingKey, string> = { quality: "画质", audio: "电脑声音", key_mode: "键盘模式" };
function valueLabel(key: RcSettingKey, value: string) {
  return key === "quality" ? qualityLabel(value) : key === "audio" ? (value === "on" ? "开启" : "关闭") : value === "type" ? "文字输入" : "逐键直传";
}

/** Settings retain their own outcome; a later mouse move must never clear a failed choice. */
export function useSessionSettings(sessionId?: string) {
  const [confirmed, setConfirmed] = useState<Confirmed>(INITIAL);
  const [items, setItems] = useState<Partial<Record<RcSettingKey, SessionSettingState>>>({});
  const [latest, setLatest] = useState<RcSettingKey | null>(null);
  const [visible, setVisible] = useState<Partial<Record<RcSettingKey, boolean>>>({});
  const states = useRef<Partial<Record<RcSettingKey, SessionSettingState>>>({});
  const confirmedRef = useRef(confirmed); confirmedRef.current = confirmed;
  const requests = useRef<Partial<Record<RcSettingKey, string>>>({});
  const queues = useRef<Partial<Record<RcSettingKey, Promise<void>>>>({});
  const sequence = useRef<Record<RcSettingKey, number>>({ quality: 0, audio: 0, key_mode: 0 });
  const owner = useRef(sessionId); owner.current = sessionId;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setConfirmed(INITIAL); setItems({}); setLatest(null); setVisible({}); states.current = {}; requests.current = {}; queues.current = {};
    return () => { alive.current = false; };
  }, [sessionId]);
  const pick = useCallback(async (key: RcSettingKey, value: string) => {
    const previous = states.current[key];
    if (previous?.value === value && previous.status === "accepted") return;
    if (previous?.value === value && previous.status === "pending") return queues.current[key];
    const id = owner.current;
    const seq = ++sequence.current[key];
    requests.current[key] = value;
    const label = LABELS[key], selected = valueLabel(key, value);
    const report = (state: SessionSettingState) => {
      if (!alive.current || owner.current !== id || sequence.current[key] !== seq) return false;
      states.current[key] = state;
      setItems(current => ({ ...current, [key]: state }));
      setVisible(current => ({ ...current, [key]: true }));
      setLatest(key);
      return true;
    };
    report({ status: "pending", value, feedback: { tone: "pending", title: `正在应用${label}…`, detail: `${selected} · 等待电脑确认` } });
    const run = async () => {
    if (!alive.current || owner.current !== id || sequence.current[key] !== seq) return;
    try {
      if (!id) throw new Error("当前没有远程会话");
      const result = await rcApplySetting(id, key, value);
      if (result.status === "accepted") {
        // The receipt confirms configuration acceptance, not the first newly encoded frame.
        // 实名档 = 关闭电脑自动档、auto = 恢复：这是被控端的确定语义（2026-10-06
        // 复测 B 的误触陷阱），必须写进成功回执，不能只靠面板里的静态提示。
        const autoNote = key === "quality"
          ? (result.value === "auto" ? " · 电脑自动档已恢复" : " · 电脑自动档已关闭")
          : "";
        if (report({ status: "accepted", value: result.value, feedback: { tone: "success", title: `电脑已接受${label}设置`, detail: `${valueLabel(key, result.value)}${key === "quality" ? ` · 画面将按新设置更新${autoNote}` : ""}` } })) {
          setConfirmed(current => ({ ...current, [key]: result.value }));
        }
      } else {
        report({ status: "unconfirmed", value, feedback: { tone: "warning", title: `${label}已发送，电脑尚未确认`, detail: "电脑端可能尚不支持确认，或回执延迟；实际状态未知，可重新发送。" } });
      }
    } catch (error) {
      const previous = confirmedRef.current[key];
      report({ status: "error", value, feedback: { tone: "error", title: `${label}未能切换`, detail: `${previous ? `上次确认：${valueLabel(key, previous)}。` : ""}${rcErrorText(error)}` } });
    }
    };
    // Serialize each setting and coalesce superseded choices so peer application order
    // agrees with the last selection even when asynchronous command dispatch reorders.
    const task = (queues.current[key] ?? Promise.resolve()).then(run);
    queues.current[key] = task;
    await task;
  }, []);
  const retry = useCallback((key: RcSettingKey) => {
    const value = requests.current[key];
    return value === undefined ? Promise.resolve() : pick(key, value);
  }, [pick]);
  const dismiss = useCallback((key?: RcSettingKey) => {
    const selected = key ?? latest;
    if (selected) setVisible(current => ({ ...current, [selected]: false }));
    if (selected === latest) setLatest(null);
  }, [latest]);
  const notices = (Object.keys(items) as RcSettingKey[]).filter(key => visible[key]).map(key => ({ key, feedback: items[key]!.feedback }));
  return { confirmed, items, latest, notices, feedback: latest ? items[latest]?.feedback : undefined, pick, retry, dismiss };
}
