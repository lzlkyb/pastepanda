/**
 * 接入指引（M4 步骤 4）。默认折叠：配一次就不再看了，常开只是噪声。
 *
 * 两种形式都给，因为用户不一定用哪一种；两者都已对照 Claude Code 官方文档核实
 * （code.claude.com/docs/en/mcp，2026-09-02），**不是凭记忆写的**。
 *
 * 🔴 复制按钮里才带真令牌；屏幕上显示的是占位符——设置页可能被录屏或截图。
 */
import { useState } from "react";
import { ChevronRight, ChevronDown, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/utils";
import styles from "../Settings.module.css";

/** 屏幕上的占位符。真令牌只在点复制时才取（见 lib/api/mcp.ts 头部）。 */
const TOKEN_PLACEHOLDER = "<你的访问令牌>";

/**
 * ❗ `--scope user` 不能省。
 *
 * `claude mcp add` 的默认 scope 是 `local`（已核实：CLI 2.1.233 的 `--help`
 * 写着 `default: "local"`），而 local 只对**执行命令时那一个目录**生效。
 * 知识库跟项目无关，用户在别的目录开 Claude Code 时就**没有这个工具**——
 * 而且不报错，就是静静地不存在，最难查的那种。
 */
function cliGlobal(url: string, token: string): string {
  return `claude mcp add --transport http --scope user pastepanda ${url} \\\n  --header "Authorization: Bearer ${token}"`;
}

/**
 * 仅当前目录。写显式的 `--scope local` 而不是省略：
 * 省略时行为一样（默认就是 local），但看命令的人无从知道它只对这一个目录生效。
 */
function cliLocal(url: string, token: string): string {
  return `claude mcp add --transport http --scope local pastepanda ${url} \\\n  --header "Authorization: Bearer ${token}"`;
}

function jsonConfig(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        pastepanda: {
          // ❗ `type` 不能省：官方文档明写「只有 url 没有 type 的条目是配置错误，会被跳过」
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

export function McpClientGuide({
  url,
  onNeedToken,
  toast,
}: {
  url: string;
  /** 懒取真令牌。只在用户点复制时调。 */
  onNeedToken: () => Promise<string | null>;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [open, setOpen] = useState(false);

  const copyWithToken = async (build: (u: string, t: string) => string, what: string) => {
    const t = await onNeedToken();
    if (!t) return;
    const ok = await copyToClipboard(build(url, t));
    toast(ok ? `${what}已复制（含令牌）` : "复制失败", ok ? "success" : "error");
  };

  return (
    <div className={styles.mcpGuide}>
      <button type="button" className={styles.mcpGuideToggle} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        怎么接进 Claude Code
      </button>

      {open && (
        <div className={styles.mcpGuideBody}>
          <div className={styles.mcpGuideRow}>
            <span>
              方式一：命令行 · <b>全局</b>
              <span className={styles.mcpRecommend}>推荐</span>
            </span>
            <button type="button" onClick={() => void copyWithToken(cliGlobal, "全局配置命令")}>
              <Copy size={12} /> 复制
            </button>
          </div>
          <pre className={styles.mcpCode}>{cliGlobal(url, TOKEN_PLACEHOLDER)}</pre>
          <p className={styles.mcpGuideNote}>
            写进 <code>~/.claude.json</code> 顶层，<b>任何目录下开 Claude Code 都能用</b>。
            知识库跟项目无关，绝大多数时候你要的是这个。
          </p>

          <div className={styles.mcpGuideRow}>
            <span>方式二：命令行 · 仅当前目录</span>
            <button type="button" onClick={() => void copyWithToken(cliLocal, "当前目录配置命令")}>
              <Copy size={12} /> 复制
            </button>
          </div>
          <pre className={styles.mcpCode}>{cliLocal(url, TOKEN_PLACEHOLDER)}</pre>
          <p className={styles.mcpGuideNote}>
            只对执行命令时那个目录生效。换个目录开 Claude Code 就<b>没有这个工具</b>，
            而且不报错——如果你只想在某个项目里用，才选它。
          </p>

          <div className={styles.mcpGuideRow}>
            <span>方式三：手写进 <code>~/.claude.json</code> 顶层 · 全局</span>
            <button type="button" onClick={() => void copyWithToken(jsonConfig, "配置")}>
              <Copy size={12} /> 复制
            </button>
          </div>
          <pre className={styles.mcpCode}>{jsonConfig(url, TOKEN_PLACEHOLDER)}</pre>

          <p className={styles.mcpGuideNote}>
            Windows 上这个文件在 <code>C:\Users\你的用户名\.claude.json</code>，
            把上面的 <code>mcpServers</code> 合进它的<b>顶层</b>（不是某个项目下面）。
          </p>

          <p className={styles.mcpGuideWarn}>
            ⚠ <b>别写进项目里的 <code>.mcp.json</code></b>（也就是别用 <code>--scope project</code>）。
            那个文件的用途就是提交进仓库给团队共享的——
            <b>你的访问令牌会跟着进 git</b>。
          </p>

          <p className={styles.mcpGuideNote}>
            上面显示的是占位符，<b>点「复制」拿到的才是带真令牌的完整内容</b>。
            只监听本机回环地址，同一台电脑上的客户端才连得上。
          </p>
        </div>
      )}
    </div>
  );
}
