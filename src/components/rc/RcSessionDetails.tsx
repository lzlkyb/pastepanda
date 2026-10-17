import type { RcSession } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import type { useRcFrames } from "@/hooks/useRcFrames";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import { RcHud } from "./RcHud";

export function RcSessionDetails({ session, rc, frames, link, quality, scope, pointerLocked, linkSched = "" }: {
  session: RcSession; rc: UseRc; frames: ReturnType<typeof useRcFrames>; link: RcLinkSnapshot;
  quality: string; scope: string; pointerLocked: boolean;
  /** 链路调度相位（P1）：rc-direct-fps-tuning 分支的链路调度状态机产出，空串 = 不显示。 */
  linkSched?: string;
}) {
  return (
          <RcHud
            codec={frames.codec}
            fps={frames.fps}
            rttMs={link.rttMs}
            frameLatencyMs={frames.latencyMs}
            lossPermille={rc.status?.loss_permille}
            bitrateKbps={frames.bitrateKbps}
            segCapMs={frames.segCapMs}
            segEncMs={frames.segEncMs}
            segNetMs={frames.segNetMs}
            segDecMs={frames.segDecMs}
            respMs={frames.respMs}
            quality={quality}
            /* 🔴 自动档的落点只有**推流那台机器**知道。这里只在本机作为被控端
                推流（inbound_active）时拿得到生效档；出站会话显示「由对方决定」。 */
            activeQuality={
              session.phase === "inbound_active" ? rc.status?.active_quality : undefined
            }
            peerDriven={session.phase !== "inbound_active"}
            scope={scope}
            linkState={link.state}
            pathKind={rc.status?.path_kind ?? ""}
            linkSched={linkSched}
            pointerLocked={pointerLocked}
            frameSize={frames.size}
          />
  );
}
