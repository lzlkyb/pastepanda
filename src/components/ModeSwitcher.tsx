import { CONTENT_TRANSITION } from "@/lib/motion";
/**
 * ModeSwitcher.tsx — 顶栏三模式切换器（D15，规划 §8.1 0️⃣）。
 *
 * 「记录 ｜ 工具 ｜ 知识」三个模式，**纯文字不带图标**。
 *
 * 为何去图标（改回来前先读）：
 * - 📋 已被「全部」页签占用（`TopBar.tsx` TABS[0]），同屏会出现两个 📋；
 * - 📝 已被「文本」页签与「片段库」占用；
 * - 纯文字同时解掉宽度问题：带图标 200px → 纯文字 138px，480px 窗宽下
 *   才能与「名位正在显下载进度 + AiStatusCap 在场」共存不溢出。
 *
 * 为何是二字名：三字（剪贴板/工具箱/知识库）切换器要 162px，下载态下溢出。
 */
import { motion } from "framer-motion";
import { useAppStore, type AppMode } from "@/stores/appStore";
import styles from "./ModeSwitcher.module.css";

const MODES: { key: AppMode; label: string; tip: string }[] = [
  { key: "record", label: "记录", tip: "剪贴板历史与搜索" },
  { key: "tools", label: "工具", tip: "依次粘贴 / 片段库 / 编码转换等工具" },
  { key: "knowledge", label: "知识", tip: "知识库：笔记，以及可以存成笔记的内容" },
];

export function ModeSwitcher() {
  const appMode = useAppStore((s) => s.appMode);
  const setAppMode = useAppStore((s) => s.setAppMode);

  return (
    <div className={styles.modes} role="tablist" aria-label="应用模式" data-tauri-drag-region="false"
      onKeyDown={event => {
        const current = MODES.findIndex(mode => mode.key === appMode);
        const index = event.key === "Home" ? 0 : event.key === "End" ? MODES.length - 1
          : event.key === "ArrowRight" ? (current + 1) % MODES.length
          : event.key === "ArrowLeft" ? (current + MODES.length - 1) % MODES.length : -1;
        if (index < 0) return;
        event.preventDefault(); setAppMode(MODES[index].key);
        event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
      }}>
      {MODES.map((m) => {
        const active = appMode === m.key;
        return (
          <button
            key={m.key}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={m.tip}
            className={`${styles.mode}${active ? ` ${styles.modeActive}` : ""}`}
            onClick={() => setAppMode(m.key)}
          >
            {/* 与内容切换并行，不等待上一页退出。 */}
            {active && (
              <motion.div
                layoutId="mode-active"
                className={styles.indicator}
                transition={CONTENT_TRANSITION}
              />
            )}
            <span className={styles.label}>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
