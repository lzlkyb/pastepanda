/**
 * 图文混排（rich）富文本编辑器 —— 基于 Tiptap 的所见即所得编辑。
 *
 * 与 MD 全屏编辑器（CodeMirror）的区别：MD 编辑的是带语法符号的源码文本，
 * 这里编辑的是真实 HTML 本身（从 Word/浏览器复制过来的内容本来就没有 markdown 语法），
 * 两者数据模型不同，所以是两个独立组件、不是同一个编辑器加个开关。
 *
 * 图片的存储/显示双格式处理全部收在 lib/richContent.ts，本文件只负责交互。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Bold, Italic, Strikethrough, List, ListOrdered, ImagePlus } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import type { EditorProps } from "@/lib/editorRegistry";
import {
  toDisplayHtml,
  toStoredHtml,
  richToPlainText,
  pathToFileUrl,
  countImages,
} from "@/lib/richContent";
import { logger } from "@/lib/logger";
import styles from "./RichEditor.module.css";

/**
 * 扩展官方 Image 扩展，多带一个 data-src 属性。
 * 作用见 richContent.ts 的注释：src 存显示用的 asset 地址，data-src 原样保留
 * file:// 存储路径，保存时直接读回，不靠反解 asset URL。
 */
const RichImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "data-src": {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-src"),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs["data-src"] ? { "data-src": attrs["data-src"] as string } : {},
      },
    };
  },
});

/** 将一张图片文件存入应用图片库，返回可直接插入编辑器的 { src, dataSrc } */
async function persistImage(file: File): Promise<{ src: string; dataSrc: string }> {
  const { invoke } = await import("@tauri-apps/api/core");
  const buf = new Uint8Array(await file.arrayBuffer());
  // 分块转 base64，避免大图时 String.fromCharCode(...arr) 参数过多爆栈
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  const path = await invoke<string>("save_rich_image", { dataBase64: btoa(binary) });
  return { src: convertFileSrc(path), dataSrc: pathToFileUrl(path) };
}

/** 工具栏按钮 */
function ToolBtn({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${styles.toolBtn}${active ? ` ${styles.toolBtnActive}` : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={!!active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * 富文本编辑器核心（弹窗与全屏共用）。
 * 受控方式：只在挂载时用 initialHtml 初始化，后续变更通过 onChange 向上报，
 * 不把外部 state 反向灌回编辑器（否则每次击键都会重置光标位置）。
 */
export function RichContentEditor({
  initialHtml,
  onChange,
  editable = true,
  minHeight,
}: {
  /** 存储格式的 HTML 片段（内部自行转显示格式） */
  initialHtml: string;
  /** 内容变更回调，回传的是存储格式的 HTML */
  onChange?: (storedHtml: string) => void;
  editable?: boolean;
  minHeight?: number;
}) {
  const { toast } = useToast();

  const editor = useEditor({
    editable,
    extensions: [
      // 关掉不在工具栏里、也不属于图文混排场景的能力，避免用户通过快捷键
      // 或粘贴弄出一堆保存时会被消毒剔掉的结构（改完看着生效、保存后又没了）。
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
      }),
      RichImage.configure({ inline: false, allowBase64: false }),
    ],
    content: toDisplayHtml(initialHtml),
    onUpdate: ({ editor: ed }) => {
      onChange?.(toStoredHtml(ed.getHTML()));
    },
    editorProps: {
      attributes: {
        class: styles.proseArea,
        ...(minHeight ? { style: `min-height:${minHeight}px` } : {}),
      },
      /** 粘贴拦截：剪贴板里带图片时先落盘再插入，不让 base64 直接进正文 */
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files || []).filter((f) =>
          f.type.startsWith("image/")
        );
        if (files.length === 0) return false;
        event.preventDefault();
        (async () => {
          for (const file of files) {
            try {
              const { src, dataSrc } = await persistImage(file);
              const { state, dispatch } = view;
              const node = state.schema.nodes.image.create({ src, "data-src": dataSrc });
              dispatch(state.tr.replaceSelectionWith(node));
            } catch (e) {
              logger.error("粘贴图片保存失败", e);
              toast("图片保存失败: " + (e instanceof Error ? e.message : String(e)), "error");
            }
          }
        })();
        return true;
      },
    },
  });

  /** 工具栏插图：走隐藏 file input（不用系统对话框插件，避免多一层权限与路径校验） */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handlePickImages = useCallback(
    async (files: FileList | null) => {
      if (!files || !editor) return;
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const { src, dataSrc } = await persistImage(file);
          editor.chain().focus().setImage({ src, "data-src": dataSrc } as never).run();
        } catch (e) {
          logger.error("插入图片失败", e);
          toast("插入图片失败: " + (e instanceof Error ? e.message : String(e)), "error");
        }
      }
    },
    [editor, toast]
  );

  if (!editor) return null;

  return (
    <div className={styles.wrap}>
      {editable && (
        <div className={styles.toolbar} role="toolbar" aria-label="格式工具栏">
          <ToolBtn
            title="加粗 (Ctrl+B)"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold size={14} />
          </ToolBtn>
          <ToolBtn
            title="斜体 (Ctrl+I)"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic size={14} />
          </ToolBtn>
          <ToolBtn
            title="删除线"
            active={editor.isActive("strike")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough size={14} />
          </ToolBtn>
          <span className={styles.toolSep} />
          <ToolBtn
            title="无序列表"
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List size={14} />
          </ToolBtn>
          <ToolBtn
            title="有序列表"
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered size={14} />
          </ToolBtn>
          <span className={styles.toolSep} />
          <ToolBtn title="插入图片（也可直接 Ctrl+V 粘贴）" onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={14} />
          </ToolBtn>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              handlePickImages(e.target.files);
              e.target.value = ""; // 清空以便同一文件能再选一次
            }}
          />
        </div>
      )}
      <EditorContent editor={editor} className={styles.content} />
    </div>
  );
}

