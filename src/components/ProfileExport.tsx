/**
 * ProfileExport — 画像导出区（v5：格式卡片三选一 + pill 勾选 + 即时预览）。
 *
 * 选择格式 / 勾选大类即实时生成预览（产物为本地纯计算，毫秒级）；
 * 「装进 Claude Code」一键写 skill 到 ~/.claude/skills/pastepanda-profile/。
 *
 * 界面不得比后端能力说得多：
 * - JSON 分支后端只做 to_string_pretty 不过滤，勾选对它无效——pill 整行禁用并注明；
 * - 安装是 std::fs::write 直接覆盖（无备份、不进回收站）——先走 ConfirmDialog；
 * - 一个大类都不勾时产物是空态提示，复制 / 保存 / 安装一律禁用。
 *
 * 曾经还有一条「安装恒为全量、不受勾选影响」的免责声明贴在安装按钮下面。那不是
 * 提示，是后端缺参数的遮羞布：v5.24.0给 profile_install_skill 补上 categories
 * 之后，预览与落盘用的是同一个过滤器，那块声明连带删除——留着它就成了新的谎。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText, FileCode2, Package, Copy, Check, Download, Lightbulb, Loader2,
  AlertTriangle, RefreshCw,
} from "lucide-react";
import {
  profileExport, profileInstallSkill, skillInstallWorkflows,
  type ProfileFormat, type ProfileCategory,
} from "@/lib/api/profile";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { logActionEvent } from "@/lib/api/actionEvents";
import { errText } from "@/lib/utils";
import styles from "./ProfileDialog.module.css";
import ex from "./ProfileExport.module.css";

/**
 * 导出/安装成功记一笔行为事件（成就「可移植的灵魂」判定源）。
 * contentType 空串：纯动作标记，不属于任何内容类型。
 */
function logProfileExport(): void {
  logActionEvent({
    actionId: "profile-export",
    contentType: "",
    sourceApp: "",
    hour: new Date().getHours(),
    outcome: "copied",
  });
}

const FMT_CARDS: {
  id: ProfileFormat;
  name: string;
  icon: typeof FileText;
  desc1: string;
  desc2: string;
}[] = [
  { id: "md", name: "Markdown", icon: FileText, desc1: "5 大类通用格式", desc2: "粘贴给任意 LLM" },
  { id: "json", name: "JSON", icon: FileCode2, desc1: "完整结构化快照", desc2: "备份 / 二次开发" },
  // 原先写的是“Cursor / Codex”，但安装按钮只写 ~/.claude/skills，不碰其它工具
  { id: "skill", name: "SKILL 技能包", icon: Package, desc1: "装进 Claude Code", desc2: "其它工具靠保存文件" },
];

const CATS: { id: ProfileCategory; label: string }[] = [
  { id: "profession", label: "职业画像" },
  { id: "projects", label: "工作习惯" },
  { id: "preferences", label: "风格偏好" },
  { id: "instructions", label: "使用红线" },
];

/** 安装目标目录（后端从 USERPROFILE/HOME 拼，前端传不进路径分量） */
const INSTALL_DIR = "~/.claude/skills/pastepanda-profile/";

