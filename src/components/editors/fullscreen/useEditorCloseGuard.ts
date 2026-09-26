/**
 * 编辑器**关闭守卫**：把「哪些标签要关、关之前存不存、存失败怎么办」全部收在这里。
 *
 * 三条不变量（多标签改造的核心安全边界）：
 *   ① **最后一个标签关掉 = 关窗**：`close()` 返回 null 表示「关完没标签了」，
 *      此后必须走 `doCloseWindow`，否则窗口会停在空白 + 无标签的僵死态。
 *   ② **聚合裁决**：脏标签不逐个弹三选一，一次列清单（`CloseTarget[]`）交用户裁决。
 *      关 5 个未保存文档弹 5 次，用户点到第三轮就开始盲点。
 *   ③ **保存失败就不关**：`handleSaveAll` 里任一 `save()` 返回 false 即中止，
 *      把失败留在用户眼前，而不是关完窗口再告诉他「有一个没存上」。
 *
 * Alt+F4 / 系统关窗也走同一条守卫 —— 改造前它绕过守卫直接丢稿（数据丢失路径）。
 *
 * 从 `FullscreenEditor.tsx`（宿主）拆出，动因是规则 7 的体量红线。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { useLatest } from "@/hooks/useLatest";
import type { CloseTarget } from "./CloseAllDialog";
import type { EditorTab } from "./useEditorTabs";
import type { MutableRefObject } from "react";

/** 退场动画时长（与 CSS 的 overlay-exit 对齐） */
const EXIT_MS = 190;
/**
 * 「关窗请求已发出但窗口还在」的判定窗（见 `doCloseWindow` 里的说明）。
 * 是防「静默否决」把窗口留成永久白屏的最后一道保险。
 */
const VERIFY_MS = 1200;

export interface CloseIntent {
  /** "tab" = 关单个标签；"window" = 关整个窗口 */
  scope: "tab" | "window";
  ids: string[];
}

export interface EditorCloseGuardOptions {
  /** 标签快照（渲染用，供 closeTargets 计算） */
  tabs: EditorTab[];
  /** 标签的「最新值」ref（事件回调里读，避免把 tabs 塞进依赖导致监听反复重绑） */
  tabsRef: MutableRefObject<EditorTab[]>;
  /** useEditorTabs 的 close：返回 null 表示「关完已无标签」 */
  close: (id: string) => string | null;
}

export interface EditorCloseGuardApi {
  /** 正在播退场动画（宿主据此挂 windowExit 类） */
  closing: boolean;
  closeIntent: CloseIntent | null;
  closeTargets: CloseTarget[];
  closeBusy: boolean;
  registerSave: (id: string, fn: (() => Promise<boolean>) | null) => void;
  requestCloseTab: (id: string) => void;
  requestCloseWindow: () => void;
  cancelClose: () => void;
  saveAll: () => Promise<void>;
  discard: () => void;
  /** 退场动画中被复用（极罕见竞态）时重置关闭状态，让新内容正常入场 */
  resetClosing: () => void;
}

