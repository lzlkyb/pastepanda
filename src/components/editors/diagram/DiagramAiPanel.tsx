/**
 * 「AI 生成流程图」提示词面板。内嵌编辑器与全屏编辑器原本各写了一份几乎相同的 JSX
 * （只有文案微差），这里收口成一份，文案取设计稿那版。
 *
 * 红线 #16：面板本身不判断 AI 可不可用，由调用方门控。
 */
import { Loader2 } from "lucide-react";
import type { CSSProperties } from "react";
import styles from "../DiagramEditor.module.css";

/** 快捷示例（与设计稿的 chips 一致） */
const PRESETS = [
  { label: "用户注册登录", prompt: "用户从注册到登录成功的完整流程" },
  { label: "订单退款审批", prompt: "电商订单发起退款到审批通过的流程" },
  { label: "API 请求处理", prompt: "API 请求从发起到返回响应的处理链路" },
  { label: "需求拆测试用例", prompt: "把这段产品需求拆成测试用例" },
];

export function DiagramAiPanel({
  prompt, onPromptChange, loading, onRun, onCancel, style,
}: {
  prompt: string;
  onPromptChange: (v: string) => void;
  loading: boolean;
  onRun: () => void;
  onCancel: () => void;
  /** 全屏形态需要绝对定位到顶栏下方，内嵌形态跟着流走 */
  style?: CSSProperties;
}) {
  return (
    <div className={styles.aiPanel} style={style}>
      <div className={styles.aiTitleRow}>
        <div className={styles.aiPanelTitle}>AI 生成流程图</div>
        <span className={styles.aiBadge}>云端 · 脱敏前置</span>
      </div>
      <div className={styles.aiDesc}>
        用一句话描述流程，AI 自动生成可拖拽编辑的节点与连线。内容在出网前经过脱敏守卫，敏感信息不外泄。
      </div>
      <textarea
        className={styles.aiInput}
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder="例如：复制一段报错日志，自动识别排查步骤并生成流程图"
        rows={2}
      />
      <div className={styles.aiChips}>
        {PRESETS.map((c) => (
          <button key={c.label} type="button" className={styles.aiChip} onClick={() => onPromptChange(c.prompt)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className={styles.aiPanelBtns}>
        <button className={styles.cancelBtn} onClick={onCancel}>取消</button>
        <button className={styles.genBtn} onClick={onRun} disabled={loading || !prompt.trim()}>
          {loading ? (
            <>
              <Loader2 size={13} className={styles.spin} /> 生成中…
            </>
          ) : (
            "生成流程图"
          )}
        </button>
      </div>
    </div>
  );
}
