# M6 传输层探针（iroh 1.1.0）

**独立工程，不参与 pastePanda 的构建。** 收在仓库里是为了留住方法——
M3 那次探针只扫了静态库符号就标 PASS，实际没跑过一次推理；
所以这一份**真建两个端点、真连一次、真收发一个字节**。

```bash
cargo run              # debug
cargo run --release    # 🔴 release 也要跑，见下
cargo build --release  # 量体积：对比 iroh-probe.exe 与 baseline.exe
```

## 2026-09-04 结果

| 验的事 | 结果 |
|---|---|
| 离线局域网直连（relay 关 + 地址发现全关，仅凭 IP:port） | ✅ 成立 |
| iroh 净增体积 | **3.94 MB**（基线 208 KB → 4.14 MB，同一工程同一套 release 参数）|
| P1 的 32 字节种子能否直接喂给 `SecretKey::from_bytes` | ✅ 能，身份不用换 |

## 三条会改设计的发现

1. **iroh 1.1 没有内置局域网发现**。`PkarrPublisher` / `PkarrResolver` /
   `DnsAddressLookup` 全走 n0 的 DNS，都要联网。「关 relay」≠「不联网」。
   → 邀请码的 `addrs` 字段是**必需**的。
2. **`NodeId` → `EndpointId`，`NodeAddr` → `EndpointAddr`**（1.x 改名）。
3. **debug 过了不算过**：第一版 debug 通过、release 失败（`closed by peer: 0`），
   因为 `send.finish()` 不等对端收到。这类关闭时序 bug 只在优化后现形。

## 两个栽过的坑（源码注释里也有）

- `bound_sockets()` 返回**通配地址** `0.0.0.0`，往它拨号必然超时
- `Endpoint` 一 drop 就关连接 → 给 task 要 `clone()` 而不是 `move`

## 运维事实

iroh 拖 ~270 个 crate。直连 `static.crates.io` 反复 30s 超时、卡在 145 个不动；
`rsproxy.cn`（0.67s 可达）一次拉完。本工程的 `.cargo/config.toml` 只作用于自己，
**没动全局配置**。