export function ProfileExport() {
  const [format, setFormat] = useState<ProfileFormat>("md");
  /**
   * 初始默认全勾——“看到什么就是导出什么”。
   *
   * 早期是 new Set()（四个 pill 全灰）配上后端把空数组当“全部”，于是全灰却预览
   * 全量、勾一个反而内容变少，语义整个是反的。现在后端区分了不传/空数组，
   * 全不勾就真的什么都不含，所以默认全勾仍是唯一合理的初值。
   */
  const [cats, setCats] = useState<Set<ProfileCategory>>(() => new Set(CATS.map((c) => c.id)));
  const [text, setText] = useState("");
  /** 预览失败原因：原先 catch 里 setText("") 把失败退化成了“像是还没选”的空态 */
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  /** 重试计数：变一下就重跑同一段 effect，不用另写一份生成逻辑 */
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installingWorkflows, setInstallingWorkflows] = useState(false);
  /** 安装前的二次确认（后端直接覆盖同名 SKILL.md） */
  const [confirmInstall, setConfirmInstall] = useState(false);
  const reqRef = useRef(0);
  const { toast } = useToast();

  /** JSON 分支后端不过滤大类，勾选对它完全无效 */
  const catsIgnored = format === "json";
  /**
   * 一个大类都没勾（JSON 不看勾选，所以只对 md/skill 成立）。
   * 此时预览里是后端给的空态占位文本，`text` 是非空的——所以光靠 `!text`
   * 拦不住，必须单独判。
   */
  const noCats = cats.size === 0 && !catsIgnored;
  /** 确认框里逐条列出将写入的大类，不能只说“全量”或让用户回头数 pill */
  const catNames = CATS.filter((c) => cats.has(c.id)).map((c) => c.label).join(" / ");
  const statusClass = err ? ex.statusErr : loading ? ex.statusLoading : "";

  // 即时预览：格式/勾选变化即生成（本地毫秒级；reqRef 防乱序）
  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    void profileExport(format, Array.from(cats))
      .then((t) => {
        if (reqRef.current !== id) return;
        setText(t);
        setErr("");
      })
      .catch((e: unknown) => {
        if (reqRef.current !== id) return;
        // 静默吞掉会让失败长得像“还没选”，而用户明明已经选了：把原因留在预览框里
        setText("");
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (reqRef.current === id) setLoading(false);
      });
  }, [format, cats, retry]);

  const toggleCat = useCallback((c: ProfileCategory) => {
    setCats((cur) => {
      const next = new Set(cur);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);

  const copy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("复制失败", "error");
    }
  }, [text, toast]);

  const saveFile = useCallback(async () => {
    if (!text) return;
    const ext = format === "json" ? "json" : "md";
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: `pastepanda-profile.${ext}`,
        filters: [{ name: "文本", extensions: [ext] }],
      });
      if (!path) return;
      await writeTextFile(path, text);
      toast(`已保存到 ${path}`, "success");
      logProfileExport();
    } catch (e) {
      toast(`保存失败：${errText(e, "未知错误")}`, "error");
    }
  }, [format, text, toast]);

  const installSkill = useCallback(async () => {
    setInstalling(true);
    try {
      // 传的是同一份勾选：预览里看到的 SKILL.md 就是落盘的 SKILL.md
      const dir = await profileInstallSkill(Array.from(cats));
      toast(`已安装到 ${dir}`, "success");
      logProfileExport();
    } catch (e) {
      toast(`安装失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setInstalling(false);
    }
  }, [cats, toast]);

  /** v6.4 S1：把自定义 AI 动作 + 动作链打包成 Skill 装进 Claude Code */
  const installWorkflows = useCallback(async () => {
    setInstallingWorkflows(true);
    try {
      const r = await skillInstallWorkflows();
      // skipped > 0 必须明说：导出物会被外部 AI 工具自动读取，含密钥/个人信息的条目
      // 被整条剔掉了；不说的话用户会以为自己的动作莫名其妙丢了
      if (r.skipped > 0) {
        toast(`已导出到 ${r.path}；${r.skipped} 条因含疑似敏感信息（密钥或个人信息）未导出`, "warning");
      } else {
        toast(`已导出到 ${r.path}`, "success");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setInstallingWorkflows(false);
    }
  }, [toast]);

  return (
    <div className={styles.exportCard}>
      <div className={styles.exportHead}>
        {/* 不带 class：标题样式由父级 .exportHead 统一承担（font-size/weight/color），
            .exportSub 才需要显式覆盖。原先引的 styles.exportTitle 在 css 里不存在，
            是悬空引用（无视觉后果，但会让人以为这里有专属样式）。 */}
        <span>导出画像</span>
        <span className={styles.exportSub}>产物仅含统计 · 可带去任何 AI 工具 · 选择即实时预览</span>
      </div>

      {/* 格式卡片三选一 */}
      <div className={styles.fmtCards}>
        {FMT_CARDS.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.id}
              className={`${styles.fmtCard}${format === c.id ? ` ${styles.fmtCardOn}` : ""}`}
              onClick={() => setFormat(c.id)}
            >
              <span className={styles.fmtIcon}><Icon size={14} /></span>
              <span className={styles.fmtName}>{c.name}</span>
              <span className={styles.fmtDesc}>{c.desc1}<br />{c.desc2}</span>
            </button>
          );
        })}
      </div>

      {/* 大类 pill 勾选 */}
      <div className={styles.catRow}>
        <span className={styles.catLabel}>包含（全不勾 = 不含任何内容）：</span>
        {CATS.map((c) => {
          const on = cats.has(c.id) && !catsIgnored;
          return (
            <button
              key={c.id}
              className={`${styles.pill}${on ? ` ${styles.pillOn}` : ""}${catsIgnored ? ` ${ex.pillOff}` : ""}`}
              onClick={() => toggleCat(c.id)}
              disabled={catsIgnored}
              title={catsIgnored ? "JSON 是完整快照，后端不按大类过滤" : undefined}
            >
              {on ? "✓ " : ""}{c.label}
            </button>
          );
        })}
      </div>

      {/* 勾选何时无效，说在前面 */}
      {catsIgnored && (
        <div className={ex.note}>
          JSON 导出的是完整画像快照，后端不按大类过滤——上面的勾选对它无效，改用 Markdown 才能挑大类。
        </div>
      )}

      {/* 全不勾不再等于全部：说在前面，而不是让用户从空白预览里自己猜 */}
      {noCats && (
        <div className={ex.note}>
          一个大类都没勾选——产物不含任何内容。至少勾一项才能复制 / 保存 / 安装。
        </div>
      )}

      {/* SKILL 目标提示 */}
      {format === "skill" && (
        <div className={styles.targetHint}>
          <Lightbulb size={12} className={styles.targetIcon} />
          <span>
            下面的安装按钮只写 Claude Code 的 <code>{INSTALL_DIR}</code>；
            其它工具（Cursor / Codex 等）请用「保存文件」自己放到它们的目录。
          </span>
        </div>
      )}

      {/* 预览 + 操作 */}
      <div className={styles.previewBox}>
        <div className={styles.previewBar}>
          <span>预览</span>
          <span className={`${styles.previewStatus} ${statusClass}`}>
            {err ? "● 生成失败" : loading ? "● 生成中…" : "● 实时生成 · 本地完成"}
          </span>
        </div>
        {err ? (
          <div className={ex.errBox}>
            <span className={ex.errHead}>
              <AlertTriangle size={12} className={ex.errIcon} />
              预览生成失败：{err}
            </span>
            <button className={styles.opBtn} onClick={() => setRetry((n) => n + 1)}>
              <RefreshCw size={12} /> 重试
            </button>
          </div>
        ) : (
          <textarea
            className={styles.previewArea}
            readOnly
            value={text}
            spellCheck={false}
            placeholder="选择格式与大类后，这里实时显示产物…"
          />
        )}
      </div>

      <div className={styles.opRow}>
        <button className={styles.opBtn} onClick={() => void copy()} disabled={!text || noCats}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
        <button className={styles.opBtn} onClick={() => void saveFile()} disabled={!text || noCats}>
          <Download size={12} /> 保存文件
        </button>
        {format === "skill" && (
          <button
            className={`${styles.opBtn} ${styles.opBtnPrimary}`}
            onClick={() => setConfirmInstall(true)}
            disabled={installing || noCats}
          >
            {installing ? <Loader2 size={12} className="spin" /> : <Package size={12} />}
            {installing ? "安装中…" : "装进 Claude Code →"}
          </button>
        )}
      </div>

      {/* v6.4 S1：工作流技能包——独立于画像勾选，把自定义动作+链带走 */}
      <div className={ex.workflowRow}>
        <button
          className={ex.workflowBtn}
          onClick={() => void installWorkflows()}
          disabled={installingWorkflows}
          title="把自定义 AI 动作与动作链打包成 SKILL.md，装进 Claude Code / Cursor / Codex 等 26+ 平台"
        >
          {installingWorkflows ? <Loader2 size={12} className="spin" /> : <Package size={12} />}
          {installingWorkflows ? "导出中…" : "导出我的动作与链为 Skill"}
        </button>
        <span className={ex.workflowHint}>把自定义 AI 动作 + 动作链打包，装进 Claude Code / Cursor</span>
      </div>

      <ConfirmDialog
        open={confirmInstall}
        title="确认写入 Claude Code 技能目录"
        message={`将向 ${INSTALL_DIR} 写入两个文件，已存在的同名文件会被直接覆盖（无备份、不进回收站）：\n\n· SKILL.md —— 只含你勾选的大类：${catNames}（与上方预览一致）\n· references/profile.json —— 完整画像快照，不按大类过滤\n\n该目录会被 Claude Code 自动读取。`}
        confirmText="覆盖写入"
        cancelText="取消"
        variant="warning"
        onConfirm={() => {
          setConfirmInstall(false);
          void installSkill();
        }}
        onCancel={() => setConfirmInstall(false)}
      />
    </div>
  );
}
