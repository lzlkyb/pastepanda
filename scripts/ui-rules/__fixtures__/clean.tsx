/**
 * TS/TSX 侧的合规样本：断言**零命中**。
 */
import { logger } from "@/lib/logger";

export function Good() {
  const [data, setData] = useState<string[]>([]);

  const load = async () => {
    try {
      setData(await fetchSomething());
    } catch (e) {
      // 合规写法：多一个状态，而不是多一句 toast
      logger.warn("读取失败", e);
      setLoadError("读取失败，请重试");
    }
  };

  return (
    <div className={s.panel}>
      {/* 有 aria-label 就不算「只有 title」 */}
      <button title="删除" aria-label="删除">
        <Icon />
      </button>

      {/* 空态给了可执行的下一步 */}
      <span>{data.length === 0 ? "还没有条目，点击右上角新建" : null}</span>

      <button type="button">刷新</button>
    </div>
  );
}
