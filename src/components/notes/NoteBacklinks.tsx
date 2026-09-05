import { useEffect, useState } from "react";
import { logger } from "@/lib/logger";
import styles from "./NoteDetailPane.module.css";

/** 后端 `data_store::BackLink`。字段名保持与 Rust 一致。 */
interface BackLink {
  from_id: string;
  from_title: string;
  line: number;
}

/**
 * 折叠状态存 localStorage，**全局一份**而不是每篇一份。
 * 用户要表达的是「我平时看不看反链」，不是逐篇记忆。
 */
const LS_KEY = "kbBacklinksOpen";

/**
 * 反链面板（M3-④）：谁用 `[[ ]]` 指向了这一篇。
 *
 * ❗ **单独成一个文件而不是写进 `NoteDetailPane`**：后者已经 320 行，
 * 超了规则 #7 的 300 行上限。
 *
 * 🔴 **全库断链不在这里**。`note_broken_links()` 返回的是整库的断链，
 * 不是「这篇的断链」——放进单篇详情里，用户在看 A 篇却会看到一堆
 * B、C 篇里的断链。它属于「库体检」（`KbHealthBar`），命令层也故意没开。
 */
export function NoteBacklinks({ noteId, onOpenNote }: {
  noteId: string;
  /** 点一条反链时跳过去。上层那个实现**自带脏数据守卫**（`handleOpen`）。 */
  onOpenNote?: (id: string) => void;
}) {
  const [links, setLinks] = useState<BackLink[]>([]);
  const [open, setOpen] = useState(() => localStorage.getItem(LS_KEY) !== "0");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const r = await invoke<BackLink[]>("note_backlinks", { id: noteId });
        if (alive) setLinks(r);
      } catch (e) {
        // 不静默（规则 #15.3），但也不打断阅读：反链是附加信息，
        // 拉不到就当 0 条显示，不该让整个详情面板报错。
        logger.warn("读反链失败", e);
        if (alive) setLinks([]);
      }
    })();
    return () => { alive = false; };
    // ❗ **只依赖 noteId**：反链是「别人指向我」，改本篇不会改变它。
    // 挂 content 依赖等于每敲一下都查一次库（规则 #8）。
  }, [noteId]);

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(LS_KEY, v ? "0" : "1");
      return !v;
    });
  };

  return (
    <div className={styles.backlinks}>
      {/* 🔴 0 条时**仍然显示这一行**，不整块隐掉：
          隐掉会让面板随切笔记时有时无，footer 的位置跟着跳；
          而且「确实没人引用」本身就是信息。 */}
      <button type="button" className={styles.blHead} onClick={toggle}
        title={open ? "收起反链" : "展开反链"}>
        <span className={styles.blCaret}>{open ? "▾" : "▸"}</span>
        被引用
        <span className={`${styles.blCount}${links.length === 0 ? ` ${styles.blCountZero}` : ""}`}>
          {links.length}
        </span>
      </button>

      {open && (links.length > 0 ? (
        <div className={styles.blList}>
          {links.map((l) => (
            // key 带上行号：同一篇里可能多处引用本篇，from_id 单独不唯一
            <button key={`${l.from_id}:${l.line}`} type="button"
              className={styles.blItem} title={l.from_title}
              onClick={() => onOpenNote?.(l.from_id)}>
              <span className={styles.blTitle}>{l.from_title}</span>
              {/* 行号**只展示、不可点跳转**：它只在那篇保存时重算，
                  对方改过而未保存时会跳错位——而跳错位比不能跳更差：
                  用户会以为那里真的引用了他。展示行号只是给个方位感。 */}
              <span className={styles.blLine}>第 {l.line} 行</span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.blEmpty}>还没有别的笔记用 [[ ]] 指向这一篇</div>
      ))}
    </div>
  );
}
