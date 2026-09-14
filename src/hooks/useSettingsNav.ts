import { useState, useEffect, useRef, useMemo } from "react";
import { CHANGELOG } from "@/lib/changelog.generated";
import { setLastSeenVersion } from "@/lib/changelog";
import {
  SETTINGS_SECTIONS, settingsNavItems,
  type SettingsNavKey, type SettingsNavEntry,
} from "@/components/settings/sections/meta";
import type { SettingsTabName } from "@/lib/openSettings";

/**
 * 设置页左菜单的导航层：当前项、点菜单平滑跳转、滚到哪节就高亮哪项。
 *
 * 🔴 整个机制建在一个约定上：**`settingsNavItems()` 的数组顺序＝右栏的滚动顺序**，
 * 且每一项的 `label` 与右栏分区标题的文字逐字一致（反查靠的就是这段文字）。
 * 两者都写在 `sections/meta.ts` 的注释里。
 */

/**
 * 外部跳转后继续校正目标位置的时长。
 *
 * 2.5s 是拍的，但有下界依据：要等的是 `stats` / `expiredCount` 两个 `invoke`
 * 加 `AiTab` 的 providers，都是本机 SQLite / 配置读取；真慢到 2.5s 以上的话，
 * 用户早就自己动了，而那种情况下我们本就该收手（见下面的 wheel 监听）。
 */
const SETTLE_MS = 2500;

