/**
 * 「画像影响 AI 输出」开关与原样预览（D1，2026-08-14）。
 *
 * 拆成独立组件而不是写进 `AiEvolution`：后者已经快到 300 行上限，
 * 而这块自己带异步拉取与四种状态，塞进去会把那个文件搞成杂烩。
 *
 * **默认开**。这是一条新的出网通道，所以两件事必须做到：
 * ① 展示的必须是**实际拼进 prompt 的那串字符**（后端与 `ai_run` 共用同一个函数），
 *   不是它的抽象描述；等宽字体 + 可选中，用户能直接复制出去比对。
 * ② “开了却什么都没发”的每一种情况都要说出原因（样本不够 / 特征不明显 / 被出网闸拦下）。
 *   没有提示就是静默失败：用户会以为功能坏了，或者更糟——以为正在发而实际没发。
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/components/Toast";
import { profilePromptPreview, type ProfilePromptPreview } from "@/lib/api/profile";
import styles from "../AiTab.module.css";

interface Props {
  /** 当前开关值（来自 `AiConfig.profileAsContext`） */
  enabled: boolean;
  onChange: (v: boolean) => void;
}

export function AiProfileInject({ enabled, onChange }: Props) {
  const { toast } = useToast();
  const [pv, setPv] = useState<ProfilePromptPreview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPv(await profilePromptPreview());
    } catch (e) {
      toast(`读取注入片段失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // 关着时不拉（预览区根本不渲染）；关掉后丢掉旧值，
  // 下次再开重拉——中间这段时间画像很可能已经变了。
  useEffect(() => {
    if (!enabled) {
      setPv(null);
      return;
    }
    if (!pv && !loading) void load();
  }, [enabled, pv, loading, load]);

  return (
    <>
      <div className={styles.evoRow}>
        <span className={styles.evoName}>
          画像影响 AI 输出
          <span className={styles.evoDesc}>
            开启后，会把一段描述你使用习惯的文字随请求发给模型（不含任何复制内容）
          </span>
        </span>
        <button
          className={`${styles.evoBtn}${enabled ? ` ${styles.evoBtnOn}` : ""}`}
          onClick={() => onChange(!enabled)}
          aria-pressed={enabled}
        >
          {enabled ? "开" : "关"}
        </button>
      </div>

      {enabled && (
        <div className={styles.injectWrap}>
          <div className={styles.injectHead}>
            <b>实际会发出去的内容（原文）</b>
            <button className={styles.evoBtn} onClick={() => void load()} disabled={loading}>
              <RefreshCw size={11} /> 刷新
            </button>
          </div>

          {loading && !pv ? (
            <div className={styles.evoDesc}>
              <Loader2 size={12} className="spin" /> 加载中…
            </div>
          ) : (
            <InjectBody pv={pv} />
          )}
        </div>
      )}
    </>
  );
}

/** 预览主体的四种状态。拆出来只为了让上面那个组件的 JSX 不嵌套三层三元。 */
function InjectBody({ pv }: { pv: ProfilePromptPreview | null }) {
  if (!pv) return null;

  // 样本不够：开关可以先留着，攒够了自动生效，不需要用户回来手动开
  if (!pv.text && pv.sampleEvents < pv.minEvents) {
    return (
      <div className={styles.stateNote}>
        <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          使用记录还不够（已有 {pv.sampleEvents} 次，需至少 {pv.minEvents} 次），
          <b>目前不会注入任何内容</b>。开关可以先留着，攒够了自动生效。
        </span>
      </div>
    );
  }

  // 样本够但没有足够明显的特征（如两个角色咬得很紧、领域也不集中）。
  // 这不是故障，是“宁可不注，不能注错”的预期行为，但得说一声。
  if (!pv.text) {
    return (
      <div className={styles.stateNote}>
        <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          你的使用习惯目前还没有足够明显的倾向，<b>本次不会注入任何内容</b>。
          宁可不注，不能注错。
        </span>
      </div>
    );
  }

  return (
    <>
      <div className={styles.injectBox}>{pv.text}</div>
      {pv.blocked ? (
        <div className={styles.stateNote}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            这段文字里含有疑似密钥或个人信息，<b>已整段拦下不发</b>。
          </span>
        </div>
      ) : (
        <div className={styles.evoDesc}>
          共 {pv.chars} 字 · 会随使用习惯变化，随时回来看
        </div>
      )}
    </>
  );
}
