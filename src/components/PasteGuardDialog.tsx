/**
 * PasteGuardDialog.tsx — 粘贴守卫确认条（v6.2 粘贴前主动）。
 *
 * 检测到剪贴板内容含敏感信息（密钥/手机号/邮箱/身份证/IP）时弹出：
 * 预览脱敏结果 + 显示目标应用，用户选择「脱敏后粘贴 / 原样粘贴 / 取消」。
 * 参考 ChainRunnerDialog 的 pendingAi promise 模式：resolve 后由调用方关闭。
 */

import { useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./PasteGuardDialog.module.css";
import { useDialogEscape } from "@/hooks/useDialogEscape";

export function PasteGuardDialog() {
  const guard = useDialogStore((s) => s.pasteGuard);
  // useCallback：下面 Esc effect 把它当依赖，不 memo 就每次渲染重挂一次监听器
  const close = useCallback(() => useDialogStore.getState().closePasteGuard(), []);
  const anim = useDialogAnim();
  const open = guard !== null;
  // Esc 关闭（公共 hook：捕获期 + stopPropagation，不让 App 的 Esc 链又跑一遍）。
  // ❗ 必须传 `close` 而不是 `close()`：参数在渲染期求值，写成调用会让每次
  //   渲染都执行一次关闭——这条尤其严重：守卫框是用户选“脱敏/原样/取消”
  //   的闸口，它自己关掉 = 敏感内容的确认环节直接消失。
  useDialogEscape(close, open);


  const settle = (v: "mask" | "raw" | "cancel") => {
    guard?.resolve(v);
    close();
  };

  return (
    <AnimatePresence>
      {open && guard && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={() => settle("cancel")}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box w460 ${styles.wrap}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.head}>
                <span className={styles.icon}><ShieldAlert size={15} /></span>
                <h2 className={styles.title}>检测到敏感内容</h2>
                {guard.targetApp && (
                  <span className={styles.target}>将粘贴到 {guard.targetApp}</span>
                )}
                <button onClick={() => settle("cancel")} className="dialog-close" aria-label="取消">
                  <X size={15} />
                </button>
              </div>

              <p className={styles.desc}>
                内容里识别出密钥 / 手机号 / 邮箱 / 身份证 / IP。直接粘贴可能泄露——
                要脱敏后再粘贴吗？
              </p>

              <div className={styles.preview}>
                <div className={styles.previewLabel}>脱敏后效果</div>
                <pre className={styles.previewText}>{guard.maskPreview}</pre>
              </div>

              <div className={styles.ops}>
                <button className={styles.mask} onClick={() => settle("mask")} autoFocus>
                  <ShieldCheck size={13} /> 脱敏后粘贴
                </button>
                <button className={styles.raw} onClick={() => settle("raw")}>
                  原样粘贴
                </button>
                <button className={styles.cancel} onClick={() => settle("cancel")}>
                  取消
                </button>
              </div>

              <div className={styles.note}>
                脱敏在本机完成（规则替换），不会上传内容。
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
