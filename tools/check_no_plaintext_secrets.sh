#!/usr/bin/env bash
# 红线守卫 · 密钥明文残留检查(v6.10 测试规划)。
#
# 跑法: bash tools/check_no_plaintext_secrets.sh
# 检查 src-tauri/src 下是否存在:
#   1. 明文 sk- 开头的 API key
#   2. 明文 REDEEM_SECRET 常量(应走 redeem_secret() 混淆)
# 任何命中 → 退出码 1(CI 强制)。
#
# 注意:自身脚本里不含任何真实密钥;误报时把样例替换成占位再跑。
#
# ⚠ 这个绿灯能证明什么、不能证明什么（容易被读成“密钥安全”，它不是）：
#   能：仓库/二进制里搜不到明文字符串，拦住的是 `strings` 级别的扫描。
#   不能：阻止提取。mask.rs 用的是单字节 XOR，异或常量就在同一个函数里，
#         几行脚本就能还原——mask.rs 文件头已声明“这不是真正加密”。
#   后果：`redeem_secret()` 一旦被还原，任何人能批量签出合法兑换码；额度花的是
#         内置公共免费 key，即伪造码 = 直接消耗配额、可能触发服务商封禁。
#         目前唯一真实防线是 DAILY_SPEND_CAP + 进程内 10/分钟滑窗，两者都在客户端。
#         要真正堆高门槛只能走服务端校验（属产品决策，本脚本管不了）。
#
# ── 为什么要合并成两趟（2026-10-09）────────────────────────
# 原来是 **4 趟独立 grep**：sk- 一趟、其它厂商 token 一趟、REDEEM_SECRET 一趟、
# 兑换码前缀一趟。前两趟扫同一组目录（src-tauri/src、src、tools），后两趟扫**整仓**，
# 于是整仓的 I/O 被读了两遍——本机实测 ≈499s，比前端整套 vitest 还慢。
# 现在按「同一组目录只走一遍」合并成 2 趟：模式集与目录集**逐条不变**，
# 只是把 `-f 模式文件` 的或运算交给 grep（GNU grep 有 fast matcher，一趟能判多个模式）。
# 🔴 覆盖范围怎么变过、现在靠什么保证（2026-10-09 二次修订，别再读成「只增不减」）：
#   • 没有加 `-I`（跳过二进制）——明文藏进二进制正是 `strings` 级扫描要抓的；
#   • sk-mock / sk-whatever 的整行豁免仍然**只作用于 sk- 那一条**
#     （合并前是 pass 1 单独 `grep -v`，合并后靠命中行按模式分类实现同一件事）；
#   • 排除名单改了两侧，净效果是**覆盖面变大**：
#       ＋ 剔掉 `design`：它下面有 312 个**被 git 追踪**的稿子，排除它等于对本守卫失明；
#       － 补进 `target-android` / `gen` / `.cache`：三个目录 `git ls-files` 命中数均为 0，
#         全是构建产物/编译缓存（本机实测 7.6G + 2.8G + 若干 GB），整仓趟就是在它们身上烧掉的。
#     为什么剔掉构建缓存不算认输：APK/exe 里的明文只能来自「能进 git 的东西」——`gen/android`
#     是 `tauri android init` + `scripts/prepare-android.mjs` 从被追踪的 `src-tauri/android/`
#     重新生成的，CI 的发布二进制也从被追踪源码重编。所以「扫不到被 git 忽略的产物」不放过任何
#     会发给用户的内容。
#   • 上面这套说法**不是靠本文件的注释自证的**，是靠下面那段断言自证的：
#     名单里每一个 `--exclude-dir` 都必须是「其下 0 个被追踪文件」，否则守卫直接红。
#     也就是说：以后谁往排除名单里塞一个有源码的目录，或者谁 force-add 了产物目录里的文件，
#     这里立刻判红——排除名单被关掉的那一瞬间就会被发现，不用等下次漏检。
# 每条判据各有一个金丝雀反例被 `src/__tests__/secretGuardCanary.test.ts` 真跑一遍，
# 证明「合并没有让任何一条失明」，并钉住排除名单的不变量。

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src-tauri/src"
SELF="$(basename "$0")"

