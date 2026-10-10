import { useCallback, useEffect, useState, useRef, useLayoutEffect, type RefObject } from "react";
import { aliasesFor, warnStaleAliasKeys, SETTING_SECTION_ALIASES } from "@/lib/settings-aliases";
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

/** 拆掉上次注入的 <mark>，把文本节点并回去，避免 React 重渲染后叠 mark */
function clearSearchMarks(root: ParentNode) {
  root.querySelectorAll("mark." + styles.searchMark).forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent || ""), m);
    parent.normalize();
  });
}

/**
 * 取节标题（结果条「分布在「…」」和 sectionHit 判定共用）。
 *
 * 🔴 必须优先读 `data-label`：「远程电脑」那节的小节标题是**可折叠组头**，
 * 收起态在名字后面还挂着一串状态摘要（`已配对3 · 待确认1 · 指纹 7F2C·A91B`）。
 * 直接取 textContent 会让横幅变成「分布在『谁能连进来已配对3…』」。
 * **回退到 textContent 不能省**——其余分区的标题都只有文字、没有 data-label，
 * 省掉回退会把「搜小节名 ⇒ 整节展开」这条既有行为悄悄改掉。
 */
export function sectionTitleOf(el: HTMLElement): string {
  return (el.dataset.label || el.textContent || "").trim();
}

/** 最近的纵向可滚动祖先：`.settingsSections` 自己不滚，滚动位置要相对滚动口算 */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

/**
 * 命中行上方**最近的一根分区标题**的实占高度——它就是此刻吸在视口顶部、
 * 会盖住贴顶内容的那根（小节标题与主标题都 `top: 0`，叠着时后一根在上，
 * 而「后一根」正是往上找到的第一根）。往上找不到（第一节）算 0。
 */
function stickyCoverAbove(row: HTMLElement): number {
  for (let p = row.previousElementSibling; p; p = p.previousElementSibling) {
    if (p.classList.contains(styles.sSection)) return (p as HTMLElement).offsetHeight;
  }
  return 0;
}

/**
 * 把第一条命中滚到视口上沿。
 *
 * 🔴 不能直接用 `scrollIntoView`：`.sSection` 是 `position: sticky; top: 0` 的吸顶标题，
 * 命中行只要贴着滚动口顶部就整条被它盖住（搜「主题配色」即现：滚到位了，但那一行在标题底下）。
 * 所以按**当前**几何算出目标 scrollTop 再滚——平滑动画途中不重新测量，免得读到中途的 rect。
 * 已经在「标题下方」完整可见的行不动它：本 effect 每次渲染都跑，跟用户抢滚动条是最糟的体验。
 */
function scrollToHit(row: HTMLElement, container: HTMLElement) {
  const scroller = scrollerOf(container);
  if (!scroller) {
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const rect = row.getBoundingClientRect();
  const cover = stickyCoverAbove(row) + 8;
  const top = rect.top - scroller.getBoundingClientRect().top;
  if (top >= cover && rect.bottom <= scroller.getBoundingClientRect().bottom) return;
  scroller.scrollTo({ top: scroller.scrollTop + top - cover, behavior: "smooth" });
}

/**
 * 「· 分布在「X」「Y」」：分区名最多列 2 个，剩下的折成「等 N 处」。
 * 横幅可用宽度在 550px 窗口下只有 ~320px（还要减图标、「清除」按钮和「… 命中 N 项」），
 * 全列的话四个节名就把关键词那段顶掉了，末尾直接变成省略号。
 */
function distText(titles: string[]): string {
  if (titles.length === 0) return "";
  const shown = titles.slice(0, 2).join("」「");
  const more = titles.length > 2 ? ` 等 ${titles.length} 处` : "";
  return ` · 分布在「${shown}」${more}`;
}

/**
 * 在标题/描述文本节点里给关键词包 <mark>。
 * 只动这两个节点：整行 walk 会碰开关「开/关」和数值，误伤状态文案。
 */
function highlightSearchKw(row: HTMLElement, kw: string) {
  if (!kw) return;
  const targets = row.querySelectorAll<HTMLElement>(
    "." + styles.sRowLabel + ", ." + styles.sRowDesc,
  );
  for (const box of targets) {
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        const lower = text.toLowerCase();
        let from = 0;
        let idx = lower.indexOf(kw, from);
        if (idx < 0) return;
        const frag = document.createDocumentFragment();
        while (idx >= 0) {
          if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
          const mark = document.createElement("mark");
          mark.className = styles.searchMark;
          mark.textContent = text.slice(idx, idx + kw.length);
          frag.appendChild(mark);
          from = idx + kw.length;
          idx = lower.indexOf(kw, from);
        }
        if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
        node.parentNode?.replaceChild(frag, node);
        return;
      }
      // 深拷贝子节点列表：高亮过程中会改树
      Array.from(node.childNodes).forEach(walk);
    };
    Array.from(box.childNodes).forEach(walk);
  }
}

