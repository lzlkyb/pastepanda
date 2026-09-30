/**
 * useRcKeyMode — 会话内「打字 / 直传」两档键盘模式（乙-①，2026-09-30）。
 *
 * 三件事在这一个口子上：
 * 1. 读偏好（默认打字；旧配置缺键走 `rcKeyModeOf` 的默认分支）；
 * 2. 切换即持久化（与 `useRcClipAutoPref` 同一条「乐观写 store → 串行落盘 → 失败回滚」
 *    链路，串行是为了快速连点时磁盘上留下的是最后一次选择）；
 * 3. 把档位**告诉对端**（`set_key_mode`）——真正决定注入方式的是被控端的
 *    `SendInput`，本机改档位不通知对方就等于没改。
 *
 * 生效时机：进会话（含换会话）、切档、以及从只看升回可控时各发一次。发送失败不
 * 回滚本地档位——本地值是用户的意图，链路恢复后下一条输入仍会带上它。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rcSendInput } from "@/lib/api/rc";
import {
  RC_KEY_MODE_KEY,
  rcKeyModeFromConfig,
  rcKeyModeSwitchedLabel,
  type RcKeyMode,
} from "@/lib/rcKeyMode";
import { useAppStore } from "@/stores/appStore";
import type { ToastFn } from "@/components/Toast";

export function useRcKeyMode({
  canControl,
  sessionId,
  say,
}: {
  canControl: boolean;
  sessionId: string;
  say: ToastFn;
}) {
  const [keyMode, setKeyMode] = useState<RcKeyMode>(() =>
    rcKeyModeFromConfig(useAppStore.getState().config),
  );
  const updateConfig = useAppStore((s) => s.updateConfig);
  const chainRef = useRef(Promise.resolve() as Promise<unknown>);

  // 只看会话没有注入可谈（对端根本不收键），不发信令也不摆按钮
  useEffect(() => {
    if (!canControl) return;
    void rcSendInput({ kind: "set_key_mode", mode: keyMode }).catch(() => {});
  }, [canControl, sessionId, keyMode]);

  const pickKeyMode = useCallback(
    (next: RcKeyMode) => {
      // 点当前档 = 无操作：切档会往出口条写一句确认，重复点同一档不该刷屏
      if (next === keyMode) return;
      updateConfig({ [RC_KEY_MODE_KEY]: next });
      const task = chainRef.current.then(async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_config", { config: useAppStore.getState().config });
      });
      chainRef.current = task.catch(() => {});
      setKeyMode(next);
      void task.catch(() => {
        updateConfig({ [RC_KEY_MODE_KEY]: keyMode });
        setKeyMode(keyMode);
        say("键盘模式保存失败，已还原", "error");
      });
      say(rcKeyModeSwitchedLabel(next), "success");
    },
    [keyMode, say, updateConfig],
  );

  return { keyMode, pickKeyMode };
}
