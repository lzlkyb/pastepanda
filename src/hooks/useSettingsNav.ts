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
export function useSettingsNav({ open, initialTab, blossom, searching, sectionClass }: {
  open: boolean;
  /** 从变换中心等处跳过来时指定的页；不传或 "general" 就落在第一个分区。 */
  initialTab?: SettingsTabName;
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
  /** 点菜单后待执行的滚动目标（等目标渲染出来再滑） */
  const pendingScrollRef = useRef<SettingsNavKey | null>(null);
  /**
   * 平滑期间抑制 scroll-spy 的截止时间。
   * 不加这个的话：点「数据管理」→ 开始平滑 → 途中扫过「快捷键」→ spy 把 nav 改成快捷键，
   * 菜单高亮会在滑动过程中乱跳，最后停在错的项上。
   */
  const spyMutedUntilRef = useRef(0);

  /** 菜单全部 11 项，**顺序即滚动顺序** */
  const navItems = useMemo(() => settingsNavItems(blossom), [blossom]);

  useEffect(() => {
    if (!open) return;
    // v6.4 审查：#10 从变换中心跳转过来时直接定位到指定页；
    // 不传或传 "general" 就落在第一个分区（右栏永远不能是空的）。
    setNav(initialTab && initialTab !== "general" ? initialTab : SETTINGS_SECTIONS[0].key);
    // initialTab 只在打开那一刻消费。列进依赖的话，父组件改一次这个 prop
    // 就会把用户手动切过去的项拉回来。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * 在滚动容器里找某一项的标题元素。靠**标题文字**对应——meta.ts 已声明
   * label 必须与分区标题逐字一致；AI/MCP/帮助/关于 的标题也按同一套文字渲染。
   * 用 querySelectorAll 而不是遍历 container.children：四个页的标题在搜索容器**之外**。
   */
  const findNavEl = (key: SettingsNavKey): HTMLElement | undefined => {
    const scroller = bodyRef.current;
    if (!scroller) return undefined;
    const label = navItems.find((n) => n.key === key)?.label;
    return Array.from(scroller.querySelectorAll<HTMLElement>("." + sectionClass)).find(
      (el) => (el.textContent || "").trim() === label,
    );
  };

  const handleNavPick = (key: SettingsNavKey) => {
    setNav(key);
    if (key === "about" && CHANGELOG.length > 0) setLastSeenVersion(CHANGELOG[0].version);
    // 点菜单 → 平滑到那一节。不在这里直接滚：MCP 那块是按可见性懒挂载的，
    // 可能还没真正渲染出来，交给渲染后的 effect 去量位置。
    pendingScrollRef.current = key;
  };

  // 点菜单后真正执行滚动：放在渲染后，因为目标（尤其是懒挂载的 MCP）可能刚出现
  useEffect(() => {
    const key = pendingScrollRef.current;
    if (!key) return;
    pendingScrollRef.current = null;
    const scroller = bodyRef.current;
    const target = findNavEl(key);
    if (!scroller || !target) return;
    // 用 scrollTop 增量而不是 scrollIntoView：后者会连带滑动祖先容器，把整个窗口顶掉
    const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    spyMutedUntilRef.current = performance.now() + 700;
    scroller.scrollTo({ top, behavior: "smooth" });
  });

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
