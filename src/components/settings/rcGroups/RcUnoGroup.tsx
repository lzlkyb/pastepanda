/**
 * RcUnoGroup — 组 2「不用在场的连法」。
 *
 * 收的是原来三个 `rcJoinBlock`：限时接入码（生成 / 撤销 / 我有对方的码）+ 固定密码。
 * 它们共用同一个语义——**对面压根没人**，码或密码本身就是授权，靠时效与可撤销兜安全。
 *
 * 🔴 安全态必须进组头摘要（设计稿 §5 ②）：「几个码生效中」「固定密码开着且仅限
 * 局域网」是收起来也要一眼看见的事实。撤销 / 关闭这两个出口因此**常驻在行里**，
 * 不能因为组收起就消失（规则 15.1：触发和反馈同一个可见性域）。
 *
 * 🔴 `off`（= `config.rc_enabled` 关）**只挂「生成」和「设置/修改密码」两个开授权
 * 的按钮**——它们要通道在跑才有人连得进来。撤销 / 关闭 / 我拿别人的码去连这三项
 * **永远可点**：关掉「允许被远程」并不收回已经发出去的码，撤销是安全出口；粘码是
 * 出站动作，与本机接不接受被远程无关。行本身也不变灰，变灰会让人以为撤销按不了。
 */
import { useToast } from "@/components/Toast";
import type { UseRc } from "@/hooks/useRc";
import type { RcStatus } from "@/lib/api/rc";
import { unoExpiryText } from "@/lib/rcUno";
import type { RcPairLayerMode } from "../RcPairLayer";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";
import { RcGroupHead } from "./RcGroupHead";
import { RcGroupRow } from "./RcGroupRow";

export function RcUnoGroup({
  rc,
  status,
  off,
  open,
  onToggle,
  onOverlay,
}: {
  rc: UseRc;
  status: RcStatus | null;
  off: boolean;
  open: boolean;
  onToggle: () => void;
  onOverlay: (mode: RcPairLayerMode) => void;
}) {
  const { toast } = useToast();
  const uno = status?.uno ?? [];
  const pass = status?.uno_pass;
  const expiry = unoExpiryText(uno.map((u) => u.expires_ms), Date.now());

  return (
    <>
      <RcGroupHead
        label="不用在场的连法"
        open={open}
        onToggle={onToggle}
        summary={
          /* 同组 1：`status` 还没回来时不能断言「接入码 0 · 固定密码 未设置」——
             那是「本机没在无人值守」这个安全结论，得有数据才敢说。 */
          status === null ? (
            <>读取中…</>
          ) : (
            <>
              接入码<span className={styles.rcGroupCount}>{uno.length}</span> · 固定密码
              <b>{pass ? `已开（${pass.wan ? "跨网已允许" : "仅局域网"}）` : "未设置"}</b>
            </>
          )
        }
      />
      {open && (
        <>
          <RcGroupRow
            hue="save"
            icon="⏳"
            label="限时接入码"
            desc={
              // §5 ⑤ 的唯一例外：安全警示留一句在 desc（收起态也要看得见），完整说明在 ?
              uno.length > 0 && expiry
                ? `⚠️ 对面没人也能连 · ${uno.length} 个生效中（最近 ${expiry}）`
                : "⚠️ 对面没人也能连：15 分钟 / 1 次，可撤销"
            }
            detailTitle="限时无人值守码"
            detail={
              <>
                <p>⚠️ 对面没人也能连：码本身就是授权，靠「限时 + 限次 + 可撤销」兜底。</p>
                <p>默认 15 分钟、限 1 次，不落盘、可随时撤销全部。</p>
                <p>对方粘贴后自动配对连入；接入全程有横幅、有记录。</p>
              </>
            }
          >
            <span className={styles.rcBtnRow}>
              <button
                type="button"
                className={shared.lanRefreshBtn}
                disabled={off}
                onClick={() => onOverlay("unoGenerate")}
              >
                生成
              </button>
              {uno.length > 0 && (
                <button
                  type="button"
                  className={shared.lanRefreshBtn}
                  // 撤销是**安全出口**：主开关关了也要按得动（关通道不等于收回已发的码）
                  disabled={rc.busy}
                  onClick={() => {
                    void rc.unoRevoke().then((ok) => {
                      if (ok) toast("已撤销全部无人值守码", "info");
                    });
                  }}
                >
                  撤销
                </button>
              )}
            </span>
          </RcGroupRow>

          <RcGroupRow
            hue="paste"
            icon="📥"
            label="我有对方的接入码"
            desc="粘过去即可连入对面，无需对方在场确认"
          >
            {/* 这是**出站**：我连别人，不需要本机开着「允许被远程」 */}
            <button
              type="button"
              className={shared.lanRefreshBtn}
              onClick={() => onOverlay("unoJoin")}
            >
              粘贴连接
            </button>
          </RcGroupRow>

          <RcGroupRow
            hue="privacy"
            icon="🔑"
            label="固定密码"
            desc={
              // 同上：警示留 desc（§5 ⑤ 的例外覆盖无人值守两行），完整说明在 ?
              pass
                ? `⚠️ 对面没人也能连 · 当前：${pass.cap === "control" ? "可控" : "只看"} · ${pass.wan ? "跨网已允许" : "仅限局域网"}`
                : "⚠️ 对面没人也能连：知道密码随时可连，给长期挂机的机器"
            }
            detailTitle="无人值守固定密码"
            detail={
              <>
                <p>⚠️ 长期通道：知道密码的设备随时可连，对面不会收到确认。</p>
                <p>哈希存储、限速防爆破（连错若干次锁定）；默认仅限局域网，跨网要单独打开。</p>
                <p>接入全程横幅常驻、可一键关闭。</p>
              </>
            }
          >
            <span className={styles.rcBtnRow}>
              <button
                type="button"
                className={shared.lanRefreshBtn}
                disabled={off}
                onClick={() => onOverlay("unoPass")}
              >
                {pass ? "修改" : "设置"}
              </button>
              {pass && (
                <button
                  type="button"
                  className={shared.lanRefreshBtn}
                  // 同「撤销」：关掉长期通道是安全出口，任何时候都要按得动
                  disabled={rc.busy}
                  onClick={() => {
                    void rc.unoPassDisable().then((ok) => {
                      if (ok) toast("已关闭无人值守固定密码", "info");
                    });
                  }}
                >
                  关闭
                </button>
              )}
            </span>
          </RcGroupRow>
        </>
      )}
    </>
  );
}
