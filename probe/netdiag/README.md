# probe/netdiag — iroh 打洞效果单机探针（R0-3）

> 2026-10-15。对应 `docs/远程电脑-打洞升级决策-自建预测注入与TUN-2026-10-15.md` 的
> R0「诊断出口 + 打洞效果实测」。与主工程同 iroh 1.1（共享 cargo 缓存），不接主工程。

## 判据（跑之前写死，别跑完再想看什么）

1. **UDP 可用性**：QAD IPv4/IPv6 各有没有回程（`udp_v4`/`udp_v6`）。
2. **对称 NAT 判定**：`mapping_varies_by_dest_ipv4/v6`——对多个 n0 relay 分别
   QAD 探测，公网映射是否随目的变。`Some(true)` = 对称 = **iroh 直接放弃直连**，
   恒走中继（这是「iroh 打洞不行」的第一根因，iroh 1.1 无端口预测）。
3. **relay 延迟表**：到各 n0 relay 的 QAD/HTTPS 延迟——决定打洞失败时中继的慢。
4. **UPnP portmapper**：本机路由器有没有给 iroh socket 映射端口
   （`watch_addr` 里的 direct addrs 有没有非局域网项）。
5. **结论输出**：DirectLikely / DirectPossible / RelayOnly / UdpBlocked / Captive
   （与主工程 `shared_ep::diagnostics::punch_verdict` 同一规则，手工对照）。

## 运行

```bash
cd probe/netdiag && cargo run --release
# 输出 JSON + 判定；跑 2-3 次看 mapping 判定是否稳定
```

## 双端实测（真正的打洞）

单机只能出「网络画像」；直连成不成要两台设备两个网络（例：家里 WiFi + 手机热点）：

1. 两台各跑 `cargo run --release -- <对端 node id>`（node id 在输出第一行）；
2. 观察双方 `watch_addr` 里的 direct addr 列表与连接后的 `ConnType`
   （`ep.connections()` → `conn.conn_type()`：`Direct` / `Relay` / `Mixed`）；
3. 想钉住「对称 NAT 打洞必败」，把对端放到手机热点（常见 CGNAT/对称域）跑一遍。

```bash
# A 机
cargo run --release
# B 机
cargo run --release -- <A机的node_id>
```

带参模式：拨对端并保持 60s，期间每 5s 打印路径类型（direct/relay）与 RTT 估算。

## 结果（2026-10-15 首跑，用户本机 222.244.115.67 / 移动宽带）

```
udp_v4=true  udp_v6=false（IPv6 不通）
mapping_varies_by_dest_ipv4 = Some(true)   ← 两轮报告稳定一致
relay: usw1 196ms / euc1 205ms / use1 226ms（全海外）
>> 判定: RelayOnly — 对称 NAT：iroh 会放弃直连、恒走中继
```

**结论**：
1. 「iroh 打洞不行」根因实锤——本机 NAT 对不同目的分配不同公网端口
   （对称域），iroh 1.1 检测到后**直接放弃直连**，所有会话恒走 n0 海外
   中继（196-226ms）。R1a（端口预测注入）正是对症药，本机必然受益。
2. 注意 `global_v4` 端口 = 本地端口（49683）——NAT 有**端口保持**倾向，
   p2wlan 式端口建模/预测在这种 NAT 上命中率高，进一步支撑 R1a。
3. R1b 收益同步实锤：直连不可期时，中继延迟就是会话延迟，自建国内
   relay 可把 196ms → <40ms。
4. IPv6 不通（udp_v6=false）——运营商 IPv6 可用时是额外的直连通道，
   可排查路由器/光猫 IPv6 设置。
