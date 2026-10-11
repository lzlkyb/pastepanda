# macOS Codex MCP 接入修复与验收

2026-10-11。本次不递增版本，不发布 GitHub Release。

## 已实施

- 为本机 Codex 的 `~/.codex/config.toml` 增加 `pastepanda`，使用认证 HTTP `http://127.0.0.1:17650/mcp`。用户明确授权完整笔记读写；既有 `node_repl`、`vault` 和其余设置经过 TOML 语义比对保留。修改前已备份，配置和备份权限为 0600。访问令牌由应用的一键接入写入，不进入仓库或报告。
- MCP 未运行时也展示启动错误。旧组件把错误藏在只在运行时挂载的面板中，导致开启失败看起来没有反应。
- Mac 调试包签名变化会造成钥匙串 `-25293`。启动、轮询、后台加密和 stdio 读取仍采用非交互策略；仅用户主动开启 MCP 时允许系统验证原有密钥的访问。后台线程执行验证，缓存锁串行化该过程，完成、取消、拒绝后均恢复非交互策略。验证不新建、不覆盖现有密钥。
- HTTP JSON-RPC 通知改为 `202 Accepted` 且无正文。原来的 `200` 加 `id:null` JSON 响应导致真实 Codex 在 `notifications/initialized` 阶段关闭传输。鉴权照常执行，有显式 `id:null` 的请求仍返回正常 JSON 响应。

## 验证证据

- `McpTab.test.tsx`：修复前失败、修复后通过，钉住服务未运行时的错误可见性。
- `macMcpKeychainConsent.test.ts`：修复前失败、修复后通过，钉住主动开启与后台授权策略的隔离；和上述用例、流程图颜色守卫共 4 项通过。
- `node scripts/macos-keychain-check.mjs`：运行从真实原生源码提取的函数，以假 Security 调用验证成功、取消、拒绝、密钥不存在、错误长度和策略设置失败；不读取用户钥匙串。
- 真 HTTP 路由的通知用例：修复前 `200 != 202`，修复后通过；同时覆盖未授权 401、未知通知空 202 和显式空 id 的正常请求。
- `cargo test --lib mcp::`：216 通过，1 忽略。并非全库复测。
- 定向 ESLint、UI 规则检查通过（block 0）；Universal 调试包完成 TypeScript、Vite、arm64、x86_64 编译，应用签名校验通过。
- 对前一构建已验证本机服务监听 `127.0.0.1:17650`，未开启 LAN 或 HTTPS。真实 Codex 暴露了上述握手缺陷，不能把应用的“已接入”徽标当成客户端验收成功。

## 实际客户端验收及剩余阻塞

用户完成系统验证后，最终包通过真实 Codex app-server 的 MCP 调用验收：发现 23 个工具；专用测试笔记的新建、读取、追加、全文修改、搜索、移入回收站和恢复均通过。12 次调用全部进入审计（11 次成功、1 次预期的已删除笔记读取拒绝）。测试笔记最终移入回收站，可恢复。没有调用模型或把笔记上传云端。

正常退出并重开同一包后，后台读取仍返回 `-25293`，服务没有恢复；因此当前不能宣称持续可用。只读检查确认钥匙串内部的签名 partition 仍只有旧构建的 cdhash。另建的隔离测试钥匙串验证三种非交互查询均能读取自己创建的假密钥，清理后原搜索列表完全一致；没有读取或改动用户真实密钥。

已准备仅追加最终 Universal 包两项精确 cdhash 的修复：保留既有 partition、原密钥和其他 ACL，不开放 `apple:` 等应用类别；执行前校验包未改变及应用路径已被明确允许。Apple `security set-generic-password-partition-list` 使用账号、服务、标签和登录钥匙串路径同时限定唯一目标，省略 `-k`，由用户在官方隐藏密码提示中亲自验证。桌面工具禁止操作系统认证窗口及 Terminal，用户完成保存应用访问和该修复后仍需再做重启回归。此步骤尚未标为成功。

调试包位置：`outputs/macos/mcp-codex-7.2.11/PastePanda.app`（本次 Codex 工作目录的 outputs 下）。录屏、麦克风授权与本次 MCP 验证独立，不沿用旧包的权限验收结果。

## 运行与回退

保持最终 PastePanda 应用运行，Codex 通过本机 HTTP 访问。当前客户端配置无需依赖 stdio 子进程的钥匙串访问；stdio 在本机已测试失败，没有宣称修复。

重建 ad-hoc 调试包可能再次改变钥匙串认可的身份。若启动后 MCP 未运行，可在设置 → MCP 主动开启，并在系统窗口确认该应用的密钥访问。不要开放所有应用访问、删除原密钥、关闭加密或把密码写入命令行。

关闭设置 → MCP 的服务开关可停止访问。要撤销客户端接入，在应用的 Codex 接入卡中移除 `pastepanda`；应用会先备份配置，只移除该条目。

规范依据：[MCP Streamable HTTP 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)；Codex 配置依据：[官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
