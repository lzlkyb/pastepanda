/**
 * ProfileExport — 画像导出区（v5：格式卡片三选一 + pill 勾选 + 即时预览）。
 *
 * 选择格式 / 勾选大类即实时生成预览（产物为本地纯计算，毫秒级）；
 * 「装进 Claude Code」一键写 skill 到 ~/.claude/skills/pastepanda-profile/。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, FileCode2, Package, Copy, Check, Download, Lightbulb, Loader2 } from "lucide-react";
import {
  profileExport, profileInstallSkill,
  type ProfileFormat, type ProfileCategory,
} from "@/lib/api/profile";
import { useToast } from "@/components/Toast";
import styles from "./ProfileDialog.module.css";

const FMT_CARDS: {
  id: ProfileFormat;
  name: string;
  icon: typeof FileText;
  desc1: string;
  desc2: string;
}[] = [
  { id: "md", name: "Markdown", icon: FileText, desc1: "5 大类通用格式", desc2: "粘贴给任意 LLM" },
  { id: "json", name: "JSON", icon: FileCode2, desc1: "结构化数据", desc2: "备份 / 二次开发" },
  { id: "skill", name: "SKILL 技能包", icon: Package, desc1: "装进 Claude Code", desc2: "Cursor / Codex" },
];

const CATS: { id: ProfileCategory; label: string }[] = [
  { id: "profession", label: "职业画像" },
  { id: "projects", label: "工作习惯" },
  { id: "preferences", label: "风格偏好" },
  { id: "instructions", label: "使用红线" },
];

export function ProfileExport() {
  const [format, setFormat] = useState<ProfileFormat>("md");
  const [cats, setCats] = useState<Set<ProfileCategory>>(new Set());
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const reqRef = useRef(0);
  const { toast } = useToast();

  // 即时预览：格式/勾选变化即生成（本地毫秒级；reqRef 防乱序）
  useEffect(() => {
    const id = ++reqRef.current;
    void profileExport(format, Array.from(cats))
      .then((t) => {
        if (reqRef.current === id) setText(t);
      })
      .catch(() => {
        if (reqRef.current === id) setText("");
      });
  }, [format, cats]);

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
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [format, text, toast]);

  const installSkill = useCallback(async () => {
    setInstalling(true);
    try {
      const dir = await profileInstallSkill();
      toast(`已安装到 ${dir}`, "success");
    } catch (e) {
      toast(`安装失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setInstalling(false);
    }
  }, [toast]);

  return (
    <div className={styles.exportCard}>
      <div className={styles.exportHead}>
        <span className={styles.exportTitle}>导出画像</span>
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
        <span className={styles.catLabel}>包含：</span>
        {CATS.map((c) => (
          <button
            key={c.id}
            className={`${styles.pill}${cats.has(c.id) ? ` ${styles.pillOn}` : ""}`}
            onClick={() => toggleCat(c.id)}
          >
            {cats.has(c.id) ? "✓ " : ""}{c.label}
          </button>
        ))}
      </div>

      {/* SKILL 目标提示 */}
      {format === "skill" && (
        <div className={styles.targetHint}>
          <Lightbulb size={12} className={styles.targetIcon} />
          <span>
            将 SKILL.md 保存到 <code>~/.claude/skills/pastepanda-profile/</code>
            （或 Cursor 的 skills 目录），之后对它说“按我的习惯来”即可生效。
          </span>
        </div>
      )}

      {/* 预览 + 操作 */}
      <div className={styles.previewBox}>
        <div className={styles.previewBar}>
          <span>预览</span>
          <span className={styles.previewStatus}>● 实时生成 · 本地完成</span>
        </div>
        <textarea
          className={styles.previewArea}
          readOnly
          value={text}
          spellCheck={false}
          placeholder="选择格式与大类后，这里实时显示产物…"
        />
      </div>

      <div className={styles.opRow}>
        <button className={styles.opBtn} onClick={() => void copy()} disabled={!text}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
        <button className={styles.opBtn} onClick={() => void saveFile()} disabled={!text}>
          <Download size={12} /> 保存文件
        </button>
        {format === "skill" && (
          <button
            className={`${styles.opBtn} ${styles.opBtnPrimary}`}
            onClick={() => void installSkill()}
            disabled={installing}
          >
            {installing ? <Loader2 size={12} className="spin" /> : <Package size={12} />}
            {installing ? "安装中…" : "装进 Claude Code →"}
          </button>
        )}
      </div>
    </div>
  );
}
