# 规则源已合并到 `AGENTS.md`（本文件不再维护副本）

2026-09-26 那次规则精简只落在 `AGENTS.md` 上，本文件停在旧版，并且**整条「规则 20 桌面 dev 与 Android 构建并行、target 目录隔离」都不存在**。
两份文件各说一套时，按 `claude.md` 干活的人会漏掉这条规则，直接后果是 Android 构建与桌面 dev 抢同一把 cargo 构建锁、互相杀进程。
所以这里只留指针，不留第二套规则。

@AGENTS.md

- 用 Claude Code：它读 `CLAUDE.md`（本文件），上面的 `@AGENTS.md` 会把规则正文引进来。
- 用其他工具（Cursor / Windsurf / Codex / Qoder）：直接把 `AGENTS.md` 设为规则源。
- 已完成（2026-10-09）：本文件在 git 里原本是小写 `claude.md`，区分大小写的系统上（macOS 的 APFS 默认敏感 / Linux）Claude Code 找不到规则入口。规范化成 `CLAUDE.md` 需要一次只改大小写的 `git mv`，而 Windows 侧 `core.ignorecase=true` 会让单步改名变成 no-op，实测配方是两步：`git mv claude.md claude.md.tmp && git mv claude.md.tmp CLAUDE.md`。
