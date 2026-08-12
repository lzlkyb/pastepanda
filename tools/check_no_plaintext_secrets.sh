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

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src-tauri/src"
SELF="$(basename "$0")"

# 排除构建产物与依赖（否则扫 node_modules / target 会慢到不可用）
EX=(--exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git
    --exclude-dir=dist --exclude-dir=__pycache__ --exclude-dir=design)
# 测试桩里的假 key 是正当的（不能因为它们报红）
EX_TEST=(--exclude-dir=__tests__ --exclude-dir=tests --exclude="*.test.ts"
         --exclude="*.test.tsx" --exclude="test_*.py")

echo "检查明文密钥残留"
echo "  • sk- key（含 sk-proj- / sk-ant-api03- 新格式）：$SRC 与 src/、tools/（排除测试桩）"
echo "  • 其它厂商 token 前缀（xox* / gh?_ / glpat- / AIza）：同上"
echo "  • 兑换码 secret：**整仓**（之前只看 src-tauri/src，于是 tools/ 里的明文完全漏掉）"
fail=0

# 1) 明文 sk- key(排除测试桩 sk-mock / sk-whatever,它们不是真实密钥)
#
# 两条正则并列，因为旧那一条有个真洞：'"sk-[A-Za-z0-9]{8,}"' 要求 sk- 之后
# 一路字母数字直到引号，而 OpenAI/Anthropic **现在的真实格式**是 sk-proj-… /
# sk-ant-api03-…，中间带连字符——旧正则对它们完全无效。不删旧条只加新条。
#
# 新条阈值取 32 而不是 16，是为了用**长度**而不是关键词区分桩与真 key：
# 仓里的桩主体是 19~25 字符（sk-deepseek-xxxx… / sk-legacy-0000… / sk-test-key-…），
# 而各家 sk- 系真实 key 是 48 位起（sk-proj- 上百位）。
# **别改成往排除名单里堆 test/mock/厂商名**：grep -v 是整行生效的，
# 那样一把真 key 被粘进测试文件就永远拦不到——而那正是本守卫要防的场景。
# 代价：短于 35 位的真 key 会漏，但目前 sk- 家族没有厂商发这么短的。
hits=$(grep -rnE '"sk-[A-Za-z0-9]{8,}"|"sk-[A-Za-z0-9_-]{32,}"' "$SRC" "$ROOT/src" "$ROOT/tools" \
  "${EX[@]}" "${EX_TEST[@]}" --exclude="$SELF" 2>/dev/null \
  | grep -vE 'sk-mock|sk-whatever' || true)
if [ -n "$hits" ]; then
  echo "❌ 发现明文 API key:"
  echo "$hits"
  fail=1
else
  echo "  ✓ 无明文 sk- key"
fi

# 1b) 其它厂商的完整 token 明文
#
# 为什么必须有这一条：GitHub 的 push protection 按**形状**匹配，一个连续的
# xoxb-… 字面量就会让整个 push 被拒（GH013）——而那时 commit 已经建好，
# 只能 amend 重写、tag 也得重打。v6.10.0 就是这么被拦了一次，而当时本脚本
# 只查 sk- 与兑换码 secret，完全没拦住。本地提前发现，代价只是改一行。
#
# 判据是「前缀 + 足够长的主体，且在**同一个**字符串字面量里」，所以：
#   - 检测表里的纯前缀常量（"ghp_"、"glpat-"）主体不够长 → 不报
#   - 测试正例按仓库约定拆成 concat!("xoxb", "-", "…") → 完整 token 不在同一
#     字面量里 → 不报（这也正是 GitHub 不拦拆开写法的原因）
hits1b=$(grep -rnE '"(xox[abprs]-[A-Za-z0-9-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,})"' \
  "$SRC" "$ROOT/src" "$ROOT/tools" "${EX[@]}" "${EX_TEST[@]}" --exclude="$SELF" 2>/dev/null || true)
if [ -n "$hits1b" ]; then
  echo "❌ 发现明文厂商 token（拆成 concat! 即可，参 content_classifier.rs 的测试正例）:"
  echo "$hits1b"
  fail=1
else
  echo "  ✓ 无明文其它厂商 token"
fi

# 2) 明文 REDEEM_SECRET 常量
hits2=$(grep -rnE 'REDEEM_SECRET\s*[:=]\s*["'"'"']' "$ROOT" "${EX[@]}" \
  --exclude="$SELF" 2>/dev/null || true)
if [ -n "$hits2" ]; then
  echo "❌ 发现 REDEEM_SECRET 常量定义(应走 redeem_secret() 混淆):"
  echo "$hits2"
  fail=1
else
  echo "  ✓ 无明文 REDEEM_SECRET 常量"
fi

# 3) 明文兑换码 secret 字符串
# 整仓扫。--exclude="$SELF" 必需：本脚本自己的源码里就含这个 grep 模式，
# 不排除就会自我触发。
hits3=$(grep -rnE 'pastepanda-redeem-v1' "$ROOT" "${EX[@]}" \
  --exclude="$SELF" 2>/dev/null || true)
if [ -n "$hits3" ]; then
  echo "❌ 发现明文兑换码 secret:"
  echo "$hits3"
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
