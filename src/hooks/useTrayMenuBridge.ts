/**
 * useTrayMenuBridge — 托盘**原生菜单**（方案丁）与前端既有能力之间的桥。
 *
 * 背景：原生菜单由系统 TrackPopupMenu 渲染，动作里能直接调的 Rust 函数都在
 * `tray_menu.rs` 就地处理了；唯独「粘贴最近记录」和「连接远程设备」两项必须
 * 回到前端——前者要走 `pasteHistoryItem` 这个唯一分派收口（类型清洗/敏感闸/
 * 粘贴信号回写，规则 11.1，禁止在 Rust 抄第二份），后者的判据与连接链路
 * （`useTrayRcShortcut`：通道状态/在飞会话/上次档位）全在前端 store 里。
 *
 * 三条链路：
 *  1. RcItem 上行：`useTrayRcShortcut` 的结果变化 → `set_tray_rc_item`，
 *     Rust 侧据此决定菜单摆不摆「连接 xx」项（hover 时它还会反向请求刷新，
 *     由 useTrayRcShortcut 自己监听 `tray-menu-rc-refresh`）。
 *  2. `tray-menu-paste`：菜单点了某条最近记录 → 敏感内容且主窗口隐藏时先
 *     `show_main_window`（确认条是主窗口模态框，藏窗弹闸=粘贴无限挂起），
 *     再 `pasteHistoryItem`，结果用托盘角标闪绿/红反馈（规则 15.1：菜单没有
 *     能承载 toast 的窗口，反馈必须落在图标上）。
 *  3. `tray-menu-rc-connect`：点「连接 xx」→ 复用 hook 的 connect（同款撤销窗口）。
 */
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { maskSensitiveText } from "@/lib/mask";
import { pasteHistoryItem, type PastableItem } from "@/lib/pasteItem";
import { logger } from "@/lib/logger";
import { useAppStore } from "@/stores/appStore";
import { useTrayRcShortcut } from "@/hooks/useTrayRcShortcut";

/** Rust `tray_menu::RecentEntry`（camelCase 序列化）的对应形状 */
interface TrayRecentPayload {
  id: string;
  itemType: string;
  preview: string;
  text: string;
  content: string;
  source: string;
  contentType: string;
}

/**
 * 该条目粘贴时会不会弹敏感确认条 —— 逐分支镜像 `pasteHistoryItem` 的分派：
 * 带 content 的 image 走 pasteImage（无闸）；rich/doc 检测 item.text；
 * file 检测真正粘出去的 content；其余检测 text。
 */
function willHitPasteGuard(item: PastableItem): boolean {
  const content = item.content || "";
  const plainOnly = useAppStore.getState().config.paste_format_default === "plain";
  let checkText: string;
  if (item.type === "image" && content) return false;
  if (!plainOnly && (item.type === "doc" || item.type === "rich") && content) checkText = item.text;
  else if (item.type === "file" && content) checkText = content;
  else checkText = item.text;
  const trimmed = (checkText || "").trim();
  if (!trimmed) return false;
  const { text: masked, count } = maskSensitiveText(trimmed);
  return count > 0 && masked !== trimmed;
}

async function pasteFromTray(p: TrayRecentPayload): Promise<void> {
  const item: PastableItem = {
    id: p.id,
    type: p.itemType,
    text: p.text,
    content: p.content,
    content_type: p.contentType,
    source: p.source,
  };
  let ok = false;
  try {
    // 与 TrayPopup 的 doPaste 同款先补一次目标句柄：粘贴引擎对自有窗口有排除，
    // 此刻菜单已收起，抓到的仍是用户的应用窗口
    await invoke("save_foreground");
    // 确认条只有主窗口可见时才承载得住：隐藏状态先唤出主窗再粘（会短暂可见，
    // 用户本来就需要做「脱敏/原样/取消」的决定）
    if (willHitPasteGuard(item)) {
      const visible = await getCurrentWindow().isVisible().catch(() => true);
      if (!visible) await invoke("show_main_window");
    }
    ok = (await pasteHistoryItem(item, -1)).ok;
  } catch (e) {
    logger.warn("[TrayMenuBridge] 原生菜单粘贴失败", e);
    ok = false;
  }
  try {
    await invoke("tray_flash", { ok });
  } catch { /* 角标反馈失败不再叠加提示 */ }
}

export function useTrayMenuBridge(): void {
  const rc = useTrayRcShortcut();
  const connectRef = useRef(rc?.connect);
  connectRef.current = rc?.connect;

  // RcItem 上行：null = 判据不满足，Rust 撤下该项；读取失败时推禁用占位
  useEffect(() => {
    const item = rc && { label: rc.label, capLabel: rc.capLabel, disabled: rc.disabled ?? false };
    invoke("set_tray_rc_item", { item: item ?? null }).catch((e) =>
      logger.warn("[TrayMenuBridge] set_tray_rc_item 失败，原生菜单远程项不会更新", e),
    );
  }, [rc]);

  useEffect(() => {
    const offs: Array<() => void> = [];
    let cancelled = false;
    const track = (off: () => void) => { if (cancelled) off(); else offs.push(off); };
    void listen<TrayRecentPayload>("tray-menu-paste", (event) => pasteFromTray(event.payload))
      .then(track)
      .catch((e) => logger.warn("[TrayMenuBridge] tray-menu-paste 监听注册失败", e));
    void listen("tray-menu-rc-connect", () => void connectRef.current?.())
      .then(track)
      .catch((e) => logger.warn("[TrayMenuBridge] tray-menu-rc-connect 监听注册失败", e));
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, []);
}