/**
 * 弹窗形态（ItemEditorDialog 的 shell 变体）。
 * 保存走 update_history_rich（同时写 content + text），
 * 复制/粘贴走 copy_rich_only / paste_rich（CF_HTML + 纯文本一起写剪贴板）。
 */
export function RichEditor({ item, registerActions }: EditorProps) {
  const { toast } = useToast();
  const originalHtml = item.content || "";
  const [html, setHtml] = useState(originalHtml);

  // 最新值入 ref，供注册给外壳的闭包读取（避免过期快照，同 useEditorCore 的做法）
  const htmlRef = useRef(html);
  htmlRef.current = html;

  const save = useCallback(async (): Promise<boolean> => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const stored = htmlRef.current;
      const plain = richToPlainText(stored);
      await invoke("update_history_rich", {
        id: item.id,
        htmlFragment: stored,
        plainText: plain,
      });
      // 乐观更新：text 影响搜索过滤，同步清 _filterCache（同 useEditorCore）
      useAppStore.setState((s) => ({
        history: s.history.map((h) =>
          h.id === item.id ? { ...h, content: stored, text: plain, md5: undefined } : h
        ),
        _filterCache: null,
      }));
      toast("已保存", "success");
      return true;
    } catch (e) {
      toast("保存失败: " + (e instanceof Error ? e.message : String(e)), "error");
      return false;
    }
  }, [item.id, toast]);

  const copy = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("copy_rich_only", {
        htmlFragment: htmlRef.current,
        plainText: richToPlainText(htmlRef.current),
      });
      toast("已复制图文内容", "success");
    } catch (e) {
      toast("复制失败: " + (e instanceof Error ? e.message : String(e)), "error");
    }
  }, [toast]);

  const paste = useCallback(async () => {
    try {
      // 走守卫版（红线②）：原先直接 invoke("paste_rich")，绕过了敏感确认。
      // 编辑器里的内容同样可能含密钥/手机号，不能因为“是用户自己编的”就免检。
      const { pasteRichGuarded } = await import("@/lib/api/paste");
      const ok = await pasteRichGuarded(htmlRef.current, richToPlainText(htmlRef.current));
      if (!ok) return; // 取消或失败（失败时 api 层已弹错）
      toast("已粘贴", "success");
    } catch (e) {
      toast("粘贴失败: " + (e instanceof Error ? e.message : String(e)), "error");
    }
  }, [toast]);

  const isDirty = useCallback(() => htmlRef.current !== originalHtml, [originalHtml]);

  // 每次渲染重新注册，保证外壳拿到的闭包始终新鲜（同 useEditorCore）
  useEffect(() => {
    registerActions({ save, copy, paste, isDirty });
  });

  const imgCount = countImages(html);

  return (
    <>
      <div className={styles.metaBar}>
        <span className={styles.metaBadge}>🖼️📝 图文</span>
        <span className={styles.metaInfo}>共 {imgCount} 张图</span>
        {html !== originalHtml && <span className={styles.metaDirty}>已修改</span>}
        <button
          type="button"
          className={styles.fullscreenBtn}
          title="全屏编辑"
          onClick={async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("open_fullscreen_editor", {
                sourceId: item.id,
                content: htmlRef.current,
                contentType: "rich",
                language: null,
              });
            } catch (e) {
              logger.error("[全屏编辑] 打开失败", e);
              toast("打开全屏失败: " + String(e), "error");
            }
          }}
        >
          ⤢ 全屏
        </button>
      </div>
      <RichContentEditor initialHtml={originalHtml} onChange={setHtml} minHeight={220} />
    </>
  );
}

/** 供卡片缩略图等处复用的类型守卫 */
export function isRichItem(item: HistoryItem): boolean {
  return item.type === "rich";
}
