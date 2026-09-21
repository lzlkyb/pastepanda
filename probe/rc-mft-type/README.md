# rc-mft-type —— 硬编 MFT 类型协商探针

**独立工程，不进 pastePanda 依赖树**（照 `probe/iroh` 先例）。`[profile.release]`
与主项目一致，保证耗时数字可比。

## 这个探针解决了什么

真机上远程推流 H.264 硬编**从未启用**，静默退回 JPEG（1fps，编码 1175ms/帧）。
日志只有一行 `[RC] h264 不可用，调用方回退：MF：没有为此流或其所依靠的流设置有效的类型。(0xC00D6D60)`。

这一轮排查用 5 个 bin **逐条实测**，推翻了 3 个静态推断，最终定位 5 条根因
并全部修复（见 `.workbuddy/memory/2026-09-21.md`）。

## 5 个 bin 与它们的职责

按发现顺序排列——**每个 bin 都是因为前一个的结论不够才写的**。

| bin | 回答的问题 | 关键结论 |
|---|---|---|
| `type` | 硬件 MFT 到底存不存在？三种设法为何都失败？ | 4 台硬编 MFT 都在（Intel QSV + NVIDIA NVENC，全 async）；但 `GetInputAvailableType` **遍历 16 次拿不到 NV12** |
| `dump` | 这些 MFT 暴露哪些输入/输出子类型？ | **输入类型列表为空**、输出类型正常；且**先 `SetOutputType` 再 `SetInputType` 就能成功** ← 找到顺序根因 |
| `e2e` | 顺序修正后能一路编出包吗？ | 5 属性输入类型（复刻主仓库）被拒 `0xC00D36B4`；**补 `MF_MT_FRAME_RATE` 后 4 台全通过** |
| `heal` | Intel 首帧抛的 `0xC00D6D61` 能自愈吗？ | **不能**。再协商成功但事件流挂死，重开也一样 → 该 MFT 本身就不可用（据此回退了一段无效代码） |
| `pick` | `slice[0]` 能直接用吗？ | **不能**。枚举序 `[0] Intel QSV（坏）` / `[1] NVIDIA（好）`；且**自造输出类型会污染 MFT 实例** |

## 用法

```bash
cd probe/rc-mft-type

cargo run --release --bin type    # 基础能力 + 三种设法
cargo run --release --bin dump    # 输入/输出类型全貌 + 顺序验证
cargo run --release --bin e2e     # 端到端真编 3 帧
cargo run --release --bin heal    # 运行时流变化自愈验证
cargo run --release --bin pick    # 挑选逻辑验收（枚举 → 去重 → 试编挑选）
cargo run --release --bin pick -- --bench 1   # 干净进程直接开第 2 台压测 30 帧
```

`pick --bench <n>` 的 `n` 是**枚举序**（0-based）。本机 NVIDIA H.264 在索引 1。

## 实测数据（本机，2026-09-21）

| 场景 | 均值 | 帧率 |
|---|---|---|
| NVIDIA H.264 @1920×1080 | 7.15 ms/帧 | 140 fps |
| NVIDIA H.264 @2560×1440 | 10.08 ms/帧 | 99 fps |
| NVIDIA HEVC @1920×1080 | 5.88 ms/帧 | 170 fps |
| JPEG @1920×1080 q70（对照） | 189 ms/帧 | 5.3 fps |
| 真机日志 EMA（JPEG 全链路） | 1175 ms/帧 | ~1 fps |

硬件：NVIDIA RTX 3050 Laptop (`LUID=0x13846`) + Intel UHD Graphics (`LUID=0x13596`)。

## 五条根因（写代码时的判据来源）

1. **枚举不能带输入 subtype 约束**。async 硬编 MFT 在设输出类型前不提供任何
   输入类型，带 NV12 约束 → 枚举 0 台。
2. **必须先 `SetOutputType` 再 `SetInputType`**。
3. **输入类型必须带 `MF_MT_FRAME_RATE`**（5 属性版被拒）。
4. **输出类型用 `GetOutputAvailableType(0)` 的基准改尺寸，不要自造**。
   自造 1440p 会被拒 `0xC00D6D76`，**且失败一次 MFT 实例就进坏状态**
   （后续连正确类型也设不上）——这是最难查的一条。
5. **不能盲取 `slice[0]`**，必须逐台试编。

## ⚠️ 踩过的坑

- **多 bin 工程**：`src/` 下多个文件都要在 `Cargo.toml` 声明 `[[bin]]`，
  否则只有 `main.rs` 会被编译。
- **`--bench` 必须起干净进程**：同进程内先跑过试编（1080p 开流喂帧）后，
  再对同一 MFT 设 1440p 类型会失败——**这是探针内的干扰，不是主仓库问题**
  （对照实验：不做任何试编直接开，同样失败；而 1080p 同进程内可跑满 30 帧）。
- **事件泵不能把 `NeedInput` 抽干**：抽掉的是**下一帧**要用的，会导致
  「第二帧起永远超时」。收帧时一旦拿到 `HaveOutput` 就 `break`。
- **windows-0.58 API 差异**：`CreateDXGIFactory1()` 返回 `Result` 无参数；
  `SetInputType(0, None, 0)` 用 `None` 而非裸指针；
  `GetString` 需要 `(&ATTR, &mut [u16], Option<*mut u32>)` 三参数。
