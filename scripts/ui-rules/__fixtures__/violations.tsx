/**
 * TS/TSX 侧的故意违规样本。
 */
import { logger } from "@/lib/logger";

export function Bad() {
  const [data, setData] = useState<string[]>([]);

  const load = async () => {
    try {
      setData(await fetchSomething());
    } catch (e) {
      // U3_5 · catch 只记日志 → 失败会被渲染成「空」
      logger.warn("读取失败", e);
    }
  };

  return (
    <div style={{ fontSize: 14, borderRadius: 6, padding: 18, transition: "color 120ms ease" }}>
      {/* L2 · 只有 title，没有常驻文字 */}
      <button title="删除">
        <Icon />
      </button>

      {/* L3 · 空态只写「暂无数据」，没给下一步 */}
      <span>{data.length === 0 ? "暂无数据" : null}</span>

      {/* V3 · 硬编码 hex + U8 内联 style */}
      <b style={{ color: "#4a5568" }}>bad</b>

      {/* U6 · 色名变量 */}
      <i style={{ color: "var(--green)" }}>bad</i>
    </div>
  );
}
