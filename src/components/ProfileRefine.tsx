/**
 * ProfileRefine.tsx — LLM 精炼画像（V3-C）。
 *
 * 把统计画像（角色概率/领域/动作/时段/偏好）交给云端 LLM，
 * 润色成一段“像人话”的画像描述（2~3 句），可复制给其它 AI 工具。
 *
 * 这个组件得自己守住三件事：
 * 1. 门控：AI 未配置时整块折叠成一行提示 + 去设置入口，而不是摆一个点下去才报错的按钮。
 * 2. 云端请求先确认：同一个弹窗往上滚 100px 就写着这条红线，不能自己违反。
 *    后端 profile_refine 走的是裸 Result<String,String>，没有 needsConfirm 三态可分支，
 *    所以确认做在前端：第一次点只亮出“要发给哪家 / 哪个模型”，第二次点才真出网。
 * 3. 结果不能一关窗就丢：ProfileDialog 关闭会卸载整棵子树，遮罩 onClick 直接 close，
 *    误点一下就把刚花钱生成的描述弄没了（后端明确不缓存）；故同步写 sessionStorage。
 */

import { useEffect, useState } from "react";
import {
  Sparkles, Loader2, Copy, Check, ShieldAlert, Settings2, RotateCcw,
} from "lucide-react";
import { profileRefine } from "@/lib/api/profile";
import { aiGetConfig } from "@/lib/api";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { openAiSettings } from "@/lib/openAiSettings";
import { useToast } from "@/components/Toast";
import styles from "./ProfileRefine.module.css";

/**
 * 结果暂存键。用 sessionStorage 而不是 localStorage：这段描述是一次性产物，
 * 应用退出后就该失效，否则下次启动会拿一份过期画像冒充新结果。
 */
const CACHE_KEY = "pastepanda.profileRefine.text";

function loadCached(): string {
  try {
    return sessionStorage.getItem(CACHE_KEY) ?? "";
  } catch {
    return ""; // storage 被禁：退化成“不暂存”，不影响主流程
  }
}

function saveCached(v: string) {
  try {
    if (v) sessionStorage.setItem(CACHE_KEY, v);
    else sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* 存不下就算了，不能因为暂存失败把已生成的结果抹掉 */
  }
}

/**
 * 这几类失败光看一眼提示没用，得能直接去设置改。
 * 匹配的是后端 commands/profile.rs 里的原文：
 * “未配置当前服务商的 API Key” / “AI 功能未启用” / “今日预算已用完…”。
 * “行为样本不足”不在列，因为去设置也解决不了。
 */
function errNeedsSettings(msg: string): boolean {
  return /API Key|未启用|预算/.test(msg);
}

export function ProfileRefine() {
  const { toast } = useToast();
  /**
   * 与全项目一致的“AI 能不能用”判定（规则 15）：不自己再写一份密钥判断。
   * aiTransforms 的注释已经说清：未配置时就不该出现在界面上。
   */
  const aiOn = isAiAvailable();
  const [refining, setRefining] = useState(false);
  /** 两段式确认：true = 已亮出出网提示，等第二次点击 */
  const [armed, setArmed] = useState(false);
  const [text, setText] = useState(loadCached);
  /** 失败留痕：不随 toast 消失，错过浮层的用户也能看到“为什么没反应” */
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  /** 当前服务商 / 模型：确认提示里必须说清“发给谁” */
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!aiOn) return;
    let alive = true;
    void aiGetConfig()
      .then((c) => {
        if (!alive) return;
        const model = c.model.trim();
        setTarget(model ? `${c.provider} · ${model}` : c.provider);
      })
      .catch(() => {
        /* 读不到就退化成泛化措辞，不堵住确认流程 */
      });
    return () => {
      alive = false;
    };
  }, [aiOn]);

  const generate = async () => {
    if (refining) return;
    // 红线「云端请求先确认」：第一次点只上膛，不出网
    if (!armed) {
      setArmed(true);
      setErr("");
      return;
    }
    setArmed(false);
    setRefining(true);
    setErr("");
    try {
      const out = (await profileRefine()).trim();
      setText(out);
      saveCached(out);
      toast("画像描述已生成", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      toast(msg, "error");
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

  /** 重新生成：用户主动丢旧结果，暂存也一并清（否则重开弹窗会把旧的捞回来） */
  const reset = () => {
    setText("");
    saveCached("");
    setCopied(false);
    setArmed(false);
    setErr("");
  };

  // 门控：从未配置过 AI 的用户看到的不应该是一个“✨ 生成画像描述 + 出网计费”，
  // 而是一行说清缘由、并且有处可去的提示。
  if (!aiOn) {
    return (
      <div className={styles.off}>
        <ShieldAlert size={11} className={styles.offIcon} />
        <span className={styles.offMsg}>
          AI 画像描述需要先配置云端服务商——未配置时不摆按钮，免得点下去才报错。
        </span>
        <button className={styles.offBtn} onClick={() => void openAiSettings()}>
          <Settings2 size={10} /> 去设置
        </button>
      </div>
    );
  }

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
        <>
          <button
            className={armed ? styles.genArmed : styles.gen}
            onClick={() => void generate()}
            disabled={refining}
          >
            {refining ? (
              <Loader2 size={13} className="spin" />
            ) : armed ? (
              <ShieldAlert size={13} />
            ) : (
              <Sparkles size={13} />
            )}
            {refining ? "生成中…" : armed ? "确认发送 →" : "生成画像描述"}
          </button>
          {armed && (
            <div className={styles.confirm}>
              <ShieldAlert size={11} className={styles.confirmIcon} />
              <span className={styles.confirmMsg}>
                这一步会出网并计费，发往 <b>{target || "当前云端服务商"}</b>。再点一次按钮确认。
              </span>
              <button className={styles.cancel} onClick={() => setArmed(false)}>
                取消
              </button>
            </div>
          )}
        </>
      )}

      {err && (
        <div className={styles.err}>
          <ShieldAlert size={11} className={styles.errIcon} />
          <span className={styles.errMsg}>{err}</span>
          {errNeedsSettings(err) && (
            <button className={styles.errBtn} onClick={() => void openAiSettings()}>
              <Settings2 size={10} /> 去设置
            </button>
          )}
        </div>
      )}

      {text && (
        <div className={styles.result}>
          <p className={styles.text}>{text}</p>
          <div className={styles.ops}>
            <button className={copied ? styles.copyDone : styles.copy} onClick={() => void copy()}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "已复制" : "复制"}
            </button>
            <button className={styles.reg} onClick={reset}>
              <RotateCcw size={11} /> 重新生成
            </button>
          </div>
          <div className={styles.keep}>
            已暂存在本次运行里：关掉画像弹窗再打开还在；退出应用即清除，想长期留着就先复制走。
          </div>
        </div>
      )}

      <div className={styles.note}>
        <ShieldAlert size={11} />
        出网内容 = 行为统计（角色 / 领域 / 动作 id / 时段）+ 你手写的「风格偏好」「使用红线」原文；
        不包含你复制过的内容。后端只剔除疑似密钥的部分，偏好里的公司名 / 内部代号 / 人名会原样发出。计入日预算。
      </div>
    </div>
  );
}
