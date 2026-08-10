/**
 * SequenceDiscover.tsx — 程序性记忆（V3-B）：高频动作序列 → 一键存成动作链。
 *
 * 挂在动作链运行器顶部。打开时从后端取最近 30 天的高频动作序列，
 * 与已有链（自定义 + 预置）去重后，提示「你常这样操作 → 存成动作链？」。
 *
 * 隐私：序列 = 纯 action_id 顺序（行为统计），不涉及任何内容（红线②）。
 *
 * 「忽略」记在 localStorage（本机、跨重启存活）：否决要被记住，否则同一条建议
 * 每次重开对话框又冒出来，直到它自己滑出 30 天窗口。局限说清楚——没有服务端表
 * （加表要动 Rust，超出本组件范围），所以换机器 / 清缓存 / 换 WebView 数据目录会忘。
 */

import { useEffect, useState } from "react";
import { Sparkles, X, Plus, Pencil } from "lucide-react";
import { sequenceSuggest, type SequenceSuggestion } from "@/lib/api/sequence";
import { chainList, chainSave, type ChainDef } from "@/lib/api/chains";
import { PRESET_CHAINS, invalidateUserChains, riskOf } from "@/lib/chains/registry";
import { getTransform } from "@/lib/transforms";
import { useToast } from "@/components/Toast";
import { MAX_CHAIN_NAME_CHARS } from "@/components/ChainEditor";
import styles from "./SequenceDiscover.module.css";

/** 忽略过的 pattern 存哪：值是 \0 连接的 action id 列表，不含任何内容文本 */
const IGNORED_KEY = "pastepanda_seq_ignored";

/** 忽略列表只用于「别再提这条」，不需要无限增长（超出则丢最早的） */
const IGNORED_CAP = 50;

/** 自动链名的固定前缀。它本身也占名额——曾漏算这 5 个字，导致常见序列存链必失败。 */
const NAME_PREFIX = "常用流程：";

/**
 * pattern key 的分隔符：NUL 不可能出现在 action id 里，拼出的 key 天然唯一。
 * 用 fromCharCode 而不写字面里的转义，是为了不让源文件里出现不可见字符。
 */
const SEP = String.fromCharCode(0);

function loadIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(IGNORED_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : null;
    return new Set(
      Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    // 存储被改坏 / 读不到就当没忽略过：建议重复出现比整条功能崩掉好
    return new Set();
  }
}

function saveIgnored(keys: Set<string>): void {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify([...keys].slice(-IGNORED_CAP)));
  } catch {
    // 配额满 / 隐私模式：本次会话内仍然生效，只是重启后会再提示一次
  }
}

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

/**
 * 生成默认链名：「常用流程：A → B → C」。
 *
 * 长度按**最终名字**算（含前缀与省略号），因为后端 chain_save 校验的是整个 name。
 * 之前只截 joined、不算 5 个字的前缀：`在资源管理器打开`（24 字）这类标签一进来
 * 就必然超上限，用户点「存成链」只会看到一句「名称最长 24 个字符」。
 * 计数用码点数组而不是 `.length`——后端是 `chars().count()`，emoji 自定义动作名下
 * UTF-16 长度会大于码点数，按码点截才和后端口径一致。
 */
function defaultChainName(actions: string[]): string {
  const joined = actions.map(actionLabel).join(" → ");
  const chars = [...joined];
  const budget = MAX_CHAIN_NAME_CHARS - [...NAME_PREFIX].length;
  if (chars.length <= budget) return NAME_PREFIX + joined;
  // 省略号自己也占 1 个名额
  return `${NAME_PREFIX}${chars.slice(0, budget - 1).join("")}…`;
}

