/**
 * AiCustomProviderDialog.tsx —— v6.4 AI 面板 v2：添加/编辑自定义服务商。
 *
 * 用户可配置多个中转/代理服务，每个独立 名称/地址/模型/协议（密钥按 id 单独存）。
 * 校验只拦最明显的空值（名称、地址）；模型留空允许（后端有默认语义）。
 */
import { memo, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { aiSaveCustomProvider, type CustomProviderInput } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./AiCustomProviderDialog.module.css";
import { useDialogEscape } from "@/hooks/useDialogEscape";

export interface CustomEditorState {
  mode: "add" | "edit";
  /** edit 时携带原条目 */
  item?: { id: string; name: string; baseUrl: string; model: string; protocol: string };
}

export const AiCustomProviderDialog = memo(function AiCustomProviderDialog({
  editor,
  onClose,
  onSaved,
}: {
  editor: CustomEditorState;
  onClose: () => void;
  /** 保存成功（isNew = 新增） */
  onSaved: (id: string, isNew: boolean) => void;
}) {
  const { toast } = useToast();
  const { backdrop, panel } = useDialogAnim();
  const isNew = editor.mode === "add";
  const [name, setName] = useState(editor.item?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(editor.item?.baseUrl ?? "");
  const [model, setModel] = useState(editor.item?.model ?? "");
  const [protocol, setProtocol] = useState(editor.item?.protocol || "openai");
  const [saving, setSaving] = useState(false);

  const canSave = name.trim().length > 0 && baseUrl.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: CustomProviderInput = {
        id: editor.item?.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        protocol: protocol as CustomProviderInput["protocol"],
      };
      const id = await aiSaveCustomProvider(payload);
      toast(isNew ? "已添加自定义服务商" : "已保存修改", "success");
      onSaved(id, isNew);
    } catch (e) {
      toast(typeof e === "string" ? e : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  // Esc 单独走公共 hook（捕获期 + stopPropagation）：本弹窗从设置页打开，
  // 不阻断的话 App 的 Esc 链会把**整个设置页**一起关掉。
  useDialogEscape(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && canSave) void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSave, name, baseUrl, model, protocol]);

  return (
    <AnimatePresence>
      <motion.div {...backdrop} className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
          <motion.div
            {...panel}
            className={`dialog-box w460 ${styles.box}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 className="dialog-title">{isNew ? "添加自定义服务商" : "编辑自定义服务商"}</h2>
              <button onClick={onClose} className="dialog-close" aria-label="关闭">
                <X size={16} />
              </button>
            </div>

            <div className={styles.body}>
              <label className={styles.field}>
                <span className={styles.label}>名称 <b className={styles.req}>*</b></span>
                <input
                  className={styles.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：公司中转站 / ChatGLM 代理"
                  autoFocus
                />
              </label>

              <label className={styles.field}>
                <span className={styles.label}>接口地址 <b className={styles.req}>*</b></span>
                <input
                  className={styles.input}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://你的中转地址/v1"
                />
              </label>

              <label className={styles.field}>
                <span className={styles.label}>默认模型</span>
                <input
                  className={styles.input}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="如：gpt-4o（可留空，选模型时再填）"
                />
              </label>

              <div className={styles.field}>
                <span className={styles.label}>接口协议</span>
                <div className={styles.segs}>
                  <button
                    className={`${styles.seg}${protocol === "openai" ? ` ${styles.segOn}` : ""}`}
                    onClick={() => setProtocol("openai")}
                  >
                    OpenAI 兼容
                  </button>
                  <button
                    className={`${styles.seg}${protocol === "anthropic" ? ` ${styles.segOn}` : ""}`}
                    onClick={() => setProtocol("anthropic")}
                  >
                    Anthropic 协议
                  </button>
                </div>
              </div>

              <div className={styles.actions}>
                <button className={styles.cancel} onClick={onClose}>取消</button>
                <button className={styles.save} disabled={!canSave} onClick={() => void save()}>
                  {saving ? "保存中…" : isNew ? "添加" : "保存"}
                </button>
              </div>
            </div>
          </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
});