# 排除构建产物与依赖（否则扫 node_modules / target 会慢到不可用）
# 名字按「整棵子树里 0 个被 git 追踪的文件」挑选，下面有断言兜着，不是口头承诺。
EX=(--exclude-dir=node_modules --exclude-dir=target --exclude-dir=target-android
    --exclude-dir=gen --exclude-dir=.cache --exclude-dir=.git
    --exclude-dir=dist --exclude-dir=__pycache__)

# ── 排除名单自检：每个 --exclude-dir 都必须罩住一个「没有源码」的目录 ──
# 断言用 git 自己的索引来判，不依赖本文件的注释，也不依赖目录是否存在（不存在=0 个文件=通过）。
if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "❌ 排除名单自检需要 git：本脚本必须在仓库内运行（否则下面这条断言会静默失效）"
  exit 1
fi
# 自检只做「一次 git ls-files + 一次 grep」：名单拼成一个 (a|b|c)/ 的或运算，不按名字各起进程。
# 也不要写成「读进变量再 printf 给 grep」——Git Bash 展开两千多行的大字符串反而更慢
# （本机三组交替对照：按名字起 git ≈3.6–4.5s，读进变量再筛 ≈4.3–6.2s）。
EX_RX=""
for d in "${EX[@]}"; do
  case "$d" in --exclude-dir=*) ;; *) continue ;; esac
  name="${d#--exclude-dir=}"
  [ -n "$EX_RX" ] && EX_RX="$EX_RX|"
  EX_RX="$EX_RX${name//./\\.}"
done
bad="$(git -C "$ROOT" ls-files | grep -E "(^|/)($EX_RX)/" || true)"
if [ -n "$bad" ]; then
  echo "❌ 排除名单失效：下面这些被 git 追踪的文件落在排除目录里，扫不到它们＝真失明"
  printf '%s\n' "$bad" | head -20
  exit 1
fi
echo "  ✓ 排除名单自检通过（每个排除目录下 0 个被追踪文件）"
# 测试桩里的假 key 是正当的（不能因为它们报红）
EX_TEST=(--exclude-dir=__tests__ --exclude-dir=tests --exclude="*.test.ts"
         --exclude="*.test.tsx" --exclude="test_*.py")

# LC_ALL=C：模式全是 ASCII，字节比较既更快又不受本机 codepage 影响
export LC_ALL=C

# 两趟各自的模式集（-f 而不是内联，避免几百字符的 -E 参数在 Windows 上撞命令行长度上限）
PSET_A="$(mktemp)"
PSET_B="$(mktemp)"
trap 'rm -f "$PSET_A" "$PSET_B"' EXIT

# A 组：sk- 家族 + 其它厂商 token（同一批目录、同一组排除）
cat >"$PSET_A" <<'PATTERNS'
"sk-[A-Za-z0-9]{8,}"
"sk-[A-Za-z0-9_-]{32,}"
"(xox[abprs]-[A-Za-z0-9-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,})"
PATTERNS

# B 组：兑换码相关两条（整仓）
# 注意：这两条的模式串**不能在本文件里以完整形态出现**以外的方式被读到？
# ——不，它们本来就以完整形态出现在这里，靠 --exclude="$SELF" 不自我触发（与合并前一致）。
cat >"$PSET_B" <<'PATTERNS'
REDEEM_SECRET\s*[:=]\s*["'"]
pastepanda-redeem-v1
PATTERNS

