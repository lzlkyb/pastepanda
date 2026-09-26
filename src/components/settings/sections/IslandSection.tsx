/**
 * 设置页「灵动岛」分区（2026-09-26：玻璃档位从四档 chip 换成连续滑杆，布局 2）。
 *
 * 五个设置行：总开关 / 玻璃透度 / 到点提醒 / 横幅停留时长 / 到期优先排序。
 * 每次保存后广播 `todo-island-config-changed`——Rust（开关→show/hide）与岛前端
 * （遮盖度→`--island-glass`）都听这一个事件，生效路径收口在各自的单一入口。
 *
 * ❗ 滑杆是这套广播的唯一例外：拖动中每帧只发 `todo-island-glass-preview`（只有岛前端听，
 * Rust 不听 ⇒ 不触发显隐门控），**松手才** `save_config` + 广播。因为 `save_config` 每次调用
 * 都会把全量配置明文备份进 `config_backups/` 并轮转 10 份（`data_store/config.rs`）。
 *
 * 🔴 缺省值同账：总开关 = `DEFAULT_CONFIG.todo_island_enabled` 与 Rust `island_config`（两处）；
 *    遮盖度 = `DEFAULT_CONFIG.todo_island_glass`、`lib/todo/glass.ts` 的 `GLASS_DEFAULT`、
 *    `TodoIsland.module.css` 的 `--island-glass` 初值（三处）——改一处必须同步其余。
 */
import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import type { AppConfig } from "@/stores/appStore";
import { GLASS_MAX, GLASS_MIN, normalizeGlass } from "@/lib/todo/glass";
import { SettingTile, ToggleRow } from "../ToggleRow";
import shared from "../../Settings.module.css";
import styles from "./Island.module.css";

const REMIND_MS_OPTIONS: { ms: number; label: string }[] = [
  { ms: 10_000, label: "10秒" },
  { ms: 30_000, label: "30秒" },
  { ms: 60_000, label: "60秒" },
  { ms: 120_000, label: "2分钟" },
];

/** 保存 + 广播。❗ 必须**等 updateAndSave 落盘后**再 emit：Rust/岛前端收到事件会现读配置，
 *  先发后写会让它们读到旧值（开关拨了没反应就是这么来的）。 */
function saveAndNotify(updateAndSave: (p: Record<string, unknown>) => Promise<void>, patch: Record<string, unknown>) {
  void updateAndSave(patch).then(() => emit("todo-island-config-changed"));
}

/** 玻璃透度行（布局 2：整行宽预览条 + 下方滑杆）。
 *  草稿只在拖动期间存在（null = 没有未提交的拖动）；总开关关掉时本行随条件渲染一起卸载，
 *  丢掉草稿无副作用——岛都不在，预览也就无处可看。 */
function GlassRow({ stored, updateAndSave }: {
  stored: AppConfig["todo_island_glass"];
  updateAndSave: (p: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? normalizeGlass(stored);
  // 预览胶囊的底色要随数值连续变，而 U8 不许 JSX 内联 style ⇒ 经 ref 写 CSS 变量，
  // 与岛前端在 html 上写 `--island-glass` 是同一个手法。
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stageRef.current?.style.setProperty("--glass", String(shown));
  }, [shown]);

  const pick = (v: number) => {
    setDraft(v);
    // 事件本身失败（岛窗还没建好等）不该打断拖动——松手时的 save + 广播会重新对齐
    void emit("todo-island-glass-preview", v).catch(() => {});
  };
  const commit = () => {
    if (draft === null) return;
    if (draft !== normalizeGlass(stored)) saveAndNotify(updateAndSave, { todo_island_glass: draft });
    setDraft(null);
  };

  return (
    <div className={`${shared.sRow} ${styles.glassRow}`}>
      <div className={styles.glassHead}>
        <SettingTile hue="editor">🧊</SettingTile>
        <div className={shared.sRowBody}>
          <div className={shared.sRowLabel}>玻璃透度</div>
          <div className={shared.sRowDesc}>数值越大越实、文字越清楚；越小越像玻璃，但文字清楚度依赖桌面背景</div>
        </div>
        <div className={styles.glassReadout}>{shown}%</div>
      </div>
      <div ref={stageRef} className={styles.glassStage}>
        <div className={styles.glassPill}>今天 3 件 · 点横幅展开列表</div>
      </div>
      <div className={styles.glassSliderWrap}>
        <input
          className={styles.glassSlider}
          type="range"
          min={GLASS_MIN}
          max={GLASS_MAX}
          step={1}
          value={shown}
          aria-label="玻璃透度"
          onChange={(e) => pick(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <div className={styles.glassEnds}>
          <span>透 · 更像玻璃</span>
          <span>实 · 任何背景都清楚</span>
        </div>
      </div>
    </div>
  );
}

/** 必须返回片段：搜索过滤靠 settingsSections 容器下的「分区标题 + 设置行」扁平结构。 */
export function IslandSection({
  config,
  updateAndSave,
}: {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <>
      <div className={shared.sSection}>灵动岛</div>
      <ToggleRow
        icon="🏖️"
        hue="brand"
        label="启用灵动岛"
        desc="屏幕顶部常驻待办胶囊，随时看今天还剩几件"
        value={config.todo_island_enabled}
        onChange={(v) => saveAndNotify(updateAndSave, { todo_island_enabled: v })}
      />
      {/* 关 = 岛都不在，透度/提醒/排序调了也看不见——整块收起，不摆一列灰置行。 */}
      {config.todo_island_enabled && (
        <>
          <GlassRow stored={config.todo_island_glass} updateAndSave={updateAndSave} />
          <ToggleRow
            icon="🔔"
            hue="privacy"
            label="到点提醒"
            desc="任务到设定时间，岛弹出「到点了」横幅（不加系统通知）"
            value={config.todo_island_remind}
            onChange={(v) => saveAndNotify(updateAndSave, { todo_island_remind: v })}
          />
          <div className={shared.sRow}>
            <SettingTile hue="save">⏱️</SettingTile>
            <div className={shared.sRowBody}>
              <div className={shared.sRowLabel}>提醒横幅停留</div>
              <div className={shared.sRowDesc}>横幅显示多久后自动收回；点横幅会展开列表，在那里勾完成</div>
            </div>
            <div className={`${styles.seg} ${config.todo_island_remind ? "" : styles.segOff}`}>
              {REMIND_MS_OPTIONS.map((o) => (
                <button
                  key={o.ms}
                  className={`${styles.segBtn} ${config.todo_island_remind_ms === o.ms ? styles.segBtnSel : ""}`}
                  onClick={() => saveAndNotify(updateAndSave, { todo_island_remind_ms: o.ms })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <ToggleRow
            icon="🗓️"
            hue="sync"
            label="到期优先排序"
            desc="有截止时间的任务排前面；关闭后按创建顺序显示"
            value={config.todo_island_due_sort}
            onChange={(v) => saveAndNotify(updateAndSave, { todo_island_due_sort: v })}
          />
        </>
      )}
    </>
  );
}
