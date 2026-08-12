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
echo "  • sk- key：$SRC 与 src/、tools/（排除测试桩）"
echo "  • 兑换码 secret：**整仓**（之前只看 src-tauri/src，于是 tools/ 里的明文完全漏掉）"
fail=0

# 1) 明文 sk- key(排除测试桩 sk-mock / sk-whatever,它们不是真实密钥)
hits=$(grep -rnE '"sk-[A-Za-z0-9]{8,}"' "$SRC" "$ROOT/src" "$ROOT/tools" \
  "${EX[@]}" "${EX_TEST[@]}" --exclude="$SELF" 2>/dev/null \
  | grep -vE 'sk-mock|sk-whatever' || true)
if [ -n "$hits" ]; then
  echo "❌ 发现明文 API key:"
  echo "$hits"
  fail=1
else
  echo "  ✓ 无明文 sk- key"
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