export function SequenceDiscover({ open }: { open: boolean }) {
  const { toast } = useToast();
  const [items, setItems] = useState<SequenceSuggestion[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(loadIgnored);
  const [saving, setSaving] = useState<string | null>(null);
  /** 正在改名的 pattern key + 名字草稿：自动生成的名字常常不理想，存之前允许改 */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  useEffect(() => {
    if (!open) {
      setItems([]);
      setRenaming(null);
      // 注意：**不清 ignored**。它要跨对话框开关存活，否则「否决」只活一次打开。
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
        // 只提示「存下来真能跑」的序列，且必须在截断成 2 条**之前**过滤，否则废建议
        // 会白占提示位：
        // - 变换已注销：删掉/停用的自定义 AI 动作仍留在 action_events 里（后端挖掘
        //   只排除 paste 哨兵，不校验 id 还在不在），存成链后一跑就停在「变换不存在」；
        // - 执行类（kind === "action"）：有副作用且不产出文本，不该进文本流水线
        //   （与 ChainEditor 下拉的过滤同一层防护，目前埋点还够不到，但别指望上游巧合）。
        const usable = fresh.filter((p) =>
          p.actions.every((id) => {
            const t = getTransform(id);
            return !!t && t.kind !== "action";
          }),
        );
        setItems(usable.slice(0, 2));
      } catch {
        // 静默失败：程序性记忆是增强项，不影响主流程
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const ignore = (key: string) =>
    setIgnored((cur) => {
      const next = new Set(cur).add(key);
      saveIgnored(next);
      return next;
    });

  const saveAsChain = async (s: SequenceSuggestion, name: string) => {
    const key = s.actions.join(SEP);
    if (saving) return;
    setSaving(key);
    try {
      const chain: ChainDef = {
        id: "",
        name,
        description: `由高频操作自动生成（最近 30 天出现 ${s.count} 次）`,
        // risk 一律走 riskOf（唯一数据源）：运行器就是靠它告诉用户这条链会不会联网，
        // 自己内联一份推导，将来 riskOf 加判定这里不会跟着变。
        steps: s.actions.map((transformId) => ({
          transformId,
          risk: riskOf(getTransform(transformId)),
        })),
      };
      await chainSave(chain);
      invalidateUserChains();
      setItems((cur) => cur.filter((x) => x.actions.join(SEP) !== key));
      setRenaming(null);
      toast(`已存成动作链「${chain.name}」`, "success");
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(null);
    }
  };

  // 早返回必须看「可见条数」：忽略只在渲染里跳过、不从 items 移除，
  // 按 items.length 判断会在全部忽略后留下一个只有标题的空描边框。
  const visible = items.filter((s) => !ignored.has(s.actions.join(SEP)));
  if (visible.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        <Sparkles size={12} />
        发现你的高频操作
      </div>
      {visible.map((s) => {
        const key = s.actions.join(SEP);
        const editing = renaming === key;
        const name = editing ? nameDraft.trim() : defaultChainName(s.actions);
        return (
          <div key={key} className={styles.item}>
            {editing ? (
              <input
                className={styles.nameInput}
                value={nameDraft}
                maxLength={MAX_CHAIN_NAME_CHARS}
                autoFocus
                placeholder="给这条链起个名字"
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name) void saveAsChain(s, name);
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <div className={styles.info}>
                <span className={styles.seq}>{s.actions.map(actionLabel).join(" → ")}</span>
                <span className={styles.count}>最近 30 天 {s.count} 次</span>
              </div>
            )}
            <div className={styles.ops}>
              {!editing && (
                <button
                  className={styles.rename}
                  onClick={() => {
                    setRenaming(key);
                    setNameDraft(defaultChainName(s.actions));
                  }}
                  title="改个名字再存"
                  aria-label="重命名"
                >
                  <Pencil size={11} />
                </button>
              )}
              <button
                className={styles.save}
                onClick={() => void saveAsChain(s, name)}
                disabled={saving === key || !name}
              >
                <Plus size={11} />
                {saving === key ? "保存中…" : "存成链"}
              </button>
              <button
                className={styles.ignore}
                onClick={() => (editing ? setRenaming(null) : ignore(key))}
                aria-label={editing ? "取消改名" : "忽略"}
                title={editing ? "取消改名" : "忽略这条建议（记住，不再提示）"}
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