echo "检查明文密钥残留（2 趟；判据与合并前逐条相同，排除名单见文件头与上面的自检）"
echo "  • sk- key（含 sk-proj- / sk-ant-api03- 新格式）+ 其它厂商 token：\$SRC 与 src/、tools/（排除测试桩）"
echo "  • REDEEM_SECRET 常量 / 兑换码 secret 前缀：**整仓（design/ 也在内）**"
fail=0

# 1) sk- 与厂商 token（合并原 pass 1 与 pass 1b）
#
# 两条 sk- 正则并列的原因（原注释保留）：旧那一条有个真洞——'"sk-[A-Za-z0-9]{8,}"'
# 要求 sk- 之后一路字母数字直到引号，而 OpenAI/Anthropic **现在的真实格式**是
# sk-proj-… / sk-ant-api03-…，中间带连字符，旧正则对它们完全无效。不删旧条只加新条。
# 新条阈值取 32 而不是 16，是为了用**长度**而不是关键词区分桩与真 key：
# 仓里的桩主体是 19~25 字符，而各家 sk- 系真实 key 是 48 位起。
# **别改成往排除名单里堆 test/mock/厂商名**：整行豁免会让「真 key 被粘进测试文件」
# 永远拦不到——而那正是本守卫要防的场景。
#
# 厂商 token（原 pass 1b）判据是「前缀 + 足够长的主体，且在**同一个**字符串字面量里」：
#   - 检测表里的纯前缀常量（"ghp_"、"glpat-"）主体不够长 → 不报
#   - 测试正例按仓库约定拆成 concat!("xoxb", "-", "…") → 不报（GitHub 也不拦拆开写法）
hitsA=$(grep -rn -f "$PSET_A" -E "$SRC" "$ROOT/src" "$ROOT/tools" \
  "${EX[@]}" "${EX_TEST[@]}" --exclude="$SELF" 2>/dev/null || true)

# 命中行按模式分类：sk- 那两条要过 mock 整行豁免，厂商 token 那条不过。
skHits=$(printf '%s\n' "$hitsA" | grep -E '"sk-' | grep -vE 'sk-mock|sk-whatever' || true)
vendorHits=$(printf '%s\n' "$hitsA" | grep -E '"(xox[abprs]-|gh[pousr]_|glpat-|AIza)' || true)

if [ -n "$skHits" ]; then
  echo "❌ 发现明文 API key:"
  echo "$skHits"
  fail=1
else
  echo "  ✓ 无明文 sk- key"
fi

if [ -n "$vendorHits" ]; then
  echo "❌ 发现明文其它厂商 token（拆成 concat! 即可，参 content_classifier.rs 的测试正例）:"
  echo "$vendorHits"
  fail=1
else
  echo "  ✓ 无明文其它厂商 token"
fi

# 2)+3) 兑换码两条（合并原 pass 2 与 pass 3；整仓扫，--exclude="$SELF" 必需：
#        本脚本自己的源码里就含这两个模式，不排除会自我触发）
hitsB=$(grep -rn -f "$PSET_B" -E "$ROOT" "${EX[@]}" --exclude="$SELF" 2>/dev/null || true)
redeemConst=$(printf '%s\n' "$hitsB" | grep -E "REDEEM_SECRET\s*[:=]\s*[\"']" || true)
redeemStr=$(printf '%s\n' "$hitsB" | grep -F 'pastepanda-redeem-v1' || true)

if [ -n "$redeemConst" ]; then
  echo "❌ 发现 REDEEM_SECRET 常量定义(应走 redeem_secret() 混淆):"
  echo "$redeemConst"
  fail=1
else
  echo "  ✓ 无明文 REDEEM_SECRET 常量"
fi

if [ -n "$redeemStr" ]; then
  echo "❌ 发现明文兑换码 secret:"
  echo "$redeemStr"
  fail=1
else
  echo "  ✓ 无明文兑换码 secret"
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "红线被打破:密钥必须混淆存储,禁止明文落源码。"
  exit 1
fi
echo ""
echo "✅ 密钥明文守卫通过"
exit 0
