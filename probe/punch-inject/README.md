# probe/punch-inject — iroh 1.1.0 候选注入机制探针（R1a 验证门）

> 2026-10-15。锁定 `iroh =1.1.0`（与主工程 `src-tauri/Cargo.lock` 一致；写 `"1.1"` 会
> 解析到 1.3.0，API 行为已实测不同）。判据与结论如下。

## 背景

R0（`probe/netdiag`）实测定论：用户本机对称 NAT（mapping varies by dest），
iroh 恒走 n0 海外 relay，「打洞不行」根因实锤；NAT 有端口保持倾向 → R1a
端口预测注入对症。R1a 的唯一未知关卡 = **注入候选会被 magicsock 探测**。
本探针在单机双 Endpoint 上验证机制（无 NAT，不验证打洞效果）。

## 源码考证（iroh-1.1.0，`src/socket/`）

1. **MemoryLookup 注入只进 `paths` 表**，喂 `resolve_remote` 应答（dial 前有路径就成功）；
2. `trigger_address_lookup` 有 **`selected_path.is_some()` 守卫**（remote_state.rs:867）
   ——连接建立后 lookup 基本不再被查询；且 MemoryLookup::resolve 返回单 item
   stream，发完即止，后注入的候选不会再被拉取；
3. 60s `check_connections`（UPGRADE_INTERVAL）只触发 **QNT holepunching**，
   候选 = 双方 magicsock 的 `local_direct_addrs`（应用无注入口）；
4. **QUIC Initial 的消费机制**：dial addr 里的候选（Ip/Relay/Custom）经
   `handle_msg_resolve_remote` 进 `paths` 表；Initial 发往虚拟地址
   `EndpointIdMappedAddr`（fd15:70a:510b::/64）→ `TransportsSender::poll_send`
   Mixed 分支 → `RemoteStateMessage::SendDatagram` → 无 selected_path 时
   **对 paths 表全部候选逐个发包**（跳过本机自身地址）。
   **⇒ dial-time 候选是「Initial 泛洪到所有已知路径」，不是精确探测。**
5. `unstable-custom-transports`（unstable feature）= 完整数据面注入口：
   `CustomTransport/CustomEndpoint/CustomSender`，QUIC 包直通（Transmit/RecvMeta），
   官方 `examples/custom-transport.rs` + `src/test_utils/test_transport.rs` 为范本。

## 实验

| 实验 | 配置 | 判据 |
|---|---|---|
| E0 | 官方 TestNetwork（in-memory），dial 带 Custom addr | 连接建立 + custom path selected + echo |
| E1 | presets::N0，dial [Ip(127.0.0.1:port), Relay] / [Relay] | IP path 是否立即出现 |
| E2 | Minimal + RelayMode::Default + MemoryLookup 唯一地址源 | relay-only 建立后注入，130s 升级 / 重 dial 是否吃到 |
| E3 | 真实 UDP socket 包装成 CustomTransport，dial Custom addr | 连接 + echo |

## 当前结论（2026-10-15）

- **E0 ✅ 官方 TestTransport 直连成功**：dial 带 Custom addr → custom path
  selected（rtt ~4.5ms）→ 数据往返。**⇒ CustomTransport 官方口子真实可用，
  旁路打洞 socket 挂进 iroh 的路径成立（R1b/R2 技术底座）**。
- **E3 ✗ 待查**：我的 UdpCustomTransport 下 Initial 发出（A 端
  `sending datagram to all known paths paths=[Custom(..)]`）且 B 端收到
  （`datagram received src=Custom(..) len=1200`），但 **B 端 noq 零响应**
  （无 server handshake 日志、不回包）。同配置下 3c（dial [Ip]）也超时，
  E0（同配置官方 transport）通 —— 已排除 endpoint 配置与 RecvInfo.local
  差异（已对齐），剩余嫌疑在我的 poll_recv/poll_send 细节与官方
  TestTransport 的未对齐项。**B 端「收到包但 noq 静默」是核心线索**。
- **E1/E2 未完成**：当晚 n0 relay 握手超时（`Failed to handshake with relay
  server: Ping timeout`，HTTP 200 但 WS 不通），实验无法进行。网络恢复后
  重跑（直接 `cargo run -- E1` / `-- E2`）。
- 同机注意：dial IP 候选必须 `127.0.0.1`（Windows 防火墙默认拦非 loopback
  入站 UDP；dial 10.x 本机地址会超时误判）。

## R1a 路线影响（初步）

- 源码层面：**「建立连接后靠 MemoryLookup 注入候选」不成立**（守卫 2/3）。
  dial-time 候选是 Initial 泛洪，可用但粗糙（每次重 dial 才触发）。
- **更有前途的路径是 CustomTransport**（E0 已证可行）：打洞 socket 直接作为
  数据面，iroh 无感知；候选发现/打洞完全由旁路栈（p2wlan detection+mapping）
  自主控制。原决策文档的 R1a（预测注入）与 R2（数据面迁移）可以在此汇合。
- 待 E1/E2 出数后补最终判据。
