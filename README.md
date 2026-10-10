# releases 分支（Gitee 更新通道的 manifest 载体）

这条分支只放两样东西：`latest/updater-gitee.json`（桌面）与 `latest/apk-update-gitee.json`（手机）。
它们由 CI 生成，客户端读的公开地址是 Gitee 镜像的
`https://gitee.com/<repo>/raw/releases/latest/<name>`。

为什么这条分支必须存在于 GitHub：Gitee 仓库挂的是 Pull 方向的仓库镜像，
同步按上游分支集合对齐，**上游没有的分支会被剪掉**。所以 manifest 的真源放在
Gitee 侧的孤儿分支上等于每推一次 GitHub 就把自己删一次。分支在这里，镜像就会
把它原样搬过去（同步由 push 触发，实测秒级完成）。

不要手工编辑本分支内容：manifest 是派生物，改一次就得重新签名核对。
生成与校验逻辑见 `scripts/repair-gitee-channel.mjs`。

同步验证：本行由第二次推送加入，用来钉住「镜像会搬运内容更新，不只是建一次分支」。
