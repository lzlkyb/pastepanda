/**
 * 「AI 记忆增强（语义搜索）」这一行（M5-2）。
 *
 * 从 `AiAdvanced` 拆出来有两个原因：
 * 1. **规则 #16（红线）**：这是一条会出网、会计费的能力，未启用 / 未配 key 时必须
 *    **零可见**。判据用 `useAiStatus()`（= `lib/aiAvailability` 那份唯一判定），
 *    **不是**本面板的草稿 `config`：草稿在落盘前与后端不一致，拿它门控会在
 *    「刚把总闸关掉」那一帧仍留着入口，而那一帧用户真能点。
 * 2. `AiAdvanced` 本来就过了单文件 300 行上限（规则 #7）。
 *
 * 开关本身默认关。出网的只有摘要与搜索词，原文永不出本机。
 */

import { Database, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAiStatus } from "@/hooks/useAiStatus";
import {
  semanticStatus,
  semanticIndex,
  semanticSetConfig,
  type SemanticStatus,
} from "@/lib/api/semantic";
import { useToast } from "@/components/Toast";
import settings from "../../Settings.module.css";
import styles from "../AiTab.module.css";

export function AiSemanticField({ open }: { open: boolean }) {
  // 未启用/未配 key → 整行不渲染，连状态都不去问（零可见、零请求）。
  const aiOn = useAiStatus().status === "on";
  const [sem, setSem] = useState<SemanticStatus | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  // 用户是否改过 embedding 模型草稿：改过则展开时不被服务端值覆盖（P1 修复）
  const modelDirtyRef = useRef(false);
  const [semError, setSemError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const { toast } = useToast();

  const loadSem = useCallback(async () => {
    try {
      const s = await semanticStatus();
      setSem(s);
      setSemError(null);
      // 用户没改过草稿才用服务端值回填；改过则保留，避免覆盖未保存的编辑（P1 修复）
      if (!modelDirtyRef.current) setModelDraft(s.model);
    } catch (e) {
      setSem(null);
      setSemError(`读取 AI 记忆增强状态失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    if (open && aiOn) void loadSem();
  }, [open, aiOn, loadSem]);

  const toggleSem = useCallback(
    async (enabled: boolean) => {
      try {
        await semanticSetConfig(enabled, null);
        toast(enabled ? "已开启 AI 记忆增强" : "已关闭，搜索退回关键词匹配", "success");
        void loadSem();
      } catch (e) {
        toast(`设置失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [loadSem, toast],
  );

  const saveModel = useCallback(async () => {
    try {
      await semanticSetConfig(sem?.enabled ?? false, modelDraft);
      modelDirtyRef.current = false;
      toast("embedding 模型已保存", "success");
      void loadSem();
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [loadSem, modelDraft, sem?.enabled, toast]);

  const runIndex = useCallback(async () => {
    setIndexing(true);
    try {
      const r = await semanticIndex();
      toast(
        r.indexed > 0
          ? `已索引 ${r.indexed} 条${r.pendingLeft > 0 ? `，还有 ${r.pendingLeft} 条待处理` : ""}`
          : "没有需要索引的条目",
        "success",
      );
      void loadSem();
    } catch (e) {
      toast(`索引失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setIndexing(false);
    }
  }, [loadSem, toast]);

  if (!aiOn) return null;

  return (
    <div className={styles.field}>
      <span className={styles.label}>AI 记忆增强（语义搜索）</span>
      <div className={styles.row}>
        <input
          type="checkbox"
          className={styles.toggleCheck}
          checked={sem?.enabled ?? false}
          disabled={!sem}
          onChange={(e) => void toggleSem(e.target.checked)}
        />
        <span className={styles.hint}>
          开启后，历史摘要会生成语义向量存在本地：搜"上周那个 API 文档"这类凭印象的查询
          能按<strong>意思</strong>命中，而不是只按字面。摘要/搜索词会发给当前 AI 厂商计费
          （受日预算约束），<strong>原文永不出本机</strong>；关闭即退回关键词搜索，可随时清除。
        </span>
        {semError && <span className={`${styles.hint} ${styles.hintDanger}`}>⚠ {semError}</span>}
      </div>

      {sem?.enabled && (
        <div className={`${styles.row} ${styles.semRow}`}>
          <input
            className={`${styles.input} ${styles.embedInput}`}
            value={modelDraft}
            placeholder={sem.defaultModel || "embedding 模型名"}
            onChange={(e) => {
              modelDirtyRef.current = true;
              setModelDraft(e.target.value);
            }}
            onBlur={() => void saveModel()}
          />
          {/* .btnSecondary 本身已是 display:flex + gap:6，不需要再套一层内联样式 */}
          <button
            className={settings.btnSecondary}
            onClick={() => void runIndex()}
            disabled={indexing}
          >
            {indexing ? <Loader2 size={12} className="spin" /> : <Database size={12} />}
            {indexing ? "索引中…" : "立即建立索引"}
          </button>
          <span className={styles.hint}>
            已索引 <b>{sem.vectorCount}</b> 条
            {sem.pending > 0 ? `，${sem.pending} 条待处理（搜索时会自动补）` : ""}
            {sem.providerSupports
              ? ` · 厂商 ${sem.provider} · 模型 ${sem.model || sem.defaultModel || "待填"}`
              : ` · ⚠️ 厂商 ${sem.provider} 不支持 embedding，请换 OpenAI 兼容厂商或在上面填中转模型`}
          </span>
        </div>
      )}
    </div>
  );
}
