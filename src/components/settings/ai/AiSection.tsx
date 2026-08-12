/**
 * 手风琴条目的**统一外壳**（方案 B）。
 *
 * 存在意义是消掉“一页 4 套卡片语言”：改之前 `.cfgCard` 是“有边框卡 + 整卡头 + Chevron”，
 * 三个 `.advanced` 是“一条上边框 + 纯文字按钮”，QuotaEntryCard 又是第四套。
 * 现在所有可折叠区块都走这一个组件，新增区块时不可能再长歪。
 *
 * 展开态由父级（AiTab）统一持有并互斥——同一时刻只有一个展开，
 * 页面高度因此基本恒定，不用长滚。
 */

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import styles from "../AiTab.module.css";

interface Props {
  icon: ReactNode;
  title: string;
  /** 折叠态也能看到的关键值（如“12 次 · ¥0.08”），不展开就有信息 */
  subtitle?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** 头部右侧的高频操作（如“测试连接”） */
  action?: ReactNode;
  children: ReactNode;
}

export function AiSection({ icon, title, subtitle, open, onToggle, action, children }: Props) {
  return (
    <div className={`${styles.accItem}${open ? ` ${styles.accItemOpen}` : ""}`}>
      {/*
       * 头部是一个 div，里面摆三个**并列**节点，而不是“一个大按钮包住所有东西”。
       * 旧的 .cfgHead 就是后者：一个 <button> 里嵌了“测试连接”另一个 <button>。
       * 嵌套按钮是无效 HTML，而且得靠 e.stopPropagation() 才不会“点测试顺手把区块折叠了”。
       * 拆成兄弟节点后两个问题一起消失，也不需要 stopPropagation。
       */}
      <div className={`${styles.accHead}${open ? ` ${styles.accHeadOpen}` : ""}`}>
        <button className={styles.accHeadMain} onClick={onToggle} aria-expanded={open}>
          <span className={styles.accIcon}>{icon}</span>
          <span className={styles.accTitles}>
            <span className={styles.accName}>{title}</span>
            {subtitle && <span className={styles.accSub}>{subtitle}</span>}
          </span>
        </button>
        {action}
        <button
          className={styles.accChev}
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `收起${title}` : `展开${title}`}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
      {open && <div className={styles.accBody}>{children}</div>}
    </div>
  );
}