export function useEditorCloseGuard({
  tabs,
  tabsRef,
  close,
}: EditorCloseGuardOptions): EditorCloseGuardApi {
  const { toast } = useToast();

  const [closing, setClosing] = useState(false);
  const [closeIntent, setCloseIntent] = useState<CloseIntent | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);

  /** 我们自己发起的关窗：放行 onCloseRequested（否则守卫会把自己拦下来） */
  const forceCloseRef = useRef(false);
  /**
   * 退场动画的定时器。它同时承担**关窗的防重入判据** —— 这也是它必须持有引用的原因：
   * `resetClosing` 要靠它把关窗真正取消掉。
   *
   * ❗ 不要退回「一个只置不清的 closing 标记」当防重入判据：关窗失败（命令报错 /
   * 被系统拒绝）时那标记会永久为真，用户再点 ✕ 也进不来 —— 窗口卡在退场态、
   * 内容已淡出、却关不掉。用「定时器还在路上」判定则天然可重试：排程存在时
   * 不重复排，排程结束（说明上一次已尝试并结束）后允许再试。
   */
  const exitTimerRef = useRef<number | null>(null);
  /** 关窗后的存活复核定时器（见 `doCloseWindow`） */
  const verifyTimerRef = useRef<number | null>(null);
  const saveHandlersRef = useRef(new Map<string, () => Promise<boolean>>());
  const closeIntentRef = useLatest(closeIntent);

  const doCloseWindow = useCallback(() => {
    if (exitTimerRef.current !== null) return;
    const finish = () => {
      exitTimerRef.current = null;
      forceCloseRef.current = true;
      // ❗ 窗口**真正被销毁**这一步不在 Rust 侧，而在 JS 侧：
      //   本窗口注册了 `onCloseRequested`，而 `@tauri-apps/api` 的 wrapper 会在
      //   「没 preventDefault」时自己 `await this.destroy()` —— `destroy` 打的是
      //   `plugin:window|destroy`，需要 `core:window:allow-destroy`。权限登记在
      //   `src-tauri/capabilities/md-editor.json`（与 `rc-workbench.json` 同因同修）。
      //
      //   🔴 缺这条权限时**不会报错**：Rust 的 `window.close()` 只负责发 CloseRequested、
      //   不等结果就返回 Ok，而 wrapper 内部 `destroy()` 的拒绝被它自己吞掉 ⇒
      //   这里拿不到任何异常，窗口却纹丝不动。所以下面的 `getCurrentWindow().close()`
      //   **不是一道独立的保险**：它打的是同一个 `plugin:window|close`，走到同一个死胡同。
      //   别再把「两级兜底」当成权限缺失的安全网 —— 真正兜住的是后面那个存活复核。
      invoke("close_editor_window").catch((e) => {
        logger.warn("[关闭守卫] close_editor_window 失败，退化为前端直接关窗", e);
        return getCurrentWindow()
          .close()
          .catch((e2) => {
            logger.error("[关闭守卫] 关窗请求失败，回滚退场态", e2);
            setClosing(false);
          });
      });
      // 最后一道保险：关窗请求发出后窗口若还活着，说明它被静默否决了（权限缺失、
      // 别的监听器抢先 preventDefault……）。此时退场动画已把内容淡成 opacity:0，
      // 而**没有任何代码会再把 closing 复位** —— 用户面对的是一扇永远关不掉的白窗口。
      // 窗口真被销毁时 JS 上下文随之消失，这个定时器根本不会跑；它只在「窗口仍在」时触发，
      // 于是把界面还原成「内容还在、可以重试」的状态。宁可多一次重试，不留死窗。
      if (verifyTimerRef.current !== null) window.clearTimeout(verifyTimerRef.current);
      verifyTimerRef.current = window.setTimeout(() => {
        verifyTimerRef.current = null;
        logger.error("[关闭守卫] 关窗请求已发出但窗口仍在（疑似被静默否决），回滚退场态");
        setClosing(false);
      }, VERIFY_MS);
    };
    // 「窗口动画」关闭（editor-main.tsx 挂 no-anim 类）：跳过快照直接关窗
    if (document.documentElement.classList.contains("no-anim")) {
      finish();
      return;
    }
    setClosing(true);
    exitTimerRef.current = window.setTimeout(finish, EXIT_MS);
  }, []);

  /**
   * 取消正在进行的退场动画。
   *
   * ❗ 光重置标记是不够的 —— 已排好的 `finish` 还在 190ms 后等着关窗。
   * 真实触发场景：退场动画期间主窗打开了新文件 → Rust emit `md-editor-load`
   * → 前端调本函数 + 建新标签。若只重置标记，新文档会正常入场、退场动画类也撤了，
   * 但 190ms 后窗口照样被关掉 —— 用户看到「新文档闪一下就没了」，而主窗那边
   * `openInEditor` 的 promise 已经成功返回，两边认知不一致。
   *
   * 这里**不**去动 `forceCloseRef`：定时器被取消意味着 `finish` 没跑过，
   * 那个标记本来就是 false（它只在 finish 里置位），下次关窗仍会正常走守卫。
   */
  const resetClosing = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    // 存活复核定时器同样要撤：新文档都进场了，1200ms 后再把 closing 复位
    // 就是拿旧关窗请求的残响去打扰新内容。
    if (verifyTimerRef.current !== null) {
      window.clearTimeout(verifyTimerRef.current);
      verifyTimerRef.current = null;
    }
    setClosing(false);
  }, []);

  const registerSave = useCallback((id: string, fn: (() => Promise<boolean>) | null) => {
    if (fn) saveHandlersRef.current.set(id, fn);
    else saveHandlersRef.current.delete(id);
  }, []);

  /**
   * 关闭一个标签：不脏直接关（关掉最后一个则连窗口一起关）；
   * 脏则进聚合清单对话框（守卫统一由宿主裁决，不给每个标签各弹一个框）。
   *
   * ❗ **最后一个标签刻意不真的移除**：移除会让宿主先渲染出一个「零标签」的空壳，
   * 用户看到的是「内容先消失 → 窗口再关」中间闪一下。留着它让整窗一起退场，
   * 观感是「这份文档随窗口淡出」；退场期间若来了新内容（`md-editor-load`
   * → `resetClosing`），文档也还在原地，不会被顺带关掉。
   */
  const requestCloseTab = useCallback((id: string) => {
    const list = tabsRef.current;
    const tab = list.find((t) => t.id === id);
    if (!tab) return;
    // ❗ 脏检查必须在「是否最后一个标签」之前：最后一个标签**照样要过守卫**，
    //    区别只在于关窗时不移除它（见下）。顺序反了就是「单标签直接关窗、
    //    未保存的改动静默丢失」—— 守卫存在的意义正好被绕过。
    if (tab.meta.isDirty) {
      setCloseIntent({ scope: "tab", ids: [id] });
      return;
    }
    if (list.length === 1) {
      doCloseWindow();
      return;
    }
    if (close(id) === null) doCloseWindow();
  }, [close, doCloseWindow, tabsRef]);

  const requestCloseWindow = useCallback(() => {
    const dirty = tabsRef.current.filter((t) => t.meta.isDirty);
    if (dirty.length === 0) {
      doCloseWindow();
      return;
    }
    setCloseIntent({ scope: "window", ids: dirty.map((t) => t.id) });
  }, [doCloseWindow, tabsRef]);

  const closeTargets: CloseTarget[] = useMemo(() => {
    if (!closeIntent) return [];
    return closeIntent.ids
      .map((id) => tabs.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => ({
        id: t.id,
        fileName: t.meta.fileName,
        tabError: t.meta.tabError,
        canSave: t.meta.canSave,
      }));
  }, [closeIntent, tabs]);

  const finishIntent = useCallback((intent: CloseIntent) => {
    setCloseIntent(null);
    if (intent.scope === "window") {
      doCloseWindow();
      return;
    }
    // 要关的标签已是全部 → 等价于关窗。同上：不移除标签，让整窗一起退场，
    // 否则会在退场前先闪一帧「零标签」空壳。
    if (tabsRef.current.length <= intent.ids.length) {
      doCloseWindow();
      return;
    }
    for (const id of intent.ids) {
      if (close(id) === null) {
        doCloseWindow();
        return;
      }
    }
  }, [close, doCloseWindow, tabsRef]);

  /** 逐个真写盘。任一失败就**不关窗** —— 把失败留在用户眼前，
   *  而不是关完窗口再告诉他「有一个没存上」。 */
  const saveAll = useCallback(async () => {
    const intent = closeIntentRef.current;
    if (!intent) return;
    setCloseBusy(true);
    try {
      for (const id of intent.ids) {
        const save = saveHandlersRef.current.get(id);
        if (!save) continue;
        const ok = await save();
        if (!ok) {
          toast("有文档未能保存，已取消关闭", "error");
          return;
        }
      }
    } catch (e) {
      logger.error("[关闭守卫] 保存失败", e);
      toast("保存失败，已取消关闭", "error");
      return;
    } finally {
      setCloseBusy(false);
    }
    finishIntent(intent);
  }, [closeIntentRef, finishIntent, toast]);

  const discard = useCallback(() => {
    const intent = closeIntentRef.current;
    if (!intent) return;
    finishIntent(intent);
  }, [closeIntentRef, finishIntent]);

  const cancelClose = useCallback(() => setCloseIntent(null), []);

  // Alt+F4 / 系统关窗：也走同一条守卫（改前它绕过守卫直接丢稿）
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((e) => {
        if (forceCloseRef.current) return;
        e.preventDefault();
        requestCloseWindow();
      })
      .then((fn) => { if (disposed) fn(); else unlisten = fn; })
      .catch(() => { /* 非 Tauri 环境（测试 / 浏览器预览）忽略 */ });
    return () => { disposed = true; unlisten?.(); };
  }, [requestCloseWindow]);

  return {
    closing,
    closeIntent,
    closeTargets,
    closeBusy,
    registerSave,
    requestCloseTab,
    requestCloseWindow,
    cancelClose,
    saveAll,
    discard,
    resetClosing,
  };
}
