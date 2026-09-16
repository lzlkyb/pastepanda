/**
 * MCP 可写入的范围（项目②）。设计稿：design/MCP文件夹写白名单-真实稿.html
 *
 * 与旁边的 `McpWritePanel` 是两个问题：那七个开关管「能做哪类事」，
 * 本区管「能对哪些笔记做」。揉在一起会让那七行变成九行，
 * 而第八九行不是开关。
 *
 * 收起时标题上就报当前范围：同 `McpWritePanel` 自己的原则
 * （“藏起来就没人知道可以关”）—— 这是全面板里最容易被忽略的一个设置。
 */
import { useCallback, useEffect, useState } from "react";
import {
  mcpGetWriteScope,
  mcpSetWriteScope,
  type McpScopeRow,
  type McpWriteScope,
} from "@/lib/api/mcp";
import styles from "./Mcp.module.css";

export function McpScopePanel({
  toast,
}: {
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [scope, setScope] = useState<McpWriteScope | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 收起时标题也要报范围，所以不能等展开再拉。
  useEffect(() => {
    void mcpGetWriteScope().then(setScope);
  }, []);

  /** 当前被直接勾中的条目。继承来的**不算**（它们不入存）。 */
  const checkedIds = (s: McpWriteScope) => s.rows.filter((r) => r.checked).map((r) => r.id);

  const save = useCallback(
    async (entries: string[] | null) => {
      setBusy(true);
      const next = await mcpSetWriteScope(entries);
      setBusy(false);
      // 失败时不动 UI（api 层已弹错，规则 #15.3）：
      // 否则界面看着限住了、模型实际还能写全库。
      if (!next) return;
      setScope(next);
    },
    [],
  );

  const toggle = useCallback(
    (row: McpScopeRow) => {
      if (!scope) return;
      // 继承来的勾不可单独取消：后端存的是前缀递归语义，
      // 要支持单独取消子夹就得引入「排除项」，那是另一个量级的数据模型。
      if (row.inherited) {
        toast("它已经被上层文件夹的授权包含了，要取消得取消上层那一行", "info");
        return;
      }
      const cur = checkedIds(scope);
      const next = row.checked ? cur.filter((id) => id !== row.id) : [...cur, row.id];
      void save(next);
    },
    [scope, save, toast],
  );

  /** 标题上那一句。收起也能看到当前是全库还是限定了。 */
  const summary = () => {
    if (!scope) return "";
    if (!scope.restricted) return "（全库）";
    const n = scope.rows.filter((r) => r.checked).length;
    return n === 0 ? "（一篇都不可写）" : `（限 ${n} 个位置）`;
  };

  return (
    <div className={styles.mcpGuide}>
      <button type="button" className={styles.mcpGuideToggle} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} 可写入的范围{summary()}
      </button>

      {open && (
        <div className={styles.mcpGuideBody}>
          {!scope ? (
            <p className={styles.mcpGuideNote}>读不到可写入范围。</p>
          ) : (
            <>
              <ul className={styles.mcpFsList}>
                {scope.rows.map((r) => (
                  <li
                    key={r.id}
                    className={`${styles.mcpFsRow}${r.depth > 1 ? ` ${styles[`mcpFsIndent${Math.min(r.depth - 1, 3)}`]}` : ""}${
                      r.id === "__unfiled__" ? ` ${styles.mcpFsBuiltin}` : ""
                    }`}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={r.checked || r.inherited}
                      aria-label={r.name}
                      disabled={busy}
                      className={`${styles.mcpFsBox}${
                        r.checked ? ` ${styles.mcpFsBoxOn}` : r.inherited ? ` ${styles.mcpFsBoxInherited}` : ""
                      }`}
                      onClick={() => toggle(r)}
                    >
                      {r.checked || r.inherited ? "✓" : ""}
                    </button>
                    <span
                      className={`${styles.mcpFsName}${!r.checked ? ` ${styles.mcpFsNameMuted}` : ""}`}
                    >
                      {r.name}
                    </span>
                    <span className={styles.mcpFsCount}>{r.notes} 篇</span>
                  </li>
                ))}
              </ul>

              <div className={styles.mcpFsBar}>
                {scope.restricted ? (
                  <>
                    <span className={`${styles.mcpFsScope} ${styles.mcpFsScopeSome}`}>
                      可写 {scope.covered} / {scope.total} 篇
                    </span>
                    {/* 🔴 叫「恢复全库」而不是「清空选择」：后者字面上是「什么都不选」，
                        而它的实际效果是「全库可写」——正好相反。按钮得说它的**结果**。 */}
                    <button
                      type="button"
                      className={styles.mcpFsClear}
                      disabled={busy}
                      onClick={() => void save(null)}
                    >
                      恢复全库
                    </button>
                  </>
                ) : (
                  <>
                    <span className={`${styles.mcpFsScope} ${styles.mcpFsScopeAll}`}>全库可写</span>
                    <span>一个不选也是全库可写</span>
                  </>
                )}
              </div>

              <p className={styles.mcpGuideNote}>
                只限制<b>写入</b>。AI 仍能检索与阅读全库——
                要让它看不到，得关掉上面的 MCP 服务器。
                勾上一个文件夹<b>包含它下面所有层</b>。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
