/**
 * RcUnoDialog — 无人值守接入（Q2）的弹层**壳**，三种立场共用一层：
 *
 * - `generate`（被控端，方案 B）：选时效 / 能力档 / 免确认 → 出码。
 *   展示码 `XXXX-XXXX` 给电话念，完整接入串 `PPU-<码>-<node_id>` 给复制粘贴
 *   （跨网时对方必须连 node_id 一起拿到，8 位码定位不了机器）。
 * - `join`（发起端）：粘贴接入串或裸码 → 直接连。完整串直接发；
 *   裸码只能在本机「听得到」对方组播（同一局域网）时用——靠附近设备
 *   列表补上 node_id，列表里没有就明确说「请让对方发完整串」。
 *   也可切到「固定密码」模式：密码 + 设备号（同网可从附近列表认）。
 * - `pass`（被控端，方案 C）：设置 / 更换固定密码，或查看开启状态 + 一键关闭。
 *
 * # 2026-09-26 拆分（组件 ≤300 行红线）
 *
 * 三屏各自成文件，壳只管背景、标题、页签与「现在该显示哪一屏」：
 * | 屏 | 文件 |
 * |---|---|
 * | 生成无人值守码 | `RcUnoGeneratePane.tsx` |
 * | 有码，直接连 | `RcUnoJoinPane.tsx` |
 * | 固定密码管理面 | `RcUnoPassPane.tsx` |
 *
 * # 为什么不进 RcAdhocDialog 的壳
 *
 * 一次性帮助（方案甲）两端都**有人**，语义是「这次」；无人值守的语义是
 * 「对面没人，凭证就是授权」。两套话术（「对方当场确认」vs「码会过期 / 密码
 * 长期有效」）不该挤在同一个组件里各说各话，与 RcAdhocDialog ≠ RcPairDialog
 * 同一个理由。
 *
 * # 乙方案 §5：出码与收码是本弹层的两个标签
 *
 * `generate` 与 `join` 是同一凭证的两面，用页签收在一层里（凭证 = 设备属性，
 * 不是散落各处的入口）；原「帮助弹层底部 → 输入接入码」跳链已下架。
 * `pass` 仍是独立管理面，不带页签。
 *
 * # 能力档在生成端定，发起端一律申请「可控」
 *
 * 发起端不知道凭证授的是哪一档（码是乱码、密码是对端私事），所以总是申请
 * 最大档，由被控端压到凭证的档位并随 Accept 回传——会话 UI 按真实档渲染，
 * 与「提权为可控」的既有语义一致。
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { GeneratePane } from "./RcUnoGeneratePane";
import { JoinPane } from "./RcUnoJoinPane";
import { PassPane } from "./RcUnoPassPane";
import styles from "../rc/RemoteComputer.module.css";

export type UnoSide = "generate" | "join" | "pass";

export function RcUnoDialog({
  rc,
  toast,
  side,
  onClose,
}: {
  rc: UseRc;
  toast: ToastFn;
  /** 开层时停在哪一侧（`pass` 是独立的固定密码管理面，不参与页签）。 */
  side: UnoSide;
  onClose: () => void;
}) {
  const anim = useDialogAnim();
  // 乙方案 §5 流程③：出码/收码是同一凭证的两面，收进一个弹层的两个标签——
  // 「凭证是设备属性，不是入口」。`side` 只决定初始那一页。
  const [tab, setTab] = useState<UnoSide>(side === "pass" ? "pass" : side);
  const code = tab !== "pass";
  return (
    <motion.div key="rc-uno" {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
        <motion.div
          {...anim.panel}
          className="dialog-box"
          style={{ width: "min(480px, 94vw)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog-header">
            <h2 className="dialog-title">
              {tab === "pass" ? "无人值守固定密码" : "无人值守"}
            </h2>
            <button className="dialog-close" onClick={onClose} aria-label="关闭">
              <X size={15} />
            </button>
          </div>
          {code && (
            <div className={styles.adhocTabs} role="tablist" aria-label="无人值守方式">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "generate"}
                className={tab === "generate" ? styles.adhocTabOn : undefined}
                onClick={() => setTab("generate")}
              >
                生成无人值守码
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "join"}
                className={tab === "join" ? styles.adhocTabOn : undefined}
                onClick={() => setTab("join")}
              >
                有码，直接连
              </button>
            </div>
          )}
          <div className={styles.body}>
            {tab === "generate" ? (
              <GeneratePane rc={rc} toast={toast} onClose={onClose} />
            ) : tab === "pass" ? (
              <PassPane rc={rc} toast={toast} />
            ) : (
              <JoinPane rc={rc} toast={toast} onClose={onClose} />
            )}
          </div>
        </motion.div>
      </FocusTrap>
    </motion.div>
  );
}
