/**
 * 录前画质渐进展开；预览与确认条共用同一接线。
 *
 * 2026-10-16 拆分（规则 7）：音源按钮移出到 `RecAudioToggles`——它不再写「开 / 关」，
 * 与画质这枚「设置名 + 当前值」是两种不同的控件语义，混在一个组件里只会让
 * 「谁负责状态」变得含混。同时删掉死导出 `recSettingsBadge`（全仓零引用，
 * 它复述的那句「电脑声音 开 · 麦克风 关」正是 §5.1 要删的第二载体）。
 */
import { REC_QUALITIES, type RecQualityItem } from "@/lib/recQuality";

/** 画质浮层：作为玻璃条的子元素定位在条上方（条贴近屏顶时翻到下方）。 */
function SettingsPop({
  flipBelow,
  quality,
  onQuality,
}: {
  flipBelow: boolean;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
}) {
  return (
    <div
      className={`rec-glass rec-pop${flipBelow ? " below" : ""}`}
      id="rec-pop"
      role="group"
      aria-label="画质与声音"
    >
      <div className="rec-pop-row">
        <span className="lbl">画质</span>
        <span className="rec-seg" role="group" aria-label="画质档位">
          {REC_QUALITIES.map((q) => (
            <button
              key={q.key}
              type="button"
              className={quality.key === q.key ? "on" : ""}
              onClick={() => onQuality(q)}
              title={q.desc}
              // 🔴 选中态必须能被读屏拿到（改前只有 class = 视觉独占）。
              // 用 aria-pressed 而非 role=radio：radio 的既定期望是方向键 + roving tabindex，
              // 只贴 role 不实现键盘是半套语义；且音源两个开关本来就是 aria-pressed。
              aria-pressed={quality.key === q.key}
            >
              {q.label}
            </button>
          ))}
        </span>
      </div>
      <div className="rec-pop-row">
        <span className="muted">高清适合办公演示；标准和流畅优先减小文件。麦克风开启后才录入你的讲解。</span>
      </div>
    </div>
  );
}

/** 画质选项按需展开（音源已挪到 RecAudioToggles，两枚都是常驻可达）。 */
export function SettingsCluster(props: {
  open: boolean;
  onToggle: () => void;
  flipBelow: boolean;
  quality: RecQualityItem;
  onQuality: (q: RecQualityItem) => void;
}) {
  const { open } = props;
  return (
    <>
      <button
        type="button"
        className="rec-btn-ghost"
        onClick={props.onToggle}
        aria-expanded={open}
        // 触发器 ↔ 浮层的关系与展开态一起报给读屏（改前只有 aria-expanded）
        aria-haspopup="true"
        aria-controls={open ? "rec-pop" : undefined}
        title="画质与声音"
      >
        画质 {props.quality.label}
      </button>
      {open && (
        <SettingsPop
          flipBelow={props.flipBelow}
          quality={props.quality}
          onQuality={props.onQuality}
        />
      )}
    </>
  );
}
