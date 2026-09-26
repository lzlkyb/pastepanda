/**
 * 自动保存：内容变化后 1 秒防抖落盘。
 *
 * 三条不变量（都是从原 `useDocumentFile` 逐字搬来的取舍，别随手改）：
 *   ① **无人值守 ⇒ 绝不弹窗**。碰到「文件已被外部修改」时不能问用户（他可能不在
 *      电脑前），更不能直接覆盖 —— 那是背景里静默干掉别人的改动。做法是**跳过本轮**
 *      并保留脏状态，交给 useFileWatch 的轮询那条路（externalChanged → 弹二选一）。
 *   ② **失败不弹窗，但必须显式化**。在状态栏把「存不进去」亮出来（`autoSaveError`），
 *      否则界面与「还没到存盘时机」完全一样。脏状态保留，用户仍可 Ctrl+S 手动重试。
 *   ③ **保存成功必须 markSynced**。不更新基准的话，下一轮轮询会把**自己刚写的**
 *      认成外部改动，2 秒后弹一句「文件已在外部更新」并把用户改的东西重载掉。
 *
 * ❗ 不因标签切走而暂停：开自动保存就是为了不管它，切走 = 不再保存，是把「保活」变「保丢」。
 *
 * 从 `useDocumentFile` 拆出，动因是 `docs/结构设计规范.md` §3.1 的 `.ts ≤ 400` 红线。
 *
 * 🔴 依赖数组的坑（原实现靠 `eslint-disable` 绕过，这里换成了正确的写法）：
 *    原来注释写「千万不能补 fileWatch：它每渲染换引用，补上后定时器会被反复重排，
 *    自动保存就永远触发不了」。**那个对象确实每渲染换引用，但它的方法不是**
 *    —— `markSynced` 恒定，`checkNow` 只在 filePath 变时才换。所以依赖里放
 *    `checkNow` / `markSynced` 而不是 `fileWatch` 对象，既不会重排定时器，
 *    又能在 useFileWatch 改内部依赖时被 ESLint 提醒（不再是一个静默地雷）。
 */
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLatest } from "@/hooks/useLatest";
import type { FileWatch } from "../useFileWatch";

/** 防抖时长（ms） */
const DEBOUNCE_MS = 1000;

export interface AutoSaveOptions {
  /** 设置里的自动保存开关 */
  enabled: boolean;
  /** 当前文本 */
  text: string;
  /** 「已保存基线」：text === baseline 表示无改动，不需要保存 */
  baseline: string;
  effectiveSourceId: string | null;
  currentFilePath: string | null;
  /** 只取其中的 `checkNow` / `markSynced`（见文件头第 3 条与依赖数组说明） */
  fileWatch: FileWatch;
  /** 状态回写口。都是 useState 的 setter，身份稳定，可直接进依赖数组。 */
  setIsSaving: (v: boolean) => void;
  setInitialContent: (v: string) => void;
  setIsDirty: (v: boolean) => void;
  setAutoSaveError: (v: boolean) => void;
}

export function useAutoSaveFile({
  enabled,
  text,
  baseline,
  effectiveSourceId,
  currentFilePath,
  fileWatch,
  setIsSaving,
  setInitialContent,
  setIsDirty,
  setAutoSaveError,
}: AutoSaveOptions): void {
  const { checkNow, markSynced } = fileWatch;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 「此刻的文本」。写盘是 await 的，判断脏标记必须用它而不是闭包里的 `text`
   * —— 见下面 `setIsDirty` 处的说明。
   */
  const latestTextRef = useLatest(text);

  useEffect(() => {
    // 功能关闭 / 无保存目标（新建未命名文档）/ 无改动 → 不触发
    if (!enabled) return;
    if (!effectiveSourceId && !currentFilePath) return;
    if (text === baseline) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const snapshot = text;
      setIsSaving(true);
      try {
        if (effectiveSourceId) {
          // 卡片 → 回写数据库（主窗口经 history-item-updated 事件刷新）
          await invoke("update_history", { id: effectiveSourceId, text: snapshot });
        } else if (currentFilePath) {
          // ① 外部改动：跳过本轮、保留脏状态（绝不弹窗、绝不覆盖）
          if (await checkNow()) return;
          // 文件 → 写回磁盘（自动保存不写剪贴板历史，避免重复入历史）
          await invoke("write_text_file_full", { path: currentFilePath, text: snapshot });
          // ③ 必须更新基准
          await markSynced(currentFilePath);
        }
        setInitialContent(snapshot);
        /**
         * ❗ 不能无条件 `setIsDirty(false)`。写盘是 await 的，这期间用户完全可能
         * 又打了字 —— 那时 `text` 早已不等于刚写下去的 `snapshot`，置 false 等于把
         * **未保存的新文本**标成「已保存」。后果不是显示错，而是丢稿：关闭守卫按
         * `isDirty` 决定要不要拦，它会认定「没东西要存」而直接关窗、直接丢。
         *
         * 暴露面是从写盘返回到下一轮防抖到期这 ~1 秒（实测：
         * `{text:"v2", baseline:"v1", isDirty:false}`）。
         *
         * 判据必须取「此刻的 text」——用 ref 而不是闭包变量。
         * 基线用 `snapshot` 是对的：写下去的就是它，不能用别的值。
         */
        setIsDirty(latestTextRef.current !== snapshot);
        setAutoSaveError(false); // 成功一次即清错
      } catch {
        // ② 失败不弹窗，但把「存不进去」显式化
        setAutoSaveError(true);
      } finally {
        setIsSaving(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [
    text,
    baseline,
    effectiveSourceId,
    currentFilePath,
    enabled,
    checkNow,
    markSynced,
    setIsSaving,
    setInitialContent,
    setIsDirty,
    setAutoSaveError,
    // useLatest 返回的 ref 身份恒定（列进来只为满足 exhaustive-deps）
    latestTextRef,
  ]);
}
