/**
 * RcSection — 设置页「远程电脑」小节（方案甲：原地减法 + 分组折叠）。
 *
 * 配对独立于知识库同步：有自己的邀请码流程，写 rc_devices。
 * 主开关打开时自建远程通道，不依赖 kb_sync_enabled。
 *
 * 🔴 本文件只做**编排**：小节标题 + 主开关 + 四个组 + 弹层。三件事必须留在这一层，
 * 因为组收起时组内的行**根本不渲染**（规则 15.2）：
 * ① 「有待确认请求 ⇒ 自动展开组 1」——组 1 自己看不见有几台在等；
 * ② 本机能力读取（`useRcLocalAbility`）——放在组里会变成每次展开重读一遍；
 * ③ 会话历史（`useRcHistory`）——组头收起态的摘要要报「共几条 / 最近一条是谁」。
 * 设备子表的开合位也在这里：它是独立于组开合的第二个位（收起组 ⇒ 子表跟着不渲染，
 * 但重新展开时回到用户上次选的样子）。
 *
 * ❗ 返回片段且所有行是容器直接子节点：`useSettingsSearch` 只走 `container.children`。
 */
import { useEffect, useState } from "react";
import type { AppConfig } from "@/stores/appStore";
import { useToast, UNDO_WINDOW_MS } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { useRc } from "@/hooks/useRc";
import { useRcGroupOpen } from "@/hooks/useRcGroupOpen";
import { useRcHistory } from "@/hooks/useRcHistory";
import { useRcLocalAbility } from "@/hooks/useRcLocalAbility";
import { rcCancelRequest, rcSetEnabled, type RcCapability } from "@/lib/api/rc";
import { capabilityLabel, rememberRequestCap } from "@/lib/rcRequest";
import { useRcStore } from "@/stores/rcStore";
import { ToggleRow } from "../ToggleRow";
import { RcMobileHintRow } from "../RcMobileHintRow";
import { RcPairLayer, type RcPairLayerMode } from "../RcPairLayer";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";
import { RcPairGroup } from "../rcGroups/RcPairGroup";
import { RcUnoGroup } from "../rcGroups/RcUnoGroup";
import { RcCapGroup } from "../rcGroups/RcCapGroup";
import { RcRecentGroup } from "../rcGroups/RcRecentGroup";

interface RcSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  /** 设置页搜索关键词：非空 ⇒ 四组强制全展开（判据收在 `lib/rcPrefs` 的 rcGroupShouldOpen）。 */
  filter: string;
}

