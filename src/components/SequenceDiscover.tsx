/**
 * SequenceDiscover.tsx — 程序性记忆（V3-B）：高频动作序列 → 一键存成动作链。
 *
 * 挂在动作链运行器顶部。打开时从后端取最近 30 天的高频动作序列，
 * 与已有链（自定义 + 预置）去重后，提示「你常这样操作 → 存成动作链？」。
 *
 * 隐私：序列 = 纯 action_id 顺序（行为统计），不涉及任何内容（红线②）。
 * 忽略只记本次会话（打开次数有限，不做持久化噪音）。
 */

import { useEffect, useState } from "react";
import { Sparkles, X, Plus } from "lucide-react";
import { sequenceSuggest, type SequenceSuggestion } from "@/lib/api/sequence";
import { chainList, chainSave, type ChainDef } from "@/lib/api/chains";
import { PRESET_CHAINS } from "@/lib/chains/registry";
import { getTransform } from "@/lib/transforms";
import { invalidateUserChains } from "@/lib/chains/registry";
import { useToast } from "@/components/Toast";
import styles from "./SequenceDiscover.module.css";

/** 链的步骤序列是否已覆盖某 pattern（相同或作为连续子序列都算） */
function chainHasPattern(chainSteps: { transformId: string }[], pattern: string[]): boolean {
  if (chainSteps.length < pattern.length) return false;
  for (let i = 0; i <= chainSteps.length - pattern.length; i++) {
    let matched = true;
    for (let k = 0; k < pattern.length; k++) {
      if (chainSteps[i + k].transformId !== pattern[k]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** 动作名（带标签的变换才有可读名；未注册显示 id） */
function actionLabel(id: string): string {
  return getTransform(id)?.label ?? id;
}

/** 生成默认链名：「常用流程：A → B → C」（截断 22 字） */
function defaultChainName(actions: string[]): string {
  const joined = actions.map(actionLabel).join(" → ");
  return joined.length > 22 ? `常用流程：${joined.slice(0, 22)}…` : `常用流程：${joined}`;
}

export function SequenceDiscover({ open }: { open: boolean }) {
  const { toast } = useToast();
  const [items, setItems] = useState<SequenceSuggestion[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setItems([]);
      setIgnored(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [pats, chains] = await Promise.all([sequenceSuggest(), chainList()]);
        if (cancelled) return;
        // 去重：已有链覆盖的 pattern 不提示
        const existing = [...chains.map((c) => c.steps), ...PRESET_CHAINS.map((c) => c.steps)];
        const fresh = pats.filter(
          (p) => !existing.some((steps) => chainHasPattern(steps, p.actions)),
        );
        setItems(fresh.slice(0, 2));
      } catch {
        // 静默失败：程序性记忆是增强项，不影响主流程
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const saveAsChain = async (s: SequenceSuggestion) => {
    const key = s.actions.join("\u0000");
    if (saving) return;
    setSaving(key);
    try {
      const chain: ChainDef = {
        id: "",
        name: defaultChainName(s.actions),
        description: `由高频操作自动生成（最近 30 天出现 ${s.count} 次）`,
        steps: s.actions.map((transformId) => ({
          transformId,
          risk: getTransform(transformId)?.remote ? "network" : "local",
        })),
      };
      await chainSave(chain);
      invalidateUserChains();
      setItems((cur) => cur.filter((x) => x.actions.join("\u0000") !== key));
      toast(`已存成动作链「${chain.name}」`, "success");
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(null);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        <Sparkles size={12} />
        发现你的高频操作
      </div>
      {items.map((s) => {
        const key = s.actions.join("\u0000");
        if (ignored.has(key)) return null;
        return (
          <div key={key} className={styles.item}>
            <div className={styles.info}>
              <span className={styles.seq}>
                {s.actions.map(actionLabel).join(" → ")}
              </span>
              <span className={styles.count}>最近 30 天 {s.count} 次</span>
            </div>
            <div className={styles.ops}>
              <button
                className={styles.save}
                onClick={() => void saveAsChain(s)}
                disabled={saving === key}
              >
                <Plus size={11} />
                {saving === key ? "保存中…" : "存成链"}
              </button>
              <button
                className={styles.ignore}
                onClick={() => setIgnored((cur) => new Set(cur).add(key))}
                aria-label="忽略"
              >
                <X size={11} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
