/**
 * RcDeviceMenu — 设备行「更多」菜单（从 RcDeviceList 拆出，2026-09-18）。
 *
 * 菜单整体吃掉冒泡：菜单项在整行内部，不拦就会连行点击一起触发
 * ⇒ 点「以『可控』发起」等于发两次申请。挂在容器上一次，
 * 以后往菜单里加项也不会漏（设计稿风险 #1）。
 */
import { MoreHorizontal } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcDeviceMenu({
  open,
  onToggle,
  syncOnly,
  busy,
  denied,
  trusted,
  onRequestWith,
  onAllowToggle,
  onDenyToggle,
  onTrustToggle,
  onRename,
  onForget,
}: {
  open: boolean;
  onToggle: () => void;
  /** 纯同步设备没有「以指定方式发起」（没有可发起的主动作语义）。 */
  syncOnly: boolean;
  busy: boolean;
  denied: boolean;
  /** 方案 D：该设备是否已开免确认（发起远程时跳过对端人工同意）。 */
  trusted: boolean;
  onRequestWith: (cap: RcCapability) => void;
  /** 方案 A：解除禁止的唯一入口（行内那个按钮已收进本菜单）。 */
  onAllowToggle: () => void;
  onDenyToggle: () => void;
  onTrustToggle: () => void;
  onRename: () => void;
  onForget: () => void;
}) {
  // 🔴 菜单项要**逐项**判「对这台设备真的成立吗」，不能整块隐藏也不能整块保留：
  //    ·「以指定方式发起」——纯同步设备（只在同步 `devices` 表、不在 `rc_devices` 表）
  //      没有可发起的主动作（B9：它的下一步是「去配对」）；
  //    ·「设置备注名」——备注写在 `rc_devices.note`，对不在该表的设备 UPDATE 不中行；
  //    ·「以后不再询问」——免确认同样写在 `rc_devices.trusted`；
  //    ·「忘记设备」——同理，忘的是 rc 配对关系，不是同步设备；
  //    ·「禁止远程本机」**例外**：它写的是按 node_id 的 deny 名单（配置级），
  //      与设备在哪张表无关，对同步设备同样有效 —— 所以菜单不是整体消失。
  //    ·「允许远程本机」（方案 A 新增）同样只依赖 deny 名单，所以**任何**组合下都
  //      至少有一项成立，原来「纯同步 + 已禁止 ⇒ 整个菜单不摆」的早返回已经删掉。
  return (
    <div className={styles.devMenuWrap}>
      {/* 方案 A：触发钮也图标化（26px）。D5 当初把「更多」文字补上是为了可发现性，
          现在换回纯图标 —— 代价用 aria-label（无障碍名）+ title（悬停提示）补，
          二者缺一就会变成「一个看不出是什么的方块」。 */}
      <button
        type="button"
        className={`${styles.icoBtn} ${styles.icoBig}`}
        aria-label="更多操作"
        title="更多操作"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className={styles.devMenu} onClick={(e) => e.stopPropagation()}>
          {/* 原「申请卡」的选档职能收进菜单：只在需要显式换档时才展开，常态不占屏 */}
          {!syncOnly && (
            <>
              <div className={styles.mDim}>以指定方式发起</div>
              <button
                type="button"
                className={styles.mSafe}
                disabled={busy}
                onClick={() => onRequestWith("view")}
              >
                以「只看」发起
              </button>
              <button
                type="button"
                className={styles.mSafe}
                disabled={busy}
                onClick={() => onRequestWith("control")}
              >
                以「可控」发起
              </button>
              <div className={styles.mSep} />
            </>
          )}
          {/* ⚠️ 菜单项一律跟 `busy` 走：busy 期间点任何一项都会发一个注定失败或
              重复的信令（尤其「发起」类）。按钮已禁用，菜单不能留成后门。 */}
          {!syncOnly && (
            <button type="button" disabled={busy} onClick={onRename}>
              设置备注名
            </button>
          )}
          {/* A1（2026-09-18）：把已经做好的「免确认直连」从设置页第四层拿到设备行。
              判据两条，缺一项都会变成死项：
                · syncOnly —— 免确认写在 `rc_devices.trusted`，同步配对设备还没建远程通道；
                · denied   —— deny 优先级高于免确认（后端如此），已被禁止时开了也不生效。
              标签写成动作而不是状态：免确认的当前态由行上徽章表达，菜单里只放「下一步做什么」。 */}
          {!syncOnly && !denied && (
            <button type="button" disabled={busy} onClick={onTrustToggle}>
              {trusted ? "恢复每次询问" : "以后不再询问"}
            </button>
          )}
          {/* 方案 A：原来只做「禁止 / 隐藏」的单项，现在按当前态二选一 ——
              行内那个「解除禁止」按钮已删（第三个 26px 图标在 245px 里放不下），
              所以「允许远程本机」是解除禁止的**唯一**入口，不能只在 denied 时藏掉。 */}
          {denied ? (
            <button type="button" disabled={busy} onClick={onAllowToggle}>
              允许远程本机
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={onDenyToggle}>
              禁止远程本机
            </button>
          )}
          {!syncOnly && (
            <button type="button" disabled={busy} onClick={onForget}>
              忘记设备
            </button>
          )}
        </div>
      )}
    </div>
  );
}
