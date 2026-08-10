/**
 * ProfileRefine.tsx — LLM 精炼画像（V3-C）。
 *
 * 把统计画像（角色概率/领域/动作/时段/偏好）交给云端 LLM，
 * 润色成一段"像人话"的画像描述（2~3 句），可复制给其它 AI 工具。
 *
 * 红线：出网内容 = 纯统计值（后端已做 is_secret 清洗 + 日预算 + 用量记账）；
 * 手动触发（按钮），每次生成都是用户主动、可见的一次出网。
 */

import { useState } from "react";
import { Sparkles, Loader2, Copy, Check, ShieldAlert } from "lucide-react";
import { profileRefine } from "@/lib/api/profile";
import { useToast } from "@/components/Toast";
import styles from "./ProfileRefine.module.css";

export function ProfileRefine() {
  const { toast } = useToast();
  const [refining, setRefining] = useState(false);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (refining) return;
    setRefining(true);
    try {
      const out = await profileRefine();
      setText(out.trim());
      toast("画像描述已生成", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRefining(false);
    }
  };

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast("已复制", "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>
          <Sparkles size={12} />
          AI 画像描述
        </span>
        <span className={styles.hint}>把统计画像说成人话 · 出网计费 · 手动触发</span>
      </div>

      {!text && (
        <button className={styles.gen} onClick={() => void generate()} disabled={refining}>
          {refining ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
          {refining ? "生成中…" : "生成画像描述"}
        </button>
      )}

      {text && (
        <div className={styles.result}>
          <p className={styles.text}>{text}</p>
          <div className={styles.ops}>
            <button className={copied ? styles.copyDone : styles.copy} onClick={() => void copy()}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "已复制" : "复制"}
            </button>
            <button className={styles.reg} onClick={() => { setText(""); setCopied(false); }}>
              重新生成
            </button>
          </div>
        </div>
      )}

      <div className={styles.note}>
        <ShieldAlert size={11} />
        只发送行为统计（不含内容），敏感信息已清洗，计入日预算。
      </div>
    </div>
  );
}
