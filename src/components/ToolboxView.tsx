/**
 * ToolboxView.tsx — 「工具」模式主体区（D15，规划 §8.1 0️⃣③）。
 *
 * 取代原来的顶栏工具箱下拉面板。**本次只做最小搬运**：
 * 现有 9 个工具原样上屏，不加搜索、不加收藏、不加新工具。
 *
 * 为何卡这么死（规划 §10 风险登记册原话）：工具箱从下拉改为主体区是**重做布局**，
 * 而它与知识库本身无关却被拉进了 M1。任何「顺手把工具箱做好看点」就地拒绝，
 * 否则 M1 会被一个与主线无关的模块拖住。
 */
import { TOOLBOX_GROUPS, type ToolHandlers } from "@/lib/toolbox";
import styles from "./ToolboxView.module.css";

export function ToolboxView({ handlers }: { handlers: ToolHandlers }) {
  return (
    <div className={styles.wrap}>
      {TOOLBOX_GROUPS.map((group) => (
        <div key={group.label}>
          <div className={styles.section}>{group.label}</div>
          <div className={styles.grid}>
            {group.items.map((tool) => {
              const run = handlers[tool.key];
              return (
                <button
                  key={tool.key}
                  className={styles.item}
                  onClick={() => run?.()}
                  // 没接回调的工具直接禁用，而不是渲染成可点却没反应（规则 #15.3）
                  disabled={!run}
                  title={tool.desc}
                >
                  <span className={styles.tile} data-hue={tool.hue} aria-hidden="true">{tool.icon}</span>
                  <span className={styles.text}>
                    <span className={styles.name}>{tool.name}</span>
                    <span className={styles.desc}>{tool.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
