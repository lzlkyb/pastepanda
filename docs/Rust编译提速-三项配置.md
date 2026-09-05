# Rust 项目编译提速：三项配置

> 可直接把本文贴给其它 AI 执行。来源：PastePanda 在2026-09-05 的实测与落地。
>
> 🔴 **不要照抄数值**。下面每项都给了判据与测量命令，先量再定值。
> 尤其是 `jobs`，照抄别人机器的数字可能把机器跑到蓝屏（本项目就蓝屏过一次）。

---

## 0. 先判断适不适用

| 条件 | 说明 |
|---|---|
| Rust 项目，依赖较多 | 依赖少于 ~100 个时收益有限 |
| 第②项需 Windows + MSVC 工具链 | 其它平台见第②项末尾的说明 |
| 痛点是「改一行代码要等很久」 | 如果慢在依赖下载或 CI，本文不对症 |

先量基线，改完才能比：

```bash
# 依赖规模
grep -c '^name = ' Cargo.lock

# 基线：全量（先 touch 一下主入口以免命中缓存）
cargo clean && time cargo test --lib

# 基线：增量（这才是日常循环的真实代价）
touch src/lib.rs && time cargo test --lib
```

---

## ① 关掉依赖的调试信息（通常收益最大，风险最低）

很多项目的 `Cargo.toml` 里**根本没有 `[profile.dev]`**，用的是 Rust 默认
`debug = true`——于是每一个依赖都带完整调试信息，而这些信息每次链接都要处理一遍。

```toml
# Cargo.toml
[profile.dev]
debug = "line-tables-only"   # 自己的代码：保留行号

[profile.dev.package."*"]
debug = false                # 所有依赖：不带调试信息
```

**为什么分两条写**：

- 自己的代码用 `line-tables-only`——**panic backtrace 的行号照常准**，
  只是没了变量/类型信息。真要单步调试时临时改回 `true` 即可。
- 依赖直接 `false`——你几乎不会单步进第三方库，但它们的调试信息占了大头。

**代价**：用调试器单步进依赖时看不到变量。如果项目真需要调依赖，
把那一个包单独开回来：

```toml
[profile.dev.package.some-crate]
debug = true
```

---

## ② 换 lld 链接器

```toml
# .cargo/config.toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-Clinker-features=+lld"]
```

**先验证当前工具链支持**（不要假设）：

```bash
# 这个 flag 在稳定版可用吗？
rustc -C help | grep linker-features

# rust-lld 在不在？（随工具链分发，不用额外装）
ls ~/.rustup/toolchains/*/lib/rustlib/*/bin/rust-lld*
```

两者都有才能改。本项目实测环境：rustc 1.96.0 / LLD 22.1.2。

**其它平台**：

| 平台 | 做法 |
|---|---|
| Linux | 装 `mold` 或 `lld`，`rustflags = ["-Clink-arg=-fuse-ld=mold"]`。mold 通常比 lld 更快 |
| macOS | 新版 Xcode 自带的 ld 已经很快，收益有限 |
| Windows GNU | 不是上面那个 target 名，要改成 `x86_64-pc-windows-gnu` |

---

## ③ 限住构建并行度（这一项是**安全**，不是提速）

cargo 默认用**逻辑核数**做并行度。内存跟不上的机器上这是灾难：

> 🔴 本项目实例：16 逻辑核 / 8 物理核 / 15.8GB 内存。默认 `-j 16` 起 16 个 rustc，
> 每个吃 0.5～1.5GB，再叠上链接峰值与并行的 git push 传输，**直接把机器跑蓝屏**。

```toml
# .cargo/config.toml
[build]
jobs = 6
```

**怎么定这个值（必须自己量）**：

```bash
# Windows
powershell -NoProfile -Command "\$c=Get-CimInstance Win32_ComputerSystem; \$p=Get-CimInstance Win32_Processor; '逻辑核=' + \$p.NumberOfLogicalProcessors + ' 物理核=' + \$p.NumberOfCores + ' 内存GB=' + [math]::Round(\$c.TotalPhysicalMemory/1GB,1)"

# Linux / macOS
nproc; free -g 2>/dev/null || sysctl hw.memsize
```

取 **`min(物理核数, 内存GB ÷ 2.5)`**，向下取整。
依据：一个 rustc 峰值约 1～1.5GB，再给链接阶段和系统留余量。
本项目：`min(8, 15.8/2.5=6.3) = 6`。

⚠ 这个值跟着仓库走，**换机器开发时要重估**。可以写进注释提醒。

---

## 验证

改完**第一次会全量重编**（profile 变了，指纹全失效），之后才看得到效果：

```bash
cargo test --lib                      # 第一次：全量，计时
touch src/lib.rs && time cargo test --lib   # 第二次：增量，这个数才重要
```

本项目实测（916 个依赖）：

| 场景 | 改前 | 改后 |
|---|---|---|
| 全量 | `cargo check` 就要 **9m14s**（还不编 test） | `cargo test` 全量 **4m29s** |
| 改两个文件后增量 | 每次重编一大片 | **11s** |

🔴 **诚实声明**：上面三项是**一起改的**，没有分别测量各自的贡献。
想知道哪项对你的项目最有效，就一项一项地加、每加一项量一次增量时间。

---

## 回退

三项都是纯配置，删掉对应段落即可。不改任何代码，不影响 `Cargo.lock`，
不影响 release 构建（`[profile.dev]` 只管 dev/test）。

---

## 不在本文范围、但值得知道的

| 手段 | 为什么没采用 |
|---|---|
| `cargo nextest` | 只省**运行**时间（并行执行），编译一点不省。而瓶颈通常在编译 |
| `sccache` | 对「干净重建」有用，对日常增量循环帮助有限 |
| 提高并行度 | 恰恰相反——默认值就是太高才出事的 |
| `codegen-units` 调高 | dev profile 默认已经是 256，没什么可调 |

另一个**不花钱的习惯改善**：别在 `cargo check` 与 `cargo test` 之间反复横跳。
两者产物不通用（check 产 `.rmeta`，test 产 `.rlib`），交替跑等于每次都重编一遍依赖。
直接用 `cargo test`，它包含了 check 的检查。
