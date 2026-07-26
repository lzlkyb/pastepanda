/**
 * JSON 类型专属：
 *   - jsonLinter：@codemirror/lint 行内诊断（波浪线 + gutter 标记 + 悬停提示）
 *   - JsonFormatBar：格式化 / 压缩 + 实时校验徽章（错误可点击跳转）
 *   - JsonPreview：结构树探索（搜索过滤 / 展开折叠 / 深度控制 / 统计栏 /
 *     节点复制值与路径 / 对象数组自动表格化）
 */
import { useMemo, useState, useCallback, type ReactNode } from "react";
import { Zap, Package, Search, ChevronsUpDown, ChevronsDownUp, Layers, Copy, Hash, AlertTriangle, CornerDownRight, Database } from "lucide-react";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { useToast } from "@/components/Toast";
import { sqlInFromJson, parseJsonArray } from "@/lib/jsonToolbox";
import type { ShellBridge } from "./types";
import styles from "../FullscreenEditor.module.css";

// ─── 校验（与 JsonEditor 规则一致：提取 WebView2 错误行号）───

interface JsonValidation {
  valid: boolean;
  line?: number;
  message?: string;
  value?: unknown;
}

function validateJson(text: string): JsonValidation {
  try {
    return { valid: true, value: JSON.parse(text) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lineMatch = msg.match(/\(line (\d+)/);
    let line: number | undefined;
    if (lineMatch) {
      line = Number(lineMatch[1]);
    } else {
      const posMatch = msg.match(/position (\d+)/);
      if (posMatch) line = text.slice(0, Number(posMatch[1])).split("\n").length;
    }
    return { valid: false, line, message: msg };
  }
}

// ─── 行内诊断（@codemirror/lint）─────────────────────────
// JSON.parse 只报第一个错误，故诊断数组最多一条；
// 错误位置优先取 "position N"，其次按行号定位行首。

export const jsonLinter = linter((view: EditorView): Diagnostic[] => {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let pos: number | null = null;
    const posMatch = msg.match(/position (\d+)/);
    if (posMatch) {
      pos = Number(posMatch[1]);
    } else {
      const lineMatch = msg.match(/\(line (\d+)/);
      if (lineMatch) {
        const ln = Math.max(1, Math.min(Number(lineMatch[1]), view.state.doc.lines));
        pos = view.state.doc.line(ln).from;
      }
    }
    if (pos === null || pos > view.state.doc.length) return [];
    return [{ from: pos, to: Math.min(pos + 1, view.state.doc.length), severity: "error", message: msg }];
  }
});

// ─── 格式栏 ─────────────────────────────────────────────

function TextBtn({ icon, label, title, onClick }: { icon: ReactNode; label: string; title: string; onClick: () => void }) {
  return (
    <button className={styles.fmtBtnText} title={title} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function JsonFormatBar({ bridge }: { bridge: ShellBridge }) {
  const { text, replaceDoc, gotoLine } = bridge;
  const { toast } = useToast();
  const validation = useMemo(() => validateJson(text), [text]);
  const isArray = useMemo(() => parseJsonArray(text).ok, [text]);

  const apply = (kind: "format" | "compress") => {
    const r = validateJson(text);
    if (!r.valid) {
      toast(`JSON 无效${r.line ? `（第 ${r.line} 行）` : ""}，无法${kind === "format" ? "格式化" : "压缩"}`, "error");
      return;
    }
    replaceDoc(kind === "format" ? JSON.stringify(r.value, null, 2) : JSON.stringify(r.value));
  };

  const copySqlIn = async () => {
    const r = sqlInFromJson(text);
    if (!r.ok || !r.sql) {
      toast(r.message || "无法转换为 SQL IN", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(r.sql);
      toast(`已复制 SQL IN（${r.info.count} 个值）`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <>
      <TextBtn icon={<Zap size={13} />} label="格式化" title="格式化 JSON" onClick={() => apply("format")} />
      <TextBtn icon={<Package size={13} />} label="压缩" title="压缩为单行" onClick={() => apply("compress")} />
      {isArray && (
        <TextBtn icon={<Database size={13} />} label="SQL IN" title="转换为 SQL IN 并复制" onClick={copySqlIn} />
      )}
      {validation.valid ? (
        <span className={`${styles.validBadge} ${styles.validOk}`} title="JSON 格式正确">
          ✓ 有效
        </span>
      ) : (
        <button
          className={`${styles.validBadge} ${styles.validBad} ${styles.validBadgeBtn}`}
          title={`${validation.message ?? "JSON 无效"}（点击跳转到错误行）`}
          onClick={() => validation.line && gotoLine(validation.line)}
        >
          ✕ 第 {validation.line ?? "?"} 行错误 · 跳转
        </button>
      )}
    </>
  );
}

// ─── 结构树模型 ─────────────────────────────────────────

type JType = "object" | "array" | "string" | "number" | "boolean" | "null";

interface JNode {
  key: string | null;
  path: string;
  type: JType;
  value: unknown;
  children: JNode[] | null;
  depth: number;
}

function typeOf(v: unknown): JType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number") return "number";
  return "boolean";
}

function buildTree(value: unknown, key: string | null, path: string, depth: number): JNode {
  const type = typeOf(value);
  if (type === "object") {
    const children = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      buildTree(v, k, `${path}.${k}`, depth + 1)
    );
    return { key, path, type, value, children, depth };
  }
  if (type === "array") {
    const children = (value as unknown[]).map((v, i) => buildTree(v, null, `${path}[${i}]`, depth + 1));
    return { key, path, type, value, children, depth };
  }
  return { key, path, type, value, children: null, depth };
}

interface JStats {
  total: number;
  maxDepth: number;
  bytes: number;
  counts: Record<JType, number>;
}

function computeStats(root: JNode, text: string): JStats {
  const counts: Record<JType, number> = { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 };
  let total = 0;
  let maxDepth = 0;
  const walk = (n: JNode) => {
    total += 1;
    counts[n.type] += 1;
    if (n.depth > maxDepth) maxDepth = n.depth;
    n.children?.forEach(walk);
  };
  walk(root);
  return { total, maxDepth, bytes: new TextEncoder().encode(text).length, counts };
}

/** 搜索匹配：键名或原始值包含查询串（不区分大小写） */
function nodeMatches(n: JNode, q: string): boolean {
  if (n.key !== null && n.key.toLowerCase().includes(q)) return true;
  if (n.children === null) return String(n.value).toLowerCase().includes(q);
  return false;
}

/** 计算可见路径集合：所有匹配节点 + 其祖先（保证匹配节点可被看到） */
function computeVisible(root: JNode, q: string): Set<string> {
  const visible = new Set<string>();
  const walk = (n: JNode): boolean => {
    let childHit = false;
    if (n.children) {
      for (const c of n.children) {
        if (walk(c)) childHit = true;
      }
    }
    if (nodeMatches(n, q) || childHit) {
      visible.add(n.path);
      return true;
    }
    return false;
  };
  walk(root);
  return visible;
}

/** 高亮首个匹配片段 */
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

// ─── 类型着色 ───────────────────────────────────────────

const TYPE_DOT: Record<JType, string> = {
  object: "#e06c75",
  array: "#61afef",
  string: "#98c379",
  number: "#d19a66",
  boolean: "#c678dd",
  null: "#5c6370",
};

const TYPE_SHORT: Record<JType, string> = {
  object: "obj",
  array: "arr",
  string: "str",
  number: "num",
  boolean: "bool",
  null: "null",
};

/** 统计条徽章用中文标签 */
const TYPE_LABEL: Record<JType, string> = {
  object: "对象",
  array: "数组",
  string: "字符串",
  number: "数字",
  boolean: "布尔",
  null: "空",
};

const JTYPE_CLASS: Record<JType, string> = {
  object: styles.jtypeObj ?? "",
  array: styles.jtypeArr ?? "",
  string: styles.jtypeStr ?? "",
  number: styles.jtypeNum ?? "",
  boolean: styles.jtypeBool ?? "",
  null: styles.jtypeNull ?? "",
};

// ─── 表格化检测：根为「全对象数组」时提供表格视图 ─────────

interface JTable {
  columns: Array<{ key: string; type: JType }>;
  rows: Array<Record<string, unknown>>;
}

function detectTable(root: JNode): JTable | null {
  if (root.type !== "array" || !root.children || root.children.length === 0) return null;
  if (!root.children.every((c) => c.type === "object")) return null;
  const seen = new Map<string, JType>();
  for (const row of root.children) {
    for (const c of row.children ?? []) {
      if (c.key !== null && !seen.has(c.key)) seen.set(c.key, c.type);
    }
  }
  return {
    columns: Array.from(seen, ([key, type]) => ({ key, type })),
    rows: root.children.map((r) => r.value as Record<string, unknown>),
  };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ─── 节点视图 ───────────────────────────────────────────

/** 填充式折叠箭头（展开时经 CSS 旋转 90°） */
function FoldArrow() {
  return (
    <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M2 1l4 3-4 3z" fill="currentColor" />
    </svg>
  );
}

function JsonPrimitiveView({ node, q }: { node: JNode; q: string }) {
  switch (node.type) {
    case "null":
      return <span className={styles.jtNull}>null</span>;
    case "string": {
      const s = node.value as string;
      const shown = s.length > 80 ? s.slice(0, 80) + "…" : s;
      return (
        <span className={styles.jtStr}>
          "{highlight(shown, q)}"
        </span>
      );
    }
    case "number":
      return <span className={styles.jtNum}>{String(node.value)}</span>;
    case "boolean":
      return <span className={styles.jtBool}>{String(node.value)}</span>;
    default:
      return <span>{String(node.value)}</span>;
  }
}

interface JsonNodeViewProps {
  node: JNode;
  q: string;
  collapsed: Set<string>;
  searching: boolean;
  visible: Set<string> | null;
  onToggle: (path: string) => void;
  onCopyValue: (node: JNode) => void;
  onCopyPath: (node: JNode) => void;
  /** 悬停行时同步 JSONPath 到底部路径栏 */
  onHover: (path: string) => void;
}

function JsonNodeView({ node, q, collapsed, searching, visible, onToggle, onCopyValue, onCopyPath, onHover }: JsonNodeViewProps) {
  if (visible && !visible.has(node.path)) return null;

  const isContainer = node.children !== null;
  // 搜索时强制展开，保证匹配节点可见
  const isCollapsed = !searching && isContainer && collapsed.has(node.path);
  // 直接命中的行高亮强调（祖先行仅展开，不着色）
  const isHit = searching && nodeMatches(node, q);
  const rowClass = `${styles.jtRow} ${isHit ? styles.jtHit ?? "" : ""}`;

  const keyLabel = node.key !== null && (
    <>
      <span className={styles.jtKey}>"{highlight(node.key, q)}"</span>
      <span className={styles.jtColon}>:</span>
    </>
  );

  const actions = (
    <span className={styles.jtActions}>
      <button className={styles.jtAct} title="复制值" onClick={() => onCopyValue(node)}>
        <Copy size={11} />
      </button>
      <button className={styles.jtAct} title="复制路径" onClick={() => onCopyPath(node)}>
        <Hash size={11} />
      </button>
    </span>
  );

  if (!isContainer) {
    return (
      <div className={rowClass} onMouseEnter={() => onHover(node.path)}>
        <span className={styles.jtToggle} />
        {keyLabel}
        <JsonPrimitiveView node={node} q={q} />
        {actions}
      </div>
    );
  }

  const brace = node.type === "array" ? "[]" : "{}";
  const count = node.children!.length;
  const countLabel = node.type === "array" ? `${count} 项` : `${count} 个键`;

  return (
    <div>
      <div className={rowClass} onMouseEnter={() => onHover(node.path)}>
        <span
          className={`${styles.jtToggle} ${isCollapsed ? "" : styles.jtToggleOpen ?? ""}`}
          onClick={() => onToggle(node.path)}
        >
          <FoldArrow />
        </span>
        {keyLabel}
        <span className={styles.jtBrace}>{brace}</span>
        <span className={styles.jtCount}>{countLabel}</span>
        {actions}
      </div>
      {!isCollapsed && (
        <div className={styles.jtChildren}>
          {node.children!.map((c, i) => (
            <JsonNodeView
              key={c.path || i}
              node={c}
              q={q}
              collapsed={collapsed}
              searching={searching}
              visible={visible}
              onToggle={onToggle}
              onCopyValue={onCopyValue}
              onCopyPath={onCopyPath}
              onHover={onHover}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 表格视图 ───────────────────────────────────────────

function JTableView({ table, q }: { table: JTable; q: string }) {
  const rows = useMemo(() => {
    if (!q) return table.rows;
    return table.rows.filter((r) => table.columns.some((c) => cellText(r[c.key]).toLowerCase().includes(q)));
  }, [table, q]);

  return (
    <div className={styles.csvTableWrap}>
      <table className={styles.jtable}>
        <thead>
          <tr>
            <th className={styles.jIdx}>#</th>
            {table.columns.map((c) => (
              <th key={c.key}>
                {highlight(c.key, q)}
                <span className={`${styles.jtype} ${JTYPE_CLASS[c.type]}`}>{TYPE_SHORT[c.type]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <td className={styles.jIdx}>{ri}</td>
              {table.columns.map((c) => (
                <td key={c.key}>{highlight(cellText(r[c.key]), q)}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className={styles.jIdx} />
              <td colSpan={Math.max(table.columns.length, 1)} style={{ color: "var(--text-muted)" }}>
                无匹配行
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── 预览主组件 ─────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function JsonPreview({ text, bridge }: { text: string; bridge?: ShellBridge }) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [depthSetting, setDepthSetting] = useState(0); // 0 = 全部展开
  const [hoverPath, setHoverPath] = useState("$");
  const { toast } = useToast();

  const tree = useMemo<JNode | null>(() => {
    try {
      return buildTree(JSON.parse(text), null, "$", 0);
    } catch {
      return null;
    }
  }, [text]);

  const stats = useMemo(() => (tree ? computeStats(tree, text) : null), [tree, text]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (tree && q ? computeVisible(tree, q) : null), [tree, q]);
  const matchCount = useMemo(() => {
    if (!tree || !q) return 0;
    let c = 0;
    const walk = (n: JNode) => {
      if (nodeMatches(n, q)) c += 1;
      n.children?.forEach(walk);
    };
    walk(tree);
    return c;
  }, [tree, q]);
  const tableData = useMemo(() => (tree ? detectTable(tree) : null), [tree]);
  const searching = q.length > 0;

  const onToggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setCollapsed(new Set());
    setDepthSetting(0);
  }, []);

  const collapseAll = useCallback(() => {
    if (!tree) return;
    const next = new Set<string>();
    const walk = (n: JNode) => {
      if (n.children && n.children.length > 0) {
        next.add(n.path);
        n.children.forEach(walk);
      }
    };
    walk(tree);
    setCollapsed(next);
    setDepthSetting(0);
  }, [tree]);

  /** 深度 d：折叠所有 depth >= d 的容器节点（d=0 表示全部展开） */
  const applyDepth = useCallback(
    (d: number) => {
      setDepthSetting(d);
      if (!tree || d === 0) {
        if (d === 0) setCollapsed(new Set());
        return;
      }
      const next = new Set<string>();
      const walk = (n: JNode) => {
        if (n.children && n.children.length > 0) {
          if (n.depth >= d) next.add(n.path);
          n.children.forEach(walk);
        }
      };
      walk(tree);
      setCollapsed(next);
    },
    [tree]
  );

  const cycleDepth = useCallback(() => {
    const next = depthSetting === 0 ? 1 : depthSetting === 1 ? 2 : depthSetting === 2 ? 3 : 0;
    applyDepth(next);
  }, [depthSetting, applyDepth]);

  const copyValue = useCallback(
    async (node: JNode) => {
      const s =
        node.children !== null
          ? JSON.stringify(node.value, null, 2)
          : node.type === "string"
            ? (node.value as string)
            : String(node.value);
      try {
        await navigator.clipboard.writeText(s);
        toast("已复制值", "success");
      } catch {
        toast("复制失败", "error");
      }
    },
    [toast]
  );

  const copyPathStr = useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(path);
        toast(`已复制路径 ${path}`, "success");
      } catch {
        toast("复制失败", "error");
      }
    },
    [toast]
  );

  const copyPath = useCallback((node: JNode) => copyPathStr(node.path), [copyPathStr]);

  if (!tree) {
    if (!text.trim()) {
      return (
        <div className={styles.jsonTreeInvalid}>
          <span className={styles.invalidIcon}>
            <AlertTriangle size={19} />
          </span>
          <div className={styles.invalidTitle}>暂无内容</div>
        </div>
      );
    }
    const v = validateJson(text);
    return (
      <div className={styles.jsonTreeInvalid}>
        <span className={styles.invalidIcon}>
          <AlertTriangle size={19} />
        </span>
        <div className={styles.invalidTitle}>JSON 无效，无法预览结构树</div>
        {v.message && <div className={styles.invalidMsg}>{v.message}</div>}
        {v.line && bridge && (
          <button className={styles.invalidJump} onClick={() => bridge.gotoLine(v.line!)}>
            <CornerDownRight size={13} />
            跳转错误行（第 {v.line} 行）
          </button>
        )}
      </div>
    );
  }

  const chip = (type: JType) =>
    stats && stats.counts[type] > 0 ? (
      <span key={type} className={styles.statChip}>
        <span className={styles.dot} style={{ background: TYPE_DOT[type] }} />
        {TYPE_LABEL[type]} {stats.counts[type]}
      </span>
    ) : null;

  const distTypes = stats ? (Object.keys(stats.counts) as JType[]).filter((t) => stats.counts[t] > 0) : [];

  return (
    <div className={styles.jsonPreviewRoot}>
      <div className={styles.treeControls}>
        <div className={styles.searchInput}>
          <Search size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索键名或值…"
            spellCheck={false}
          />
          {searching && <span className={styles.matchChip}>{matchCount} 匹配</span>}
        </div>
        {!tableData && (
          <>
            <button className={styles.treeBtn} title="展开全部" onClick={expandAll}>
              <ChevronsUpDown size={13} />
            </button>
            <button className={styles.treeBtn} title="折叠全部" onClick={collapseAll}>
              <ChevronsDownUp size={13} />
            </button>
            <button
              className={`${styles.treeBtn} ${depthSetting > 0 ? styles.treeBtnActive : ""}`}
              title="按深度折叠（循环：全部 → 1 → 2 → 3 → 全部）"
              onClick={cycleDepth}
            >
              <Layers size={13} />
              <span>{depthSetting === 0 ? "深度 ∞" : `深度 ${depthSetting}`}</span>
            </button>
          </>
        )}
      </div>

      {stats && (
        <div className={styles.statsBar}>
          <span className={styles.statItem}>{stats.total} 节点</span>
          <span className={styles.statItem}>深度 {stats.maxDepth}</span>
          <span className={styles.statItem}>{formatBytes(stats.bytes)}</span>
          <span className={styles.statsSep} />
          {chip("object")}
          {chip("array")}
          {chip("string")}
          {chip("number")}
          {chip("boolean")}
          {chip("null")}
          {distTypes.length > 0 && (
            <div className={styles.distWrap}>
              <span className={styles.distBar}>
                {distTypes.map((t) => (
                  <span
                    key={t}
                    className={styles.distSeg}
                    style={{ width: `${(stats.counts[t] / stats.total) * 100}%`, background: TYPE_DOT[t] }}
                  />
                ))}
              </span>
              <span className={styles.distLabel}>类型分布</span>
            </div>
          )}
        </div>
      )}

      <div className={`${styles.jsonTree} ${styles.treeBody}`}>
        {tableData ? (
          <JTableView table={tableData} q={q} />
        ) : (
          <JsonNodeView
            node={tree}
            q={q}
            collapsed={collapsed}
            searching={searching}
            visible={visible}
            onToggle={onToggle}
            onCopyValue={copyValue}
            onCopyPath={copyPath}
            onHover={setHoverPath}
          />
        )}
      </div>

      <div className={styles.jsonPathBar}>
        <span className={styles.pathDim}>$</span>
        {hoverPath.length > 1 && <span className={styles.pathAccent}>{hoverPath.slice(1)}</span>}
        <button className={styles.pathCopyBtn} onClick={() => copyPathStr(hoverPath)}>
          <Copy size={11} />
          复制路径
        </button>
      </div>
    </div>
  );
}