export function useSettingsNav({ open, initialTab, initialSection, jump, blossom, searching, sectionClass }: {
  open: boolean;
  /** 从变换中心等处跳过来时指定的页；不传或 "general" 就落在第一个分区。 */
  initialTab?: SettingsTabName;
  /** 通用页内分区 key（如 "lan"）；合法时覆盖 initialTab 的落点 */
  initialSection?: string;
  /** 外部 open-settings 计数；已打开时再跳靠它触发（open 本身不翻转） */
  jump?: number;
  /** 樱花主题（四个页的图标要换） */
  blossom: boolean;
  /** 搜索态：右栏是跨分区结果，此时不该再跟随高亮 */
  searching: boolean;
  /** 分区标题的 CSS module 类名（传进来，hook 不依赖具体样式文件） */
  sectionClass: string;
}) {
  /**
   * 当前菜单项。🔴 **不允许为 null**：之前初值是 null，结果刚打开设置右栏整块空白，
   * 看上去像 bug，实际是「还没点过菜单」。恒定左右布局下没有「未选中」这个态。
   */
  const [nav, setNav] = useState<SettingsNavKey>(SETTINGS_SECTIONS[0].key);
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * 待执行的滚动目标（等目标渲染出来再滑）。
   *
   * `smooth` 区分两种来源，它们的**时机完全不同**：
   * - 手点菜单（true）：页面早就加载完、布局是稳的，平滑滑过去是对的；
   * - 外部跳转（false）：见下面 `settling` 那段，那时页面还没长齐。
   */
  const pendingScrollRef = useRef<{ key: SettingsNavKey; smooth: boolean } | null>(null);
  /**
   * 外部跳转（`initialTab`）后的**校正窗口**：期间内容一长高就重新对齐。
   *
   * 🔴 这是 2026-09-10 报的那个 bug 的修复：从知识库「⋯」点「连接 AI 工具（MCP）」，
   * 结果停在「数据管理」。根因**不是**找不到目标、也不是滚不动，而是**算早了**：
   * 下面那个 effect 依赖 `[open]`，在 `SettingsView` 挂载那一刻就排了滚动，而那时：
   *   ・`stats`（页面最顶上那块）还是 `null`，异步回来后要撑出一整块；
   *   ・`expiredCount` 还是 0；
   *   ・`AiTab` 的 providers 没到，回来后可能自动展开「服务商与密钥」；
   *   ・`McpTab` 压根没挂载（`LazyMount` 靠 IntersectionObserver），只有 220px 占位。
   * 于是按一个矮得多的页面算出 `top` 滑过去；随后这些内容陆续到达，
   * 把 MCP 标题一路往下推，而原来的代码**滑完就把 ref 清了、再也不重算**。
   *
   * 手点菜单一直是好的，正因为那时候上面这些都已就位——同一段代码，只是跑在对的时刻。
   */
  const [settling, setSettling] = useState<SettingsNavKey | null>(null);
  /**
   * 平滑期间抑制 scroll-spy 的截止时间。
   * 不加这个的话：点「数据管理」→ 开始平滑 → 途中扫过「快捷键」→ spy 把 nav 改成快捷键，
   * 菜单高亮会在滑动过程中乱跳，最后停在错的项上。
   */
  const spyMutedUntilRef = useRef(0);
  /**
   * 手点菜单的强制重渲染计数（只写不读）。
   *
   * 🔴 修的是「点侧栏有时不滚 / 只挪一点」：
   * `handleNavPick` 里若 `nav` 已经等于目标 key（scroll-spy 先改过、或连点同一项），
   * `setNav` 会命中 React 状态 bailout——**不重渲染**。而真正执行滚动的那个 effect
   * 故意没写依赖数组、靠「每次渲染都跑」驱动，于是 pending 永远不被消费。
   * 每次 pick 自增一次，保证至少一帧重渲染。
   */
  const [, setPickSeq] = useState(0);

  /** 菜单全部 11 项，**顺序即滚动顺序** */
  const navItems = useMemo(() => settingsNavItems(blossom), [blossom]);

  useEffect(() => {
    if (!open) return;
    // v6.4 审查：#10 从变换中心跳转过来时直接定位到指定页；
    // 不传或传 "general" 就落在第一个分区（右栅永远不能是空的）。
    // 剪贴板同步等入口可再带 section（如 "lan"）：合法分区 key 优先于 tab 落点。
    const sectionHit =
      initialSection &&
      SETTINGS_SECTIONS.some((s) => s.key === initialSection)
        ? (initialSection as SettingsNavKey)
        : null;
    const key =
      sectionHit ??
      (initialTab && initialTab !== "general" ? initialTab : SETTINGS_SECTIONS[0].key);
    setNav(key);
    // 🔴 只 `setNav` 是不够的——下面两件事都曾被漏掉，而它们叠起来
    //    正好把「定位到指定页」这个功能完全抵消（实测：从知识库「⋯」菜单
    //    点「连接 AI 工具（MCP）」，设置页打开了但停在第一节）：
    //    ① 右栅的定位**只由 `pendingScrollRef` 驱动**（看下面那个 effect）。
    //      不排一次的话，右栅停在第一节，而左菜单却高亮着 MCP。
    //    ② scroll-spy 那个 effect 在挂载时会**立即 `onScroll()` 一次**，
    //      按当前滚动位置（顶部）把 `nav` 改回第一节——连高亮也保不住。
    //      所以必须同时压住它，口径与 `handleNavPick` 一致。
    //
    // ⚠ 页面底部那几页（帮助/关于）的目标位置会在 `LazyMount` 把 MCP
    //   真内容换进来后下移。这里不补偿：那是 `LazyMount` 占位高度的事，
    //   而且 MCP 自己的标题在它内容之上，不受影响。
    if (key !== SETTINGS_SECTIONS[0].key) {
      // 外部跳转不用 smooth：页面刚打开、用户还没看到内容，
      // 从顶部滑到第 9 项那段动画既没有信息量，又会与下面的校正互相打断。
      pendingScrollRef.current = { key, smooth: false };
      spyMutedUntilRef.current = performance.now() + SETTLE_MS;
    }
    // initialTab / initialSection / jump 只在「打开或外部再跳」那一刻消费。
    // 列进 open 之外的依赖时，父组件因别的原因重渲染改一次 prop 就会把
    // 用户手动切过去的项拉回来——所以 jump 是唯一额外扳机。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jump]);

  /**
   * 在滚动容器里找某一项的标题元素。靠**标题文字**对应——meta.ts 已声明
   * label 必须与分区标题逐字一致；AI/MCP/帮助/关于 的标题也按同一套文字渲染。
   * 用 querySelectorAll 而不是遍历 container.children：四个页的标题在搜索容器**之外**。
   *
   * 跳过被搜索 `display:none` 的标题：它们的 rect 全 0，alignTo 会「成功」
   * 滚到错误位置并清掉 pending。❗ 不能用 `offsetParent === null` 判隐藏——
   * jsdom 里 offsetParent 恒为 null，会把所有目标滤掉（测试与真实 DOM 行为不一致）。
   */
  const findNavEl = (key: SettingsNavKey): HTMLElement | undefined => {
    const scroller = bodyRef.current;
    if (!scroller) return undefined;
    const label = navItems.find((n) => n.key === key)?.label;
    if (!label) return undefined;
    return Array.from(scroller.querySelectorAll<HTMLElement>("." + sectionClass)).find(
      (el) =>
        el.style.display !== "none" &&
        (el.textContent || "").trim() === label,
    );
  };

  /**
   * 目标相对滚动容器**内容顶部**的布局偏移（吸顶时也准）。
   *
   * 🔴 两套旧算法都栽过：
   * ① `scrollTop + rect.top - scroller.top`：`.sSection` 是 sticky，吸顶后
   *    rect.top 贴在滚动口，公式算成「就在原地」——来回切换几次后必现「切不动」。
   * ② 纯 `offsetTop` 链：`.settingsSections > *` 入场动画带 `transform`，
   *    transform 元素会成为 offsetParent，链会从 scroller 上跳过，走错分支。
   *
   * 现在：目标若是 sticky，**临时改成 relative 量一次 rect 再改回**。
   * 读 rect 会强制 layout，设置页点菜单频率下可以接受。
   */
  const offsetInScroller = (el: HTMLElement, scroller: HTMLElement): number => {
    const measure = () =>
      scroller.scrollTop +
      el.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top;

    if (getComputedStyle(el).position !== "sticky") {
      return measure();
    }
    const prevPos = el.style.position;
    const prevTop = el.style.top;
    el.style.position = "relative";
    el.style.top = "auto";
    const top = measure();
    el.style.position = prevPos;
    el.style.top = prevTop;
    return top;
  };

  const handleNavPick = (key: SettingsNavKey) => {
    setNav(key);
    if (key === "about" && CHANGELOG.length > 0) setLastSeenVersion(CHANGELOG[0].version);
    // 手点菜单 = 用户接管：立刻收掉外部跳转的校正窗口，
    // 否则 ResizeObserver 还会按旧目标滚，跟这次抢滚动条。
    setSettling(null);
    // 不在点击瞬间直接滚：MCP 是懒挂载，可能还没渲染出来，交给 effect 重试。
    // smooth:true 表示「用户主动点的」——不要再开 settling；
    // 真正怎么滚由 alignTo 决定（直接写 scrollTop）。
    pendingScrollRef.current = { key, smooth: true };
    // 防 setNav bailout（nav 已是目标时）导致滚动 effect 一帧都不跑
    setPickSeq((n) => n + 1);
  };

  /**
   * 把某一节对齐到滚动容器顶部。返回是否真的找到并滚了（目标未渲染就是 false）。
   *
   * 手点菜单（smooth=true）用**单次** `scrollTo({behavior:"smooth"})`：
   * 测距已对 sticky 做过校正，不再需要「先打断再滚」的双调用（WebView2 会吞第二次）。
   * 外部跳转 / settling 重对齐仍用 scrollTop 直赋，要的是准不是动画。
   */
  const alignTo = (key: SettingsNavKey, smooth: boolean): boolean => {
    const scroller = bodyRef.current;
    const target = findNavEl(key);
    if (!scroller || !target) return false;
    const top = offsetInScroller(target, scroller);
    if (smooth) {
      scroller.scrollTo({ top, behavior: "smooth" });
    } else {
      scroller.scrollTop = top;
    }
    return true;
  };

  // 真正执行滚动：放在渲染后，因为目标（尤其是懒挂载的 MCP）可能刚出现。
  //
  // ❗ **故意不写依赖数组**：本 effect 靠「每次渲染都跑」来重试那些当帧还没
  //   渲染出来的目标（见下面那段红色注释），加了依赖就没了重试机会。
  //   手点菜单那一侧由 `pickSeq` 保证至少触发一次重渲染（见 handleNavPick）。
  //
  //   eslint 为此报「无依赖数组的 effect 里调 setState 可能无限更新」——
  //   这里不会：`setSettling` 之前刚把 `pendingScrollRef.current` 置了 null，
  //   重渲染后第一行 `if (!p) return` 就出去了，走不到第二次 setState。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const p = pendingScrollRef.current;
    if (!p) return;
    // 🔴 没找到目标时**不清 ref**，留给下一次渲染重试。
    //    原来的代码在取 target **之前**就清了，于是「那一帧恰好还没渲染出来」
    //    等于永久放弃——本 effect 没有依赖数组、每次渲染都跑，本来是有机会重试的。
    if (!alignTo(p.key, p.smooth)) return;
    pendingScrollRef.current = null;
    // 手点菜单的 smooth 可能超过 700ms（长页），mute 拉长一点，避免途中 spy 抢高亮
    spyMutedUntilRef.current = performance.now() + (p.smooth ? 900 : SETTLE_MS);
    // 外部跳转：进入校正窗口，在页面长齐的过程中持续对齐。
    // 手点菜单不进：那时布局已稳，再插手只会把平滑动画打断。
    if (!p.smooth) setSettling(p.key);
  });

  /**
   * 校正窗口（只在外部跳转后开）：内容一长高就重新对齐。
   *
   * 🔴 为什么必须上 `ResizeObserver`，而不能只靠「每次渲染重新对齐」：
   * 撑高页面的那几处状态**不都在本组件树上**——`AiTab` 的展开与
   * `LazyMount` 的 `shown` 都是它们自己的 `useState`，改了不会让 `SettingsView`
   * 重渲染，本 hook 的 effect 也就不会跑。
   *
   * ❗ 特性检测不能省：jsdom 没有 `ResizeObserver`（`test-setup.ts` 里也没补），
   *   直接 `new` 会让所有渲染到设置页的测试一起挂。没它时降级为只靠重渲染驱动。
   */
  useEffect(() => {
    if (!settling) return;
    const scroller = bodyRef.current;
    if (!scroller) return;

    const stop = () => setSettling(null);
    const realign = () => {
      alignTo(settling, false);
      // 对齐动作自己会触发 scroll 事件，别让 spy 把高亮改走
      spyMutedUntilRef.current = performance.now() + 200;
    };

    // 🔴 用户自己动了就立刻收手——跟用户抢滚动条是最糟的体验，
    //    而校正窗口有 2.5s，足够长到用户已经开始滑了。
    const onUserScroll = () => stop();
    scroller.addEventListener("wheel", onUserScroll, { passive: true });
    scroller.addEventListener("pointerdown", onUserScroll, { passive: true });
    scroller.addEventListener("keydown", onUserScroll);

    const timer = window.setTimeout(stop, SETTLE_MS);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(realign) : null;
    // 观察**子元素**而不是容器：容器自己的尺寸不变，变的是里面内容的高度。
    if (ro) for (const child of Array.from(scroller.children)) ro.observe(child);

    return () => {
      window.clearTimeout(timer);
      ro?.disconnect();
      scroller.removeEventListener("wheel", onUserScroll);
      scroller.removeEventListener("pointerdown", onUserScroll);
      scroller.removeEventListener("keydown", onUserScroll);
    };
    // `alignTo` 每次渲染都是新闭包，列进依赖会让校正窗口每渲染一次就重建一次
    // （连带把 2.5s 的定时器也重置）。它里面只用到 `findNavEl`，
    // 而那个只依赖 `navItems`（`blossom`）——主题不会在这 2.5s 里变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settling]);

  // scroll-spy：滑到哪一节，菜单就高亮哪一项（含 AI/MCP/帮助/关于）
  useEffect(() => {
    const scroller = bodyRef.current;
    // 搜索时大量行被隐藏、右栏是跨分区结果，此时跟随高亮只会添乱
    if (!scroller || searching) return;
    const onScroll = () => {
      if (performance.now() < spyMutedUntilRef.current) return;
      // 判定线放在可视区顶部下方 80px：标题刚滑过这条线就算「进入这一节」
      const line = scroller.getBoundingClientRect().top + 80;
      let current: SettingsNavKey | null = null;
      for (const el of Array.from(scroller.querySelectorAll<HTMLElement>("." + sectionClass))) {
        // 被搜索隐掉的标题没有布局盒，位置恰好是 0，不跳过会把高亮拉到最后一项
        if (el.offsetParent === null) continue;
        if (el.getBoundingClientRect().top > line) break;
        // 认不出的标题（如 HotkeySection 内部的「转笔记模板」）直接跳过，
        // 保留上一个认得出的，否则滑到那里时菜单会突然掉高亮
        const hit = navItems.find((n) => n.label === (el.textContent || "").trim());
        if (hit) current = hit.key;
      }
      if (current) setNav((prev) => (prev === current ? prev : current));
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [searching, navItems, sectionClass]);

  return { nav, navItems, bodyRef, handleNavPick };
}

export type { SettingsNavKey, SettingsNavEntry };
