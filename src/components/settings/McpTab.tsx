/**
 * McpTab.tsx — 设置·MCP（A-61 ③ 从 GeneralTab 搬出）。
 *
 * 为何单独成 tab：
 * ① 它原先在 `GeneralTab.tsx` 的**第 920 行**（一个 1300+ 行文件的第 920 行），
 *   而用知识库的人要为它一直往下翻；中栏「⋯」菜单现在能直接跳到这一页。
 * ② 🟢 **还减了轮询**：`SettingsDialog` 的 tab 是**条件渲染**的
 *   （`activeTab === "general" && (...)`）。放在 general 里时，一打开设置页就开始 5s 轮询
 *   —— 哪怕用户只是来调个主题。搬出来之后只有真去看 MCP 才挂载 `useMcpServer`。
 *
 * ❗ `useMcpServer` 在全应用里**只能有一个实例**：它带 5s 轮询、
 *   `mcp-start-failed` 事件监听、以及一个「从成功转失败才提示一次」的 `wasOkRef`。
 *   两个实例会各自弹一次 toast——这也是不把面板再塞进一个弹窗的原因。
 *
 * 🔴 红线：服务只监听 127.0.0.1；每个请求要带令牌；删除只进回收站；
 *   写入全部计入调用记录；七项写权限默认全开但可逐项关。
 */
import { useCallback } from "react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { useMcpServer } from "@/hooks/useMcpServer";
import { ToggleRow } from "./ToggleRow";
import { McpServerPanel } from "./McpServerPanel";
import styles from "../Settings.module.css";

export function McpTab() {
  const { toast } = useToast();
  // 轮询 / 可见性门控 / 启动失败事件都在 hook 里。
  const mcp = useMcpServer(toast);

  /**
   * 开启前先弹确认，关闭不弹。
   *
   * **每次开启都弹，不只首次**：记「首次」要新增一个持久化标志，
   * 而那个标志一旦写错或被重置，后果是「静默地把全部笔记开放出去」。
   * 开启本来就是个低频动作，多确认一次的代价远小于那个风险。
   *
   * confirmDialog 只吃纯字符串（无富文本），所以后果只能靠句子本身说清楚。
   */
  const handleToggleMcp = useCallback(
    async (next: boolean) => {
      if (next) {
        const ok = await confirmDialog({
          title: "开启知识库 MCP 服务？",
          message:
            "开启后，本机任何能拿到访问令牌的程序都可以读取、修改和删除你的笔记。服务只监听 127.0.0.1，局域网内其它机器连不上。删除只进回收站，随时可恢复；每次写入都会计入调用记录。开启后可以在面板里逐项关掉写权限。",
          confirmText: "开启服务",
          variant: "warning",
        });
        if (!ok) return;
      }
      await mcp.setEnabled(next);
    },
    [mcp],
  );

  return (
    <>
      <div className={styles.sSection}>知识库 MCP 服务</div>
      <ToggleRow
        icon="🧩"
        gradient="linear-gradient(135deg, #8B5CF6, #6366F1)"
        label="知识库 MCP 服务"
        desc="让 Claude Code 等 AI 工具读写你的笔记（仅本机，需令牌，写权限逐项可关）"
        value={mcp.status.running}
        tooltip="在本机开一个只监听回环地址的 MCP 服务，AI 工具凭令牌搜索、读取与修改笔记"
        detailTitle="知识库 MCP 服务"
        detail={
          <>
            <p>
              开启后，Claude Code 这类支持 MCP 的工具可以
              <b>搜索、读取、新建、修改你的笔记</b>。
            </p>
            <p>📌 只监听 <b>127.0.0.1 回环地址</b>，局域网内其它机器连不上</p>
            <p>📌 每个请求都要带<b>访问令牌</b>，令牌加密存在本机</p>
            <p>📌 删除<b>只进回收站</b>（可恢复）；修改会自动留版本快照；写入都计入调用记录</p>
            <p>📌 七项写权限<b>默认全开，可逐项关掉</b>（开启后在下方面板里）</p>
            <p>⚠️ 开着时，<b>能拿到令牌的程序就能读写你全部的笔记</b></p>
          </>
        }
        onChange={(v) => void handleToggleMcp(v)}
      />
      {/* 关态只有上面那一行开关；开了才展开面板（同 LanSyncPanel 的做法）。 */}
      {mcp.status.running && (
        <McpServerPanel
          status={mcp.status}
          busy={mcp.busy}
          startError={mcp.startError}
          auditError={mcp.auditError}
          onSetPort={mcp.setPort}
          onDismissError={mcp.dismissError}
          onDismissAuditError={mcp.dismissAuditError}
          toast={toast}
        />
      )}
    </>
  );
}
