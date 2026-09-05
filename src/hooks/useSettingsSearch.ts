import { useState, useRef, useLayoutEffect, type RefObject } from "react";
import { aliasesFor, warnStaleAliasKeys } from "@/lib/settings-aliases";
import styles from "@/components/Settings.module.css";

/**
 * 取设置行的标题原文（用来查别名表）。
 * 取 .sRowLabel 的第一个文本节点，为的是排掉里面的「⭐推荐」徽标和帮助按钮。
 */
function rowLabel(el: HTMLElement): string {
  const labelEl = el.querySelector("." + styles.sRowLabel);
  if (!labelEl) return "";
  const first = labelEl.firstChild;
  const raw = first && first.nodeType === Node.TEXT_NODE
    ? first.textContent || ""
    : labelEl.textContent || "";
  return raw.trim();
}

/**
 * 设置行参与匹配的文本（已转小写）。
 *
 * 🔴 跳过开关按钮上的「开 / 关」：那是状态不是内容，不跳的话搜「关」会命中所有关着的开关。
 * 其余文本（主题名、「7天/30天」这类选项）都保留——它们是用户真会搜的词。
 */
function rowHaystack(el: HTMLElement): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.textContent || ""; return; }
    if (n instanceof HTMLElement && n.classList.contains(styles.sToggleLabel)) return;
    n.childNodes.forEach(walk);
  };
  walk(el);
  const alias = aliasesFor(rowLabel(el));
  if (alias.length > 0) out += " " + alias.join(" ");
  return out.toLowerCase();
}

export interface SettingsSearch {
  filter: string;
  setFilter: (v: string) => void;
  // ❗ 写 `| null`：React 19 的 useRef<T>(null) 返回 RefObject<T | null>，
  // 声成 RefObject<T> 会编不过。
  /** 挂在装设置行的容器上（它的 children 必须是一层扁平的行） */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 挂在「无结果」提示上 */
  noResultRef: RefObject<HTMLDivElement | null>;
  /** 挂在搜索框旁的计数 <span> 上（该 span 不要渲染子节点） */
  countRef: RefObject<HTMLSpanElement | null>;
}

/** dev 下别名表校验只做一次（模块级，不随组件重挂重算） */
let aliasChecked = false;

/**
 * 设置页搜索：关键词状态 + 对容器做原地过滤。
 *
 * 从 useSettingsData 里拆出来的，因为搜索框搬到了**左侧菜单顶部**（SettingsView 持有），
 * 而装设置行的容器在 GeneralTab 里——两边靠这组 ref 对接。
 */
export function useSettingsSearch(): SettingsSearch {
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const noResultRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);

  // 不写依赖数组＝每次渲染后都重跑。过滤是对真实 DOM 做的，而 React 新插入的节点
  // 默认 display 为空串，会绕过当前关键词直接显形；只要容器里有条件渲染的分区
  // （局域网同步、知识库同步…），漏列一项就是搜索静默失效。列举依赖必然漏，故不列。
  //
  // 🔴 这套过滤要求 containerRef 的 children 是「一层扁平的行」：分区标题
  // 和设置行是兄弟节点。所以分区组件必须返回 <>…</> 片段，不能包一层 <div>，
  // 否则遍历到的是分区外壳而不是行，搜索会静默失效（界面看着正常）。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const kw = filter.trim().toLowerCase();
    const children = Array.from(container.children) as HTMLElement[];

    // dev 下只查一次：别名表的键是否都还对得上真实行标题（行改名会让别名静默失效）
    if (import.meta.env.DEV && !aliasChecked && children.length > 0) {
      aliasChecked = true;
      const labels = new Set<string>();
      for (const el of children) {
        const l = rowLabel(el);
        if (l) labels.add(l);
      }
      warnStaleAliasKeys(labels);
    }

    // 第一遍：按文本匹配显示/隐藏每个设置行（分区标题留到第二遍）
    let visibleCount = 0;
    // 分区标题自己命中时，整节展开——搜「外观」「数据管理」这种词本来就应当有结果
    let sectionHit = false;
    for (const el of children) {
      if (el.classList.contains(styles.sSection)) {
        sectionHit = kw !== "" && (el.textContent || "").toLowerCase().includes(kw);
        continue;
      }
      // 空关键词时短路，不去走 rowHaystack 的 DOM 遍历（这是常态）
      const direct = kw !== "" && rowHaystack(el).includes(kw);
      const match = kw === "" || sectionHit || direct;
      el.style.display = match ? "" : "none";
      // 底纹只给「自己命中」的行；因分区名命中而整节展开时不加，否则一整节都是底纹。
      // React 每次渲染会按 props 重置 className，但本 effect 每次渲染后都跑，会补回来
      el.classList.toggle(styles.settingsHit, direct);
      if (match) visibleCount++;
    }
    // 第二遍：若某分区下已无可见行，则连分区标题一起隐藏
    let currentSection: HTMLElement | null = null;
    let sectionHasVisible = false;
    const flush = () => {
      if (currentSection) currentSection.style.display = sectionHasVisible ? "" : "none";
    };
    for (const el of children) {
      if (el.classList.contains(styles.sSection)) {
        flush();
        currentSection = el;
        sectionHasVisible = false;
      } else if (el.style.display !== "none") {
        sectionHasVisible = true;
      }
    }
    flush();
    if (noResultRef.current) {
      noResultRef.current.style.display = kw && visibleCount === 0 ? "" : "none";
    }
    // 计数写 DOM 而不是走 state：本 effect 每次渲染都跑，setState 会绕回来。
    // 对应的 <span> 不渲染任何子节点，React 不会覆盖这里写进去的文本。
    if (countRef.current) {
      countRef.current.textContent = kw ? `${visibleCount} 项` : "";
    }
  });

  return { filter, setFilter, containerRef, noResultRef, countRef };
}
