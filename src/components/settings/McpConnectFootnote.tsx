/**
 * McpConnectFootnote —— 接入面板底部那几句说明。
 *
 * 从 `McpConnectPanel` 拆出来是因为面板本身到了单文件长度上限（规则 #7）。
 * 这几句全是「不写就会被用户误解」的话，所以集中一处放：以后加一种接入方式，
 * 要补的口径在同一段里就能看全（规则 #11.1 的那个道理）。
 */
import { TOKEN_PLACEHOLDER } from "./McpClientRow";
import styles from "./Mcp.module.css";

export function McpConnectFootnote({
  lanOn,
  copyMode,
}: {
  /** 局域网直连开着吗（开着才允许把复制切到局域网地址）。 */
  lanOn: boolean;
  copyMode: "local" | "lan";
}) {
  return (
    <>
      <p className={styles.mcpGuideNote}>
        一键接入会先备份对方的配置文件，且<b>只动其中属于本软件的那一条</b>。
        一键写入永远用本机地址；复制可选本机/局域网。
      </p>
      <p className={styles.mcpGuideNote}>
        展开后显示的是占位符 <code>{TOKEN_PLACEHOLDER}</code>，
        <b>点复制拿到的才是带真令牌的完整内容</b>。
        {/* 🔴 这句例外必须贴在上一句旁边，不能另起一段：stdio 那一类条目里压根
            没有令牌，「点复制拿到带真令牌的内容」对它不成立。分开写的话用户读完
            前半句就已经形成预期，会以为复制漏了什么，进而往 stdio 条目里手加一个
            `headers`——那恰恰是 stdio 客户端不认的键。 */}
        <b>Claude Desktop 那种 stdio 接入例外</b>：它复制出去的是本程序的绝对路径
        与一个启动参数（客户端把本程序当子进程起，由这个子进程去连本机服务），
        <b>里面没有令牌</b>。
        {lanOn
          ? "选「局域网」时，把复制的内容粘到远程机器上即可接入。"
          : "默认只监听本机回环地址；若要远程接入，请先在下方打开局域网访问。"}
      </p>
      {!lanOn && (
        <p className={styles.mcpGuideWarn}>
          ⚠ 别把它写进项目里的 <code>.mcp.json</code>（也就是别用
          <code>--scope project</code>）——那个文件是提交进仓库给团队共享的，
          <b>你的访问令牌会跟着进 git</b>。
        </p>
      )}
      {lanOn && copyMode === "lan" && (
        <p className={styles.mcpGuideWarn}>
          ⚠ 若用 <code>--scope project</code> 复制命令，注意项目配置若会进 git，
          <b>令牌也会跟着提交</b>。团队仓库请改用 <code>user</code> scope 或本地私有配置。
        </p>
      )}
    </>
  );
}