export interface SettingsSearch {
  filter: string;
  setFilter: (v: string) => void;
  /** 输入框 ref：Ctrl+F / `/` 聚焦用 */
  inputRef: RefObject<HTMLInputElement | null>;
  // ❗ 写 `| null`：React 19 的 useRef<T>(null) 返回 RefObject<T | null>，
  // 声成 RefObject<T> 会编不过。
  /** 挂在装设置行的容器上（它的 children 必须是一层扁平的行） */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 挂在「无结果」提示上 */
  noResultRef: RefObject<HTMLDivElement | null>;
  /** 挂在搜索框旁的计数 <span> 上（该 span 不要渲染子节点） */
  countRef: RefObject<HTMLSpanElement | null>;
  /** 挂在结果条摘要上：「命中 N 项 · 分布在…」由 effect 写入 */
  summaryRef: RefObject<HTMLSpanElement | null>;
}

/** dev 下别名表校验只做一次（模块级，不随组件重挂重算） */
let aliasChecked = false;

/**
 * 设置页搜索：关键词状态 + 对容器做原地过滤 + 结果语境。
 *
 * 从 useSettingsData 里拆出来的，因为搜索框搬到了**左侧菜单顶部**（SettingsView 持有），
 * 而装设置行的容器在 GeneralTab 里——两边靠这组 ref 对接。
 */
