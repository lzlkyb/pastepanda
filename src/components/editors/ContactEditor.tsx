import { useState, useMemo } from "react";
import { Mail, Phone, Copy, Link2 } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn } from "./editorBits";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 联系人编辑器（接管 email / phone 两种 content_type）。
 * 范式对齐 LinkEditor：顶部校验徽章 + 大值 hero 卡片 + 动作行（唤起/复制/复制为 URI）+ 可编辑文本区。
 * - email  → 「写信」唤起 mailto:，「复制为 mailto 链接」；
 * - phone  → 「拨号」唤起 tel:，「复制为 tel 链接」。
 * 唤起逻辑复用 ImagePreviewDialog 的 openUrl(mailto:/tel:) 写法，符合隐私红线（本地内容 + 用户主动）。
 */

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isValidPhone(s: string): boolean {
  return /^\+?\d{6,15}$/.test(stripPhone(s));
}

/** 号码里的排版字符（空格 / 连字符 / 括号）一律剥掉，只留 + 和数字。
 *  校验与拼 `tel:` 必须用同一个函数：之前校验剥了括号、拼 URI 只剥了空格和连字符，
 *  `+1 (555) 123-4567` 能通过校验却生成 `tel:+1(555)1234567`，括号不是 RFC 3966 的合法字符。 */
function stripPhone(s: string): string {
  return s.replace(/[\s\-()]/g, "");
}

export function ContactEditor({ item, registerActions }: EditorProps) {
  const isEmail = item.content_type === "email";
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  const valid = useMemo(
    () => (isEmail ? isValidEmail(text) : isValidPhone(text)),
    [isEmail, text]
  );

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`已复制${label}`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  const openContact = async () => {
    // 校验不通过就不要交给系统处理器。原先 valid 只用来显示徽章，按钮照样能点——
    // 界面告诉你「格式不正确」却仍然执行，是内部矛盾；而且未校验的文本进 mailto:
    // 会带上 ?subject= / &bcc= 这类参数（参数注入面）。
    //
    // 注：valid 的正则已排除空格 / @ 多次出现 / ? & 等字符，门控成立之后内容天然是
    // URI 安全的，不必再 encodeURIComponent（那会把 @ 变成 %40，「复制为 mailto 链接」
    // 拿出去的文本会变丑）。电话侧的排版括号由 stripPhone 统一剥掉。
    if (!valid) {
      toast(isEmail ? "邮箱格式不正确，无法写信" : "电话格式不正确，无法拨号", "error");
      return;
    }
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      if (isEmail) await openUrl(`mailto:${text.trim()}`);
      else await openUrl(`tel:${stripPhone(text)}`);
    } catch (e) {
      toast("唤起失败: " + String(e), "error");
    }
  };

  const badge = isEmail ? "📧 邮箱" : "📞 电话";
  const status = valid ? (
    <span className="valid-badge">● 合法{isEmail ? "邮箱" : "电话"}</span>
  ) : (
    <span className="invalid-badge">● 格式不正确</span>
  );

  return (
    <>
      <MetaBar
        lineCount={text.split("\n").length}
        charCount={text.length}
        isModified={isModified}
        badge={badge}
        status={status}
      />

      {/* 大值 hero 卡片 + 动作行 */}
      <div className="contact-hero">
        <div className={isEmail ? "value" : "value mono"}>{text || "（空）"}</div>
        <div className="edit-toolbar">
          <ToolBtn
            accent
            icon={isEmail ? <Mail size={13} /> : <Phone size={13} />}
            label={isEmail ? "写信" : "拨号"}
            onClick={openContact}
          />
          <ToolBtn
            icon={<Copy size={13} />}
            label="复制"
            onClick={() => copyToClipboard(text, isEmail ? "邮箱" : "电话")}
          />
          <ToolBtn
            icon={<Link2 size={13} />}
            label={isEmail ? "复制为 mailto 链接" : "复制为 tel 链接"}
            onClick={() =>
              copyToClipboard(
                isEmail ? `mailto:${text.trim()}` : `tel:${stripPhone(text)}`,
                "链接"
              )
            }
          />
        </div>
      </div>

      <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />

      <TransformToolbar
        text={text}
        transform={transform}
        undo={undo}
        redo={redo}
        isModified={isModified}
        showOriginal={showOriginal}
        onToggleOriginal={() => setShowOriginal(!showOriginal)}
        isHtmlContent={false}
      />

      {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
    </>
  );
}
