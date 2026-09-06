/**
 * McpCustomConnect —— 自定义接入（接入流程的第 4 步）。
 *
 * # 为什么必须有这一条路
 *
 * 内置名单永远穷举不完。没有这一块的话，名单外的工具只能让用户自己
 * 去找配置文件、自己拼 JSON——而那正是最容易把令牌散得到处都是、把 transport
 * 写错的环节。
 *
 * # 🔴 跟内置客户端走的是同一套后端
 *
 * `mcp_client_connect` 本来就只收「路径 + 条目」，不认哪家客户端，
 * 所以后端一行没改：`.json` 后缀校验、解析不开就一个字不改、先备份、
 * 只动 `mcpServers.pastepanda` 、原子写——四道门对自定义路径一样生效。
 *
 * ❗ transport 选择器不能省。各家写法不一致（见 `MCP_TRANSPORTS` 的实测分布），
 *   而**写错一个字不报错，只会让客户端静静地连不上**。
 */
import { useCallback, useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "@/lib/confirm";
import { logger } from "@/lib/logger";
import { usePersistedState } from "@/hooks/usePersistedState";
import {
  MCP_ENTRY_NAME,
  MCP_TRANSPORTS,
  buildMcpConfigJson,
  buildMcpEntryForConnect,
  type McpEntryShape,
  type McpTransport,
} from "@/lib/mcpClients";
import {
  mcpClientProbe,
  mcpClientConnect,
  mcpClientDisconnect,
  type McpClientProbe,
} from "@/lib/api/mcp";
import { TOKEN_PLACEHOLDER } from "./McpClientRow";
import styles from "../Settings.module.css";

/** 记住用户上次选的路径与写法：下次打开设置能直接看到它现在接没接入。 */
const KEY_PATH = "mcp.customConfigPath";
const KEY_TRANSPORT = "mcp.customTransport";

export function McpCustomConnect({
  url,
  toast,
}: {
  url: string;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [path, setPath] = usePersistedState<string>(KEY_PATH, "");
  const [transport, setTransport] = usePersistedState<McpTransport>(
    KEY_TRANSPORT,
    "streamableHttp",
  );
  const [probe, setProbe] = useState<McpClientProbe | null>(null);
  const [busy, setBusy] = useState(false);

  // ❗ 不能把它当依赖传给 useCallback：对象字面量每次渲染都是新引用，
  //   那样 useCallback 等于白写。下面一律依赖 `transport` 并在用到时现拼。
  const shape: McpEntryShape = { transport };

  const refresh = useCallback(async (p: string) => {
    setProbe(p ? await mcpClientProbe(p) : null);
  }, []);

  // 地址变了（换端口）同样要重探：已写入的条目会从 current 变成 stale。
  useEffect(() => {
    void refresh(path);
  }, [refresh, path, url]);

  const pickFile = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "MCP 配置", extensions: ["json"] }],
      });
      if (typeof picked === "string") setPath(picked);
    } catch (e) {
      // 选文件失败是用户能看懂的操作，不能静默（规则 #15.3）
      logger.error("选择 MCP 配置文件失败", e);
      toast("打不开文件选择器", "error");
    }
  }, [setPath, toast]);

  const doConnect = useCallback(async () => {
    if (!path || !probe) return;
    const ok = await confirmDialog({
      title: "接入到这个配置文件？",
      message:
        `将修改：\n${probe.path}\n\n` +
        `• 修改前会先备份一份（同目录，文件名带 pastepanda-bak）\n` +
        `• 只添加/更新 mcpServers 里名为 「${MCP_ENTRY_NAME}」 的那一条\n` +
        `• transport 写法：${transport}\n` +
        `• 会把本机的访问令牌写进去` +
        (probe.exists ? "" : "\n• 该文件目前不存在，会新建") +
        `\n\n⚠ 这是你自己指定的文件，请确认它确实是那个工具的 MCP 配置。`,
      confirmText: "接入",
    });
    if (!ok) return;

    setBusy(true);
    try {
      const r = await mcpClientConnect(path, buildMcpEntryForConnect({ transport }, url));
      if ("err" in r) {
        toast(r.err, "error", 8000);
        return;
      }
      toast(r.ok.backup ? "已接入（旧配置已备份）" : "已接入（新建了配置文件）", "success", 6000);
      await refresh(path);
    } finally {
      setBusy(false);
    }
  }, [path, probe, transport, url, toast, refresh]);

  const doDisconnect = useCallback(async () => {
    if (!path || !probe) return;
    const ok = await confirmDialog({
      title: "从这个文件移除接入？",
      message:
        `将删掉名为 「${MCP_ENTRY_NAME}」 的条目：\n${probe.path}\n\n` +
        `删除前会先备份，其他服务器与配置原封不动。`,
      confirmText: "移除",
      variant: "danger",
    });
    if (!ok) return;

    setBusy(true);
    try {
      const r = await mcpClientDisconnect(path);
      if ("err" in r) {
        toast(r.err, "error", 8000);
        return;
      }
      toast(r.ok.replaced ? "已移除" : "这个文件里本来就没有接入", "success");
      await refresh(path);
    } finally {
      setBusy(false);
    }
  }, [path, probe, toast, refresh]);

  const connected = probe?.state === "current";

  return (
    <details className={styles.mcpAdvanced}>
      <summary>列表里没有你用的工具？自定义接入</summary>

      <div className={styles.mcpRows}>
        <div className={styles.mcpRow}>
          <span className={styles.mcpLabel}>配置文件</span>
          <code className={styles.mcpValue}>{probe?.path || path || "尚未选择"}</code>
          <button type="button" className={styles.mcpIconBtn} title="选择 .json 配置文件"
            onClick={() => void pickFile()}>
            <FolderOpen size={13} />
          </button>
        </div>

        <div className={styles.mcpRow}>
          <span className={styles.mcpLabel}>transport</span>
          <select
            className={styles.mcpSelect}
            value={transport}
            onChange={(e) => setTransport(e.target.value as McpTransport)}
          >
            {MCP_TRANSPORTS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.value} — {t.hint}
              </option>
            ))}
          </select>
        </div>

        {path && (
          <div className={styles.mcpRow}>
            <span className={styles.mcpLabel}>当前状态</span>
            <span className={styles.mcpValue}>
              {!probe
                ? "检测中…"
                : probe.state === "current"
                  ? "已接入"
                  : probe.state === "stale"
                    ? "接入过，但令牌或地址已变更"
                    : probe.state === "unreadable"
                      ? "配置读不了"
                      : probe.exists
                        ? "未接入"
                        : "文件不存在（接入时会新建）"}
            </span>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={busy || probe?.state === "unreadable"}
              onClick={() => void (connected ? doDisconnect() : doConnect())}
            >
              {connected ? "移除接入" : probe?.state === "stale" ? "重新接入" : "接入"}
            </button>
          </div>
        )}
      </div>

      {probe?.state === "unreadable" && (
        <p className={styles.mcpGuideWarn}>⚠ {probe.detail}</p>
      )}

      {/* 写入前预览。改别人的文件前，至少得让人看到要写什么——
          尤其是这条路上文件是用户自己挑的，没有内置名单兼当校验。 */}
      <div className={styles.mcpGuideRow}>
        <span>将写入的内容（预览）</span>
      </div>
      <pre className={styles.mcpCode}>{buildMcpConfigJson(shape, url, TOKEN_PLACEHOLDER)}</pre>
      <p className={styles.mcpGuideNote}>
        预览里是占位符，<b>实际写入时由后端换成真令牌</b>（令牌不经过界面）。
        写入完全走与内置客户端同一套流程：先备份、只动自己那一条、解析不开就不改。
      </p>
    </details>
  );
}