export function useSettingsSearch(): SettingsSearch {
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const noResultRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const summaryRef = useRef<HTMLSpanElement>(null);

  /**
   * 一轮过滤：改写每行显隐与底纹 → 定标题 → 写空态/计数/横幅 → 滚到首条命中。
   *
   * 🔴 这套过滤要求 containerRef 的 children 是「一层扁平的行」：分区标题
   * 和设置行是兄弟节点。所以分区组件必须返回 <>…</> 片段，不能包一层 <div>，
   * 否则遍历到的是分区外壳而不是行，搜索会静默失效（界面看着正常）。
   */
  const applyFilter = useCallback(() => {
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

    // 先拆掉上一轮的 mark，再过滤/重高亮
    clearSearchMarks(container);

    interface Head { el: HTMLElement; title: string; direct: number; shown: number; titleHit: boolean }

    // 第一遍：按文本匹配显示/隐藏每个设置行（分区标题留到第二遍）
    let visibleCount = 0;
    let hitCount = 0;
    /** 按 DOM 顺序记录的每个标题，第二遍和横幅都用它 */
    const heads: Head[] = [];
    // 分区标题自己命中时，整节展开——搜「外观」「数据管理」这种词本来就应当有结果
    let sectionHit = false;
    let cur: Head | null = null;
    for (const el of children) {
      if (el.classList.contains(styles.sSection)) {
        const title = sectionTitleOf(el);
        sectionHit = kw !== "" && [title, ...(SETTING_SECTION_ALIASES[title] ?? [])]
          .some((name) => name.toLowerCase().includes(kw));
        cur = { el, title, direct: 0, shown: 0, titleHit: sectionHit };
        heads.push(cur);
        continue;
      }
      // 空关键词时短路，不去走 rowHaystack 的 DOM 遍历（这是常态）
      const direct = kw !== "" && rowHaystack(el).includes(kw);
      const match = kw === "" || sectionHit || direct;
      el.style.display = match ? "" : "none";
      // 底纹只给「自己命中」的行；因分区名命中而整节展开时不加，否则一整节都是底纹。
      // React 每次渲染会按 props 重置 className，但本 effect 每次渲染后都跑，会补回来
      el.classList.toggle(styles.settingsHit, direct);
      if (direct) {
        hitCount++;
        if (cur) cur.direct++;
        highlightSearchKw(el, kw);
      }
      if (match) {
        visibleCount++;
        if (cur) cur.shown++;
      }
    }
    // 第二遍：决定每个分区标题的显隐。
    //
    // 🔴 不能只看「本节有没有可见行」——合并分区（「同步与互联」下三个小节标题连排）
    // 会让主标题**自己一行都没有**，按旧算法它永远隐藏，于是左菜单点它没有落点
    // （`findNavEl` 跳过 display:none 的标题）。新规则三条：
    //   ① 不搜索 → 全显示；
    //   ② 本节有可见行 → 显示；
    //   ③ 紧跟着的是一个**可见的**小节标题 → 也显示（它是这条链的入口）。
    // 从后往前扫，所以 ③ 看到的是已经定过稿的下一节，连续的纯小节标题能一路串到主标题。
    const isHead = (el: HTMLElement | undefined) =>
      !!el && el.classList.contains(styles.sSection);
    for (let i = children.length - 1; i >= 0; i--) {
      const el = children[i];
      if (!isHead(el)) continue;
      const next = children[i + 1];
      const nextShownHead = isHead(next) && next.style.display !== "none";
      const stat = heads.find((h) => h.el === el);
      el.style.display = kw === "" || (stat?.shown ?? 0) > 0 || nextShownHead ? "" : "none";
    }
    /** 屏幕上真算「结果」的分区：本节有直接命中的，加上节名命中而整节展开的。
     *  只看直接命中会漏——搜「外观」时一行都没命中，但那一节整节摆在那儿。 */
    const resultTitles = heads
      .filter((h) => h.el.style.display !== "none" && (h.direct > 0 || h.titleHit))
      .map((h) => h.title);

    if (noResultRef.current) {
      noResultRef.current.style.display = kw && visibleCount === 0 ? "" : "none";
    }
    // 计数写 DOM 而不是走 state：本 effect 每次渲染都跑，setState 会绕回来。
    // 对应的 <span> 不渲染任何子节点，React 不会覆盖这里写进去的文本。
    // ❗ 框旁那个数是「看得见几项」，取 visibleCount 而不是 hitCount：
    //    整节展开的那些行同样是结果，只报直接命中会又跟横幅对不上。
    if (countRef.current) {
      countRef.current.textContent = kw ? `${visibleCount} 项` : "";
    }
    if (summaryRef.current) {
      if (!kw) {
        summaryRef.current.textContent = "";
      } else if (visibleCount === 0) {
        summaryRef.current.textContent = "没有匹配项";
      } else if (hitCount === 0) {
        // 一行都没命中、却有内容可见 ⇒ 全靠节名命中。这时说「没有匹配项」
        // 等于当着一屏结果说没有（搜「外观」「谁能连进来」即现）。
        const scope = resultTitles.length > 1
          ? `「${resultTitles[0]}」等 ${resultTitles.length} 个`
          : `「${resultTitles[0] ?? ""}」`;
        summaryRef.current.textContent = `${scope}分区名命中 · 整节 ${visibleCount} 项`;
      } else {
        summaryRef.current.textContent = `命中 ${hitCount} 项${distText(resultTitles)}`;
      }
    }
    // 滚到第一条直接命中，省得搜完还要自己找（U1）
    if (kw) {
      const first = container.querySelector<HTMLElement>("." + styles.settingsHit);
      if (first) scrollToHit(first, container);
    }
  }, [filter]);

  // 不写依赖数组＝每次渲染后都重跑。过滤是对真实 DOM 做的，而 React 新插入的节点
  // 默认 display 为空串，会绕过当前关键词直接显形；只要容器里有条件渲染的分区
  // （局域网同步、知识库同步…），漏列一项就是搜索静默失效。列举依赖必然漏，故不列。
  useLayoutEffect(() => {
    applyFilter();
  });

  /**
   * 🔴 上面那条只覆盖「本组件渲染了」的那半边。**折叠组展开、懒挂载面板填进来、
   * 条件行出现**这些新行不引起 SettingsView 重渲染，于是它们顶着默认 display 直接显形，
   * 而计数还停在「没有匹配项」——旧注释里那句「每次渲染都跑」对这些时刻是假话。
   * 观察容器**直接子节点的增删**就够：一层扁平契约 ⇒ 新行必然是直接子节点。
   *
   * ❗ 故意不观察 subtree / attributes：底纹 `<mark>` 注入和 display 改写都在子树与属性上，
   * 观察到它们会让「应用过滤 → 触发观察 → 再应用过滤」自激成无限循环。
   * 只在搜索态挂（空关键词时没有需要维持的过滤结果），一帧最多重跑一次。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !filter.trim() || typeof MutationObserver === "undefined") return;
    let raf = 0;
    const ro = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyFilter();
      });
    });
    ro.observe(container, { childList: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [filter, applyFilter]);

  return { filter, setFilter, inputRef, containerRef, noResultRef, countRef, summaryRef };
}
