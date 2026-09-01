/**
 * editors/mdImagePaste.ts — Markdown 编辑器的图片粘贴 / 拖入处理。
 *
 * 从 `FullscreenEditor` 抽出来的（规划 §8.1 1️⃣）：笔记编辑器也要粘图，
 * 而这段逻辑与“定位策略”绑得很紧，不能再写第二遍。
 *
 * **不做成 hook 而是带参数的函数**：它唯一的宿主差异就是 `docDir`（文档所在目录），
 * 全屏编辑器有、笔记弹窗没有（笔记存数据库，不是文件）。一个参数就能表达的差异，
 * 不值得包成 hook。
 */
import { invoke } from "@tauri-apps/api/core";
import { writeFile, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import type { EditorView } from "@codemirror/view";

/** 粘贴/拖入图片的 MIME → 扩展名映射（未知类型兜底 png） */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** Uint8Array → base64。分块是必需的：一次 fromCharCode(...几十万个参数) 会爆栈。 */
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export interface ImagePasteOptions {
  /**
   * 文档所在目录。有值 → 图存到它旁边的 `assets/` 并插**相对路径**；
   * `null` → 回落 `$APPDATA/md-editor-images` 并插绝对路径。
   */
  docDir: string | null;
  /** 失败时的提示回调（不静默，规则 #15.3） */
  onError: (message: string) => void;
}

/**
 * 把粘贴/拖入的图片存盘并在光标处插入 Markdown 引用。
 *
 * 存哪里（改这里前先读）：
 * - 有文档路径 → 存到文档旁边的 `assets/`，插**相对路径**
 * - 无文档路径（剪贴板内容模式 / 笔记）→ 仍落 `$APPDATA/md-editor-images`
 *
 * ❌ 旧实现一律存 $APPDATA 并插**绝对路径**，两个真问题：
 * ① 文档拷给别人 / 换台机器，图全裂（路径指向本机 APPDATA）；
 * ② 用户删掉文档里的引用后，文件永远留在 APPDATA，**没任何清理入口**——
 *   而且因为别的文档/卡片也可能引用它，没法安全地自动 GC。
 * 存到文档旁边后，图跟着文档走：拷走目录就一起拷走，删目录就一起消失。
 *
 * 写文档旁边得走后端命令 `write_binary_file_base64`：fs 插件的 scope 只有
 * `$APPDATA/**`，跟「能另存为、不能原地保存」是同一个原因。
 */
export async function insertPastedImages(
  files: File[],
  view: EditorView,
  { docDir, onError }: ImagePasteOptions,
): Promise<void> {
  try {
    const refs: string[] = [];
    for (const file of files) {
      const ext = IMAGE_EXT[file.type] || "png";
      const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (docDir) {
        const rel = `assets/${name}`;
        await invoke("write_binary_file_base64", {
          path: `${docDir}/${rel}`,
          base64Data: bytesToBase64(bytes),
        });
        // 相对路径 + < > 包裹（兼容含空格的目录名）
        refs.push(`![image](<./${rel}>)`);
      } else {
        const imgDir = await join(await appDataDir(), "md-editor-images");
        await mkdir(imgDir, { recursive: true });
        const fullPath = await join(imgDir, name);
        await writeFile(fullPath, bytes);
        refs.push(`![image](<${fullPath.replace(/\\/g, "/")}>)`);
      }
    }

    const insertText = refs.join("\n");
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: insertText + "\n" },
      selection: { anchor: from + insertText.length + 1 },
    });
    view.focus();
  } catch (e) {
    console.error("[图片粘贴] 保存失败:", e);
    onError(`图片保存失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
