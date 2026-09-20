/**
 * RcDeviceMenu — 设备行「更多」菜单（从 RcDeviceList 拆出，2026-09-18）。
 *
 * 菜单整体吃掉冒泡：菜单项在整行内部，不拦就会连行点击一起触发
 * ⇒ 点「以『可控』发起」等于发两次申请。挂在容器上一次，
 * 以后往菜单里加项也不会漏（设计稿风险 #1）。
 */
import { useEffect, useRef } from "react";
import { MoreHorizontal } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcDeviceMenu({
  open,
  onToggle,
  syncOnly,
  busy,
  fileBusy,
  denied,
  trusted,
  autoAccept,
  onRequestWith,
  onSendFiles,
  onAllowToggle,
  onDenyToggle,
  onTrustToggle,
  onAutoAcceptToggle,
  onRename,
  onForget,
}: {
  open: boolean;
  onToggle: () => void;
  /** 纯同步设备没有「以指定方式发起」（没有可发起的主动作语义）。 */
  syncOnly: boolean;
  busy: boolean;
  /**
   * G6：文件传输项的禁用态，**与 `busy` 分开**。
   *
   * `busy` 进到这里时已经被调用点并成了「busy || 会话进行中」——那是给发起类
   * 用的（后端只有一个会话位）。而文件走**独立 ALPN**，正在被别人远程时照样能传，
   * 用同一个锁会把一个本来能用的入口显示成灰的。
   */
  fileBusy: boolean;
  denied: boolean;
  /** 方案 D：该设备是否已开免确认（发起远程时跳过对端人工同意）。 */
  trusted: boolean;
  /** 决策 10：该设备推送文件过来时是否跳过确认条（存进 `rc_devices.auto_accept`）。 */
  autoAccept: boolean;
  onRequestWith: (cap: RcCapability) => void;
  /** G6：打开「文件传输」页并预选这台设备（不建立远程会话）。不传 = 不摆这一项。 */
  onSendFiles?: () => void;
  /** 方案 A：解除禁止的唯一入口（行内那个按钮已收进本菜单）。 */
  onAllowToggle: () => void;
  onDenyToggle: () => void;
  onTrustToggle: () => void;
  /** 决策 10：切换「自动接收此设备的文件」。不传 = 不摆这一项。 */
  onAutoAcceptToggle?: () => void;
  onRename: () => void;
  onForget: () => void;
}) {
  // U6：键盘可达性——打开即落焦点到第一个可用项；↑/↓ 逐项移动、Esc 关闭
  // 并把焦点还给触发钮。没有这套，纯键盘用户只能 Tab 硬闯（菜单项与页面
  // 其余按钮混在同一序列里，Tab 顺序不可预期）。
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    first?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onToggle();
      triggerRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? items[(idx + 1 + items.length) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next?.focus();
  };
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
        ref={triggerRef}
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
        <div
          ref={menuRef}
          className={styles.devMenu}
          role="menu"
          onKeyDown={onMenuKeyDown}
          onClick={(e) => e.stopPropagation()}
        >
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
          {/* G6（决策 8）：文件传输是**独立通道**——不建远程会话、对方屏幕上不出现
              你的画面。所以它与上面的「发起」组之间用分隔线断开，语义上不是同一件事。
              `!syncOnly`：与「发起」同一门槛（纯同步配对设备先「去配对」）。
              禁用只看 fileBusy，**不跟会话进行中走**（见 fileBusy 的说明）。 */}
          {!syncOnly && onSendFiles && (
            <button
              type="button"
              disabled={fileBusy}
              title="不建立远程会话，直接把文件发给对方 / 或向对方要文件"
              onClick={onSendFiles}
            >
              传文件
            </button>
          )}
          {/* ⚠️ 菜单项一律跟 `busy` 走：busy 期间点任何一项都会发一个注定失败或
              重复的信令（尤其「发起」类）。按钮已禁用，菜单不能留成后门。 */}
          {!syncOnly && (
            <button type="button" disabled={busy} onClick={onRename}>
              设置备注名
            </button>
          )}
          {/* 决策 10（2026-09-20）：自动接收。紧挨「传文件」——同一件事的两个方向：
              上面那条是「我要发出去」，这条是「别人发给我时要不要问」。
              判据同「免确认」：`syncOnly`（设定写在 `rc_devices.auto_accept`，
              同步配对设备还没有那行）+ `denied`（deny 优先级更高，被禁止时开了也不生效）。
              标签写「下一步做什么」，当前态由行上徽章表达。 */}
          {!syncOnly && !denied && onAutoAcceptToggle && (
            <button type="button" disabled={busy} onClick={onAutoAcceptToggle}>
              {autoAccept ? "关闭自动接收文件" : "自动接收此设备的文件"}
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
