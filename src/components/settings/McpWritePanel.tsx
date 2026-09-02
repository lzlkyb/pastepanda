/**
 * MCP 写权限开关（M5）。设计稿：design/知识库MCP写权限-M5-设计稿.html
 *
 * 七个开关按风险分三组：新增 / 修改 / 删除与恢复。
 * 分组由**后端的返回顺序**决定（`WriteKind::ALL` 就是按风险递增排的），
 * 前端只按下面那两个分组点切开——不重新排序，否则两边各有一套风险判断。
 *
 * 收起时标题上就能看到「已关 N 项」：写权限是「它到底能做什么」的答案，
 * 藏起来就没人知道可以关。
 */
import { useCallback, useEffect, useState } from "react";
import { mcpGetWriteSwitches, mcpSetWriteSwitch, type McpWriteSwitch } from "@/lib/api/mcp";
import styles from "../Settings.module.css";

/** 分组点：在哪个配置键之前插一个小标题。 */
const GROUP_AT: Record<string, string> = {
  mcp_write_create: "新增——只增不改，弄不丢已有内容",
  mcp_write_update: "修改——会改变已有笔记与你的组织结构",
  mcp_write_delete: "删除与恢复——都只动回收站，互为逆操作",
};

export function McpWritePanel({
  toast,
}: {
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [rows, setRows] = useState<McpWriteSwitch[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");

  // 收起时标题上也要报「已关 N 项」，所以不能等展开再拉。
  useEffect(() => {
    void mcpGetWriteSwitches().then(setRows);
  }, []);

  const handleToggle = useCallback(
    async (row: McpWriteSwitch) => {
      setBusy(row.key);
      const next = await mcpSetWriteSwitch(row.key, !row.enabled);
      setBusy("");
      // 失败时不动 UI（api 层已弹错，规则 #15.3）：
      // 否则开关看着关了、模型实际还能写。
      if (!next) return;
      setRows(next);
      toast(row.enabled ? `已关闭「${row.label}」` : `已开启「${row.label}」`, "success");
    },
    [toast],
  );

  const offCount = rows.filter((r) => !r.enabled).length;

  return (
    <div className={styles.mcpGuide}>
      <button type="button" className={styles.mcpGuideToggle} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} 写权限
        {rows.length > 0 && (offCount === 0 ? `（${rows.length} 项全开）` : `（已关 ${offCount} 项）`)}
      </button>

      {open && (
        <div className={styles.mcpGuideBody}>
          {rows.length === 0 ? (
            <p className={styles.mcpGuideNote}>读不到写权限开关。</p>
          ) : (
            <>
              {rows.map((r) => (
                <div key={r.key}>
                  {GROUP_AT[r.key] && <div className={styles.mcpSwGroup}>{GROUP_AT[r.key]}</div>}
                  <div className={styles.mcpSwRow}>
                    <span className={styles.mcpSwLabel}>
                      {r.label} <code className={styles.mcpSwTool}>{r.tool}</code>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.enabled}
                      aria-label={r.label}
                      disabled={busy === r.key}
                      className={`${styles.mcpSw}${r.enabled ? "" : ` ${styles.mcpSwOff}`}`}
                      onClick={() => void handleToggle(r)}
                    />
                  </div>
                </div>
              ))}
              {/* 措辞故意不是「需重连才生效」：后者会让用户以为没重连就还能删，
                  而事实相反——调用拦截是即时的，没重连只会让模型白试一次。 */}
              <p className={styles.mcpGuideNote}>
                改完<b>立即生效</b>；但已连接的客户端手里的工具表是缓存的，
                重连后才不会再看到已关的工具。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
