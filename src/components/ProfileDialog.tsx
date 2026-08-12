/**
 * ProfileDialog — 我的画像（M6-2/M6-3）。
 *
 * 画像 = 现有行为数据的实时聚合（纯规则），只含统计值、不含内容；
 * 展示：雷达图（能力维度）+ 领域环形图 + 时段 + 动作 + 偏好 + 红线；
 * 导出：格式卡片三选一 + 大类勾选 + 即时预览 + 一键装进 Claude Code。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, UserRound, Pencil, Loader2 } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { profileGet, profileSetOverride, type UserProfile } from "@/lib/api/profile";
import { ProfileRadar } from "@/components/ProfileRadar";
import { ProfileExport } from "@/components/ProfileExport";
import { ProfileRefine } from "@/components/ProfileRefine";
import { ProfileTrajectory } from "@/components/ProfileTrajectory";
import { AchievementsCard } from "@/components/AchievementsCard";
import { useToast } from "@/components/Toast";
import styles from "./ProfileDialog.module.css";

const ALL_ROLES: [string, string][] = [
  ["developer", "开发者"],
  ["research", "研究/学习"],
  ["writer", "文案/写作"],
  ["comm", "沟通/客服"],
  ["ops", "运营/行政"],
  ["data", "数据/分析"],
];

const ROLE_EMOJI: Record<string, string> = {
  developer: "💻",
  research: "🔬",
  writer: "✍️",
  comm: "💬",
  ops: "📊",
  data: "🧮",
};

export function ProfileDialog() {
  const open = useDialogStore((s) => s.profileOpen);
  const close = useCallback(() => useDialogStore.getState().closeProfile(), []);
  // 审查：Esc 关闭（全局 Esc 对部分场景让位，组件自兜底）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 依赖写 close 而不是 close()：依赖数组是**渲染期构造**的，写成调用形式
    // 等于每次渲染都真的执行一次 closeProfile()——点开弹窗 → 重渲染 → 自己把
    // 自己关了，现象就是“按钮点下去没反应”。
  }, [open, close]);

  const anim = useDialogAnim();
  const { toast } = useToast();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [roleDraft, setRoleDraft] = useState("");
  const [instrDraft, setInstrDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const p = await profileGet();
      setProfile(p);
      // 用 ?. 而不是直读：类型写的是 `Record<string, string>`（非空），但后端曾在
      // “用户从未设过覆盖”时发 null，于是这里抛
      // “Cannot read properties of null (reading 'role')”——每个全新安装都打不开画像。
      // 后端已改成恒返回空对象（overrides_or_empty），这里再加一道：跨 IPC 的类型
      // 无任何运行时校验，tsc 给不了保证，不能只靠后端自律。
      setRoleDraft(typeof p.overrides?.role === "string" ? p.overrides.role : "");
      setInstrDraft(
        typeof p.overrides?.instructions === "string" ? p.overrides.instructions : "",
      );
    } catch (e) {
      toast(`读取画像失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    if (open) void load();
    else setProfile(null);
  }, [open, load]);

  const topRole = useMemo(() => profile?.roleScores[0] ?? null, [profile]);
  const topRoleEmoji = useMemo(
    () => ROLE_EMOJI[topRole?.role ?? ""] ?? "👤",
    [topRole],
  );
  const maxHour = useMemo(
    () => Math.max(1, ...(profile?.hours.map((h) => h.pct) ?? [1])),
    [profile],
  );
  const lowConfidence = !!profile && profile.confidence < 0.5;
  // 领域环形图（conic-gradient 三段）
  const donutStyle = useMemo(() => {
    if (!profile || profile.domains.length === 0) return null;
    let acc = 0;
    // 审查：pct 是 0-100 的百分比，conic-gradient 用角度 → ×3.6 才是度数；
    // 此前直接用 pct 当 deg，环只填 ~28% 看起来像坏了。全部领域画满（>3 类其余用灰色）。
    const stops = profile.domains
      .map((d, i) => {
        const from = acc * 3.6;
        acc += d.pct;
        const colors = ["#4fa3ff", "#38e1d4", "#9d7bff"];
        const color = i < 3 ? colors[i] : "#cbd5e1";
        return `${color} ${from}deg ${acc * 3.6}deg`;
      })
      .join(", ");
    return { background: `conic-gradient(${stops})` };
  }, [profile]);

  const saveOverride = useCallback(
    async (key: string, value: string, msg: string) => {
      try {
        await profileSetOverride(key, value);
        toast(msg, "success");
        void load();
      } catch (e) {
        toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [load, toast],
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <motion.div
            {...anim.panel}
            className="dialog-box w520"
            role="dialog"
            aria-modal="true"
            aria-label="我的画像"
            onClick={(e) => e.stopPropagation()}
          >
            <FocusTrap active={open}>
              <div className={styles.head}>
                <div className={styles.headTitle}>
                  <span className={styles.headIcon}><UserRound size={13} /></span>
                  我的画像
                  <span className={styles.headSub}>行为统计实时聚合 · 不含内容</span>
                </div>
                <button className="dialog-close" onClick={close} aria-label="关闭">
                  <X size={14} />
                </button>
              </div>

              <div className={styles.body}>
                {!profile ? (
                  <div className={styles.loading}>
                    <Loader2 size={16} className="spin" /> 正在聚合最近 30 天行为…
                  </div>
                ) : (
                  <>
                    {/* 低置信度提示 */}
                    {lowConfidence && (
                      <div className={styles.warn}>
                        ⚠ 样本偏少（{profile.sampleEvents} 条行为）——置信度{" "}
                        {Math.round(profile.confidence * 100)}%，随使用积累画像会更准
                      </div>
                    )}

                    {/* 角色区：雷达图 + 主导卡 */}
                    <div className={styles.roleArea}>
                      <div className={styles.radarWrap}>
                        <ProfileRadar roleScores={profile.roleScores} />
                        <div className={styles.radarTitle}>能力维度 · 归一化到最强项</div>
                      </div>

                      <div className={styles.roleMain}>
                        <div className={styles.mainRole}>
                          <div className={styles.roleEmoji}>{topRoleEmoji}</div>
                          <div className={styles.roleInfo}>
                            <div className={styles.roleName}>
                              {roleDraft || topRole?.label || "—"}
                              {topRole && (
                                <span className={styles.roleTag}>
                                  置信 {Math.round(topRole.score * 100)}%
                                </span>
                              )}
                            </div>
                            <div className={styles.roleDesc}>
                              画像来自最近 30 天 {profile.sampleEvents} 条行为统计
                            </div>
                            <div className={styles.confidenceBar}>
                              <i style={{ width: `${Math.max(4, profile.confidence * 100)}%` }} />
                            </div>
                          </div>
                        </div>
                        <div className={styles.roleFixRow}>
                          <select
                            className={styles.select}
                            value={roleDraft}
                            onChange={(e) => {
                              setRoleDraft(e.target.value);
                              void saveOverride("role", e.target.value, "角色已修正");
                            }}
                          >
                            <option value="">自动推断</option>
                            {ALL_ROLES.map(([id, label]) => (
                              <option key={id} value={label}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <span className={styles.fixHint}>
                            <Pencil size={9} /> 推断不对？手动选
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* V3-C：AI 画像描述（LLM 润色，手动触发出网） */}
                    <ProfileRefine />

                    {/* v6.8 粘性 A2：我的轨迹（活跃日历 + 连续周数） */}
                    <ProfileTrajectory />

                    {/* 两列：领域环形图 + 活跃时段 */}
                    <div className={styles.twoCol}>
                      <div className={styles.card}>
                        <div className={styles.cardTitle}>
                          <span className={styles.cardDot} style={{ background: "#4fa3ff" }} />
                          内容领域
                        </div>
                        {profile.domains.length === 0 ? (
                          <div className={styles.empty}>暂无数据</div>
                        ) : (
                          <div className={styles.donutWrap}>
                            <div className={styles.donut} style={donutStyle ?? undefined}>
                              <div className={styles.donutCenter}>
                                <b>{profile.sampleEvents}</b>
                                <span>条行为</span>
                              </div>
                            </div>
                            <div className={styles.legend}>
                              {profile.domains.slice(0, 3).map((d, i) => (
                                <div key={d.domain} className={styles.legendRow}>
                                  <i style={{ background: ["#4fa3ff", "#38e1d4", "#9d7bff"][i] }} />
                                  {d.domain}
                                  <span className={styles.legendPct}>{d.pct}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className={styles.card}>
                        <div className={styles.cardTitle}>
                          <span className={styles.cardDot} style={{ background: "#9d7bff" }} />
                          活跃时段
                        </div>
                        <div className={styles.hours}>
                          {profile.hours.map((h) => (
                            <div key={h.label} className={styles.hourRow}>
                              <span className={styles.hourLabel}>{h.label}</span>
                              <div className={styles.hourBarBg}>
                                <div
                                  className={styles.hourBar}
                                  style={{ width: `${Math.max(3, (h.pct / maxHour) * 100)}%` }}
                                />
                              </div>
                              <span className={styles.hourPct}>{h.pct}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* 高频动作 */}
                    {profile.topActions.length > 0 && (
                      <div className={styles.card}>
                        <div className={styles.cardTitle}>
                          <span className={styles.cardDot} style={{ background: "#34d399" }} />
                          高频动作
                        </div>
                        <div className={styles.chips}>
                          {profile.topActions.map((a) => (
                            <span key={a.actionId} className={styles.chip}>
                              {a.actionId} <b>{a.count}</b>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* v6.8 粘性 A3：成就墙 */}
                    <AchievementsCard />

                    {/* 风格偏好 */}
                    {profile.prefs.length > 0 && (
                      <div className={styles.card}>
                        <div className={styles.cardTitle}>
                          <span className={styles.cardDot} style={{ background: "#ff7ab6" }} />
                          风格偏好
                        </div>
                        <div className={styles.prefList}>
                          {profile.prefs.slice(0, 5).map((p) => (
                            <div key={p.actionId} className={styles.pref}>
                              <span className={styles.prefTag}>{p.actionId}</span>
                              {p.preference ? (
                                <span className={styles.prefTxt}>{p.preference}</span>
                              ) : (
                                <span className={styles.prefHint}>
                                  常被修改（{Math.round(p.editRate * 100)}%）· 建议设偏好
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 使用红线 */}
                    <div className={styles.card}>
                      <div className={styles.cardTitle}>
                        <span className={styles.cardDot} style={{ background: "#f5a623" }} />
                        使用红线
                      </div>
                      <div className={styles.instrRow}>
                        <input
                          className={styles.input}
                          placeholder="补充一条对 AI 的要求（如：代码用中文注释）"
                          value={instrDraft}
                          onChange={(e) => setInstrDraft(e.target.value)}
                          onBlur={() => {
                            if (instrDraft !== profile.overrides.instructions) {
                              void saveOverride("instructions", instrDraft, "红线已保存");
                            }
                          }}
                        />
                      </div>
                      <div className={styles.instrDefault}>
                        默认红线：中文输出 · 敏感信息不处理不外发 · 云端请求先确认
                      </div>
                    </div>

                    {/* 导出区 */}
                    <ProfileExport />

                    {/* 隐私说明 */}
                    <div className={styles.note}>
                      <b>隐私说明：</b>画像只含行为统计（动作名 / 内容类型 / 时段 / 偏好指令），
                      不包含你复制过的任何内容；导出是唯一出网口，需你主动触发并预览确认；
                      敏感信息自动清洗；可一键清除重建。
                    </div>
                  </>
                )}
              </div>
            </FocusTrap>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
