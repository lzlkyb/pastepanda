/**
 * RcCapsuleHandle — 控端浮条的**常驻把手**（乙档 2026-09-29，
 * design/远程电脑-浮条角标化-乙-设计稿.html）。
 *
 * 它补的是甲方案落地后剩下的两个缺口（稿 §0 R1/R3）：
 * - R1 收起态零出口：胶囊淡出后画面上一条 UI 都不剩，想知道「连着没 / 画质 /
 *   结束会话」只能靠顶缘 3px+180ms 或没人知道的 F10。把手是那个**看得见、点得着**
 *   的出口，顺带给 F10 提供落点。
 * - R3 异常只剩一条看不见的灯：`.capAlarm` 原先住在被 `visibility:hidden` 带走的
 *   子树里（规则 15.1），胶囊一收起微光条跟着消失。乙把它与把手同层（父级
 *   `.capZone` 直下），状态色因此常驻。
 *
 * 几何（稿 §3 申报表 + 2026-09-29 C 项改口）：可见 24×12 挂在顶缘正中，命中区靠
 * `::after` 外扩到 **40×15**（左右各 -9px、下 -4px：本控件左右各 1px 边框、
 * **上缘无边框**，偏移量相对的是 padding box 22×11，所以 22+9+9=40、11+4=15）。
 * 下探原本是 9px（吃进遮挡带 8 像素），C 项收到 4px——那 8px 全屏时正压在远端浏览器
 * 标签 ✕ 那一行，而它换的可达性几乎为零：屏幕顶缘本身就是「无限长的一堵墙」，
 * 窗口态上面还紧挨着我们自己的 36px 顶栏。胶囊一展开下探全收（`.capHandleBehind::after`
 * 的 `bottom:0`），不与那排 `.capBtn` 抢同一击。
 *
 * 🔴 四条纪律：
 * 1. 是 `<button aria-expanded>`，不是 div（规则 17：鼠标全流程可达 + 状态可读）。
 * 2. **不**跟胶囊的 `tabIndex=-1` 纪律——稿 §6 承诺它常驻 Tab 环；只有指针锁定
 *    （隐形、点不着）那一档才退出 Tab。
 * 3. 一格里不写字：状态只有**电点 + 整枚底色**两个色位（原先右上角那枚外挂橙点已退役
 *    ——`top:-3px` 探出把手上缘，全屏态被窗缘裁掉 3px，只剩半个点；整枚染色与
 *    `.capHandleBad` 同构，四档 idle/bad/ask/dim 各一块整色，没有可被裁的元素）。
 *    详情一律留给展开后的胶囊。
 * 4.（口径，见 `useRcCapsuleReveal` 头注 D 项）悬停在把手上**不**起顶缘 dwell——
 *    它是兄弟节点，画面容器收不到那一条 mousemove；唤出这一列走点击，不加悬停即弹。
 */
import type { RcHandleState } from "@/hooks/useRcCapsuleReveal";
import styles from "./RemoteComputer.module.css";

export function RcCapsuleHandle({
  state,
  expanded,
  floatId,
  onToggle,
}: {
  /** 外观档，判据收口在 hook 的 `rcHandleStateOf`（规则 11.1）。 */
  state: RcHandleState;
  /** 胶囊展开中：把手收回命中盒让位（两个可点元素不抢同一击）。 */
  expanded: boolean;
  /** 被展开的那块（`.capFloat`）的 id，供 aria-controls。 */
  floatId: string;
  onToggle: () => void;
}) {
  const dim = state === "dim";
  return (
    <button
      type="button"
      className={[
        styles.capHandle,
        state === "bad" ? styles.capHandleBad : "",
        state === "ask" ? styles.capHandleAsk : "",
        dim ? styles.capHandleDim : "",
        expanded ? styles.capHandleBehind : "",
      ].join(" ")}
      aria-label={expanded ? "收起会话控制条" : "展开会话控制条"}
      aria-expanded={expanded}
      aria-controls={floatId}
      aria-hidden={dim}
      // 隐形 = 点不着 = 不该进 Tab 环；其余档常驻（稿 §6）
      tabIndex={dim ? -1 : undefined}
      title={
        state === "bad"
          ? "链路异常 · 点开看会话控制条"
          : state === "ask"
            ? "有等你处理的（文件请求）· 点开看"
            : "展开/收起会话控制条（F10）"
      }
      onClick={onToggle}
    >
      <span className={styles.capHandleKnob} aria-hidden="true" />
    </button>
  );
}
