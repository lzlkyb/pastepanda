/**
 * 列表/网格形态：列数测量与形态选择。
 *
 * 🔴 红线：无 AI。纯尺寸计算 + 一个 localStorage 偏好。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type NoteLayout = "list" | "grid";

/** 低于这个宽度网格放不下（两列卡片会窄到标题只剩几个字）。 */
const MIN_GRID_W = 520;
/** 三列的门槛。 */
const THREE_COL_W = 780;

interface GridCapacity {
  canGrid: boolean;
  cols: number;
}

function capacityOf(w: number): GridCapacity {
  const canGrid = w >= MIN_GRID_W;
  return { canGrid, cols: canGrid ? (w >= THREE_COL_W ? 3 : 2) : 1 };
}

/**
 * 量**中栏自身**的宽度，给出能不能用网格与几列。
 *
 * 🔴 必须 ResizeObserver 而不能用 `useMediaQuery`：
 *   中栏宽度受侧栏开合与第三栏拖拽（`split.ratio`）影响，
 *   窗口宽根本代表不了它——900px 的窗口完全可能只给中栏 300px。
 *
 * 🔴 返回的是一个 **callback ref**（`measureRef`）而不是收一个 `RefObject`。
 *   原先的写法是 `useEffect(…, [ref])` + `ro.observe(ref.current)`，而 `RefObject`
 *   的身份永不变 ⇒ effect 只跑一次。但 `.listWrap` **不是常驻的**：
 *   `KnowledgeView` 里它在「是不是回收站」的三元里，切回收站整个分支卸载、
 *   切回来是个新节点——旧观察者还盯着已分离的那个，新节点从此没人量。
 *   分离的节点不触发 resize，所以尺寸会**永久冻结在切走前的值**：
 *   宽屏网格→回收站→回来→拉窄，网格会继续按 3 列挤在放不下的宽度里。
 *   callback ref 在每次挂载/卸载都会被调用，构造上就不会漏。（2026-09-07 修）
 *
 * ❗ 返回的 `cols` 与「能不能用网格」是**同一个数**的两面，
 *   不要在调用方再算一遍（二维键盘导航也要用它）。
 */
export function useGridCapacity(): GridCapacity & {
  measureRef: (el: HTMLElement | null) => void;
} {
  const [cap, setCap] = useState<GridCapacity>({ canGrid: false, cols: 1 });
  const roRef = useRef<ResizeObserver | null>(null);

  const measureRef = useCallback((el: HTMLElement | null) => {
    // 换节点（含卸载时的 null）先断旧的，否则会累积观察者。
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;

    const apply = () =>
      setCap((prev) => {
        const next = capacityOf(el.clientWidth);
        // ❗ 阈值没跨过就返回原对象，React 会跳过重渲染。
        //   不这么写的话拖分栏时每一帧都会把整个笔记列表重渲染一遍。
        return prev.canGrid === next.canGrid && prev.cols === next.cols ? prev : next;
      });

    const ro = new ResizeObserver(apply);
    ro.observe(el);
    roRef.current = ro;
    // 首次同步读一把：ResizeObserver 的首次回调在下一帧，
    // 不读的话刷新后会先闪一下列表再变网格。
    apply();
  }, []);

  // 组件本体卸载时收尾（callback ref 已经管了节点更替，这里只是兜底）。
  useEffect(() => () => roRef.current?.disconnect(), []);

  return { ...cap, measureRef };
}

const LS_KEY = "pastepanda_kb_note_layout";

/**
 * 用户选的形态（存盘）。
 *
 * ❗ 存的是**偏好**而不是生效值：窗口拉窄时不能把用户的选择改成 list 写回去，
 *   否则拉宽回来后就变成列表了——用户从没按过那下。
 *   生效值 = `pref === "grid" && canGrid ? "grid" : "list"`，在调用方算。
 */
export function useNoteLayoutPref(): [NoteLayout, (l: NoteLayout) => void] {
  const [pref, setPref] = useState<NoteLayout>(() =>
    // 读失败（隐私模式 / 被清）不能把列表弄挂，所以包一层。
    {
      try {
        return localStorage.getItem(LS_KEY) === "grid" ? "grid" : "list";
      } catch {
        return "list";
      }
    },
  );
  const set = (l: NoteLayout) => {
    setPref(l);
    try {
      localStorage.setItem(LS_KEY, l);
    } catch {
      /* 存不下就只在本次会话生效，不弹错 */
    }
  };
  return [pref, set];
}