export function RcSection({ config, updateAndSave, filter }: RcSectionProps) {
  const { toast } = useToast();
  const enabled = config.rc_enabled ?? false;
  const rc = useRc(true);
  /** 当前开着的弹层（长期配对 / 让别人帮我 / 帮别人连一次）——见 RcPairLayer。 */
  const [overlay, setOverlay] = useState<RcPairLayerMode>(null);
  const [devOpen, setDevOpen] = useState(false);
  const { isOpen, toggle, inert } = useRcGroupOpen(filter);
  const history = useRcHistory();
  const ability = useRcLocalAbility();

  const off = !enabled;
  const joins = rc.status?.joins ?? [];

  // 🔴 本窗的 identity / targets **没有任何自动来源**：store 的轮询只探 `rc_status`
  // （`refreshTargets` 只在 `run()` 之后被顺带调、`refreshIdentity` 只有工作台会调）。
  // 少了这三下，设置页一打开就是「已配对 0 台」+ 指纹永远「读取中…」，
  // 而配对按钮 `disabled={!rc.identity}` ⇒ 从设置页根本配不了对。
  useEffect(() => {
    void rc.refresh();
    void rc.refreshTargets();
    void rc.refreshIdentity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const reconnect = (id: string, name: string, cap: RcCapability) => {
    // 沿用这条记录用过的档，并记为下次的默认档——与设备列表「沿用上次」同一语义
    rememberRequestCap(cap);
    void rc.request(id, cap).then((ok) => {
      if (!ok) return;
      // F-9 / S2：设置页与托盘/工作台同一反馈等级——成功给 6s 撤销
      toast(
        `已向「${name}」再次发起远程（${capabilityLabel(cap)}）`,
        "info",
        UNDO_WINDOW_MS,
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          void (async () => {
            if (
              useRcStore.getState().status?.session?.phase !== "outbound_pending"
            ) {
              toast("对方已同意，申请无法撤回（可在会话里结束）", "info");
              return;
            }
            try {
              await rcCancelRequest();
              toast(`已撤回对「${name}」的申请`, "success");
            } catch {
              toast("撤回失败", "error");
            }
          })();
        },
      );
    });
  };

  return (
    <>
      <div className={shared.sSection}>远程电脑</div>
      <ToggleRow
        icon="🖥️"
        hue="sync"
        label="允许被远程协助"
        desc="独立于知识库同步：配对后对方可申请查看或控制这台电脑；默认关闭"
        value={enabled}
        detailTitle="允许被远程协助"
        detail={
          <>
            <p>远程配对与同步配对是两套授权，互不影响。</p>
            <p>🔒 会话制：申请 → 你确认 → 常驻横幅可随时结束</p>
            <p>⚠️ 不做远程 shell / 文件管理；无人值守只限限时无人值守码（码会过期、可撤销）</p>
          </>
        }
        onChange={async (v) => {
          await updateAndSave({ rc_enabled: v });
          try {
            await rcSetEnabled(v);
            toast(v ? "已允许被远程协助" : "已关闭远程协助", "success");
            void rc.refresh();
          } catch (e) {
            logger.warn("切换远程协助失败", e);
            await updateAndSave({ rc_enabled: !v });
            toast(`远程协助切换失败：${e instanceof Error ? e.message : String(e)}`, "error");
          }
        }}
      />

      {/* 规则 15.3：失败路径不折叠——藏进收起的组里就等于没有反馈 */}
      {rc.error && <div className={styles.rcErrLine}>{rc.error}</div>}

      {/* 块3 情境化提示：本机一旦有已配对设备（=真在用远程电脑），就在节内出现一行手机 App 引导；
          可关（写 localStorage，一次性），点整行跳「关于 → 手机 App 下载卡」。见 RcMobileHintRow。 */}
      {rc.targets.length > 0 && <RcMobileHintRow />}

      <RcPairGroup
        rc={rc}
        status={rc.status ?? null}
        targets={rc.targets}
        joins={joins}
        // 组 1 **不吃主开关**：配对与发起远程都不依赖「允许被远程协助」（主开关 detail 第 3 句）。
        // 逐台限制的变灰判据是后端真值 `status.enabled`，在子表里自己算。
        open={isOpen("pair", joins.length > 0)}
        inert={inert}
        devOpen={devOpen}
        onToggle={() => toggle("pair")}
        onToggleDev={() => setDevOpen((v) => !v)}
        onOverlay={setOverlay}
      />

      <RcUnoGroup
        rc={rc}
        status={rc.status ?? null}
        off={off}
        open={isOpen("conn")}
        inert={inert}
        onToggle={() => toggle("conn")}
        onOverlay={setOverlay}
      />

      {/* 主开关关时这组照常可见（变灰、控件禁用），让用户知道有哪些档可配（规则 15） */}
      {rc.status && (
        <RcCapGroup
          rc={rc}
          status={rc.status}
          ability={ability}
          open={isOpen("cap")}
          inert={inert}
          onToggle={() => toggle("cap")}
        />
      )}

      <RcRecentGroup
        history={history}
        targets={rc.targets}
        running={!!rc.status?.running}
        busy={rc.busy}
        open={isOpen("recent")}
        inert={inert}
        onToggle={() => toggle("recent")}
        onReconnect={reconnect}
      />

      {/*
        🔴 这里**不传** `onStartRemote`：设置页没有会话上下文（发起链路的
        撤销窗口与能力档记忆都在工作台）。RcAdhocDialog 会退回 `rc.request`
        直发「只看」——不是漏传，刻意如此。
        弹层留在顶层不进组：它挂的是 `document.body`，而组收起会卸载 children。
      */}
      <RcPairLayer rc={rc} toast={toast} mode={overlay} onClose={() => setOverlay(null)} />
    </>
  );
}
