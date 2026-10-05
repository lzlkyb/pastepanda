// 只供设计预览的替身；生产构建不引用本文件，也不产生实际连接。
export async function rcShortPairCode() { return { code: "41820620", expires_at: Date.now() + 180000 }; }
export async function rcPinPairBegin(code: string) {
  if (code === "00000000") throw new Error("配对码已过期，请输入电脑上当前的配对码。");
  return { node_id: "preview-pc", name: "示例电脑", expires_at: Date.now() + 180000 };
}
export async function rcExchangeCheck() { return "waiting"; }
export async function rcShortPairCancel() {}
