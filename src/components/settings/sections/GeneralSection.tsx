import type { AppConfig } from "@/stores/appStore";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow } from "../ToggleRow";
import { WindowSystemRows } from "./WindowSystemRows";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

const CLEANUP_OPTIONS = [
  { label: "关", value: 0 },
  { label: "7天", value: 7 },
  { label: "15天", value: 15 },
  { label: "30天", value: 30 },
  { label: "60天", value: 60 },
];

interface GeneralSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  cleanupDays: SettingsData["cleanupDays"];
  handlePickCleanupDays: SettingsData["handlePickCleanupDays"];
  trashDays: SettingsData["trashDays"];
  handlePickTrashDays: SettingsData["handlePickTrashDays"];
  mdAssoc: SettingsData["mdAssoc"];
  mdAssocBusy: SettingsData["mdAssocBusy"];
  handleMdAssocToggle: SettingsData["handleMdAssocToggle"];
}

// 🔴 必须返回片段，原因同 StatsSection。
// 后半段（窗口/系统/编辑器）在 WindowSystemRows，它也返回片段，所以容器 children 依旧扁平。
export function GeneralSection({
  config, updateAndSave,
  cleanupDays, handlePickCleanupDays, trashDays, handlePickTrashDays,
  mdAssoc, mdAssocBusy, handleMdAssocToggle,
}: GeneralSectionProps) {
  return (
    <>
      {/* ── 通用 ── */}
      <div className={styles.sSection}>通用</div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F59E0B, #FF9500)" }}>🗑</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            自动清理
            <HelpTooltip
              tooltip="启动后每小时自动清理超过指定天数、未置顶的记录"
              detailTitle="自动清理"
              detail={<>
                <p>应用启动后每小时检查一次，自动删除超过指定天数的旧记录。</p>
                <p>📌 <b>推荐 30 天</b>：平衡存储空间和历史追溯</p>
                <p>📌 置顶记录永不清理；手动「清理过期记录」同样受此天数约束</p>
                <p>⚠️ 设为「关」则不自动清理，需手动管理</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>清理超过该天数的记录（置顶除外），启动后每小时自动执行</div>
        </div>
        <div className={styles.sCleanup}>
          {CLEANUP_OPTIONS.map((opt, idx) => (
            <button key={`cleanup-${opt.value ?? idx}`}
              className={`${styles.sCleanupOpt}${cleanupDays === opt.value ? ` ${styles.active}` : ""}`}
              onClick={() => { void handlePickCleanupDays(opt.value); }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {/* 回收站保留天数（W1 / R3）。紧跟在自动清理后面，但文案必须把
          「这是笔记、那是剪贴板」说清楚——两行长得一样，误认了就是删错东西。 */}
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #6366F1, #8B5CF6)" }}>♻</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            笔记回收站
            <HelpTooltip
              tooltip="删掉的笔记在回收站保留多久，到期自动销毁"
              detailTitle="笔记回收站"
              detail={<>
                <p>删掉的笔记不会立即消失，而是进入<b>知识库侧栏底部的回收站</b>，随时可以恢复。</p>
                <p>📌 连它的<b>历史版本与标签一起保留</b>，恢复后原样回来</p>
                <p>📌 回收站里的笔记<b>不参与搜索</b>，也不算进笔记总数</p>
                <p>⚠️ 这与上面的「自动清理」<b>是两回事</b>：那个管剪贴板历史，这个管笔记</p>
                <p>⚠️ 设为「关」则永久保留，只能在回收站里手动清</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>删掉的笔记先进回收站，超过该天数后自动销毁（不可恢复）</div>
        </div>
        <div className={styles.sCleanup}>
          {CLEANUP_OPTIONS.map((opt, idx) => (
            <button key={`trash-${opt.value ?? idx}`}
              className={`${styles.sCleanupOpt}${trashDays === opt.value ? ` ${styles.active}` : ""}`}
              onClick={() => { void handlePickTrashDays(opt.value); }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <ToggleRow icon={<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 8.6 18 18M15.4 8.6 6 18"/></svg>} gradient="linear-gradient(135deg, #10B981, #34C759)" label="自动去除空白" desc="复制时去除首尾空白字符" value={config.auto_strip} onChange={(v) => updateAndSave({ auto_strip: v })}
        tooltip="粘贴代码时尤其有用，避免多余缩进"
        detailTitle="自动去除空白"
        detail={<>
          <p>复制文本时自动去除首尾的空格、换行等空白字符。</p>
          <p>📌 <b>适合场景</b>：复制代码、复制网页文字</p>
          <p>💡 开启后粘贴更干净，无需手动删空格</p>
        </>}
      />
      <ToggleRow icon="🛡" gradient="linear-gradient(135deg, #EF4444, #DC2626)" label="敏感内容防护" desc="不记录匹配密钥/凭证模式的内容" value={config.skip_sensitive} onChange={(v) => updateAndSave({ skip_sensitive: v })}
        tooltip="开启后，复制密码、Token、密钥等敏感内容时不会记录到历史，也不会通过局域网同步"
        detailTitle="敏感内容防护"
        detail={<>
          <p>开启后，剪贴板捕获到匹配密钥/凭证特征的内容（如 JWT、AWS Key、GitHub Token、长 Base64 串）时，将<b>不写入历史、不显示、不局域网同步</b>。</p>
          <p>📌 <b>适合场景</b>：从密码管理器或网页复制密码、复制 API 密钥</p>
          <p>💡 建议保持开启，避免敏感信息意外留存</p>
        </>}
      />
      <ToggleRow icon="📄" gradient="linear-gradient(135deg, #3B82F6, #6366F1)" label="文档保真采集" desc="从 Word/网页等复制时保留格式结构" value={config.doc_capture} onChange={(v) => updateAndSave({ doc_capture: v })}
        tooltip="开启后，从 Word/Excel/网页复制带表格/标题/列表的内容时，会保留 HTML 格式片段，便于清洗与转 Markdown"
        detailTitle="文档保真采集"
        detail={<>
          <p>开启后，从 Word/Excel/网页复制<b>带结构的内容</b>（表格、标题、列表）时，会保留 HTML 格式片段，不再只存纯文本。</p>
          <p>📌 保留的结构可在编辑器中清洗、转 Markdown、表格保真输出</p>
          <p>💡 无结构的普通复制（聊天、记事本）不受影响</p>
        </>}
      />
      <ToggleRow icon="📋" gradient="linear-gradient(135deg, #8B5CF6, #6366F1)" label="保留格式粘贴" desc="粘贴文档/图文时保留富格式" value={config.paste_format_default !== "plain"} onChange={(v) => updateAndSave({ paste_format_default: v ? "auto" : "plain" })}
        tooltip="开启时粘贴文档/图文内容保留富格式（CF_HTML）；关闭则全部粘贴纯文本"
        detailTitle="保留格式粘贴"
        detail={<>
          <p>开启时，粘贴文档或图文内容到目标应用时保留<b>富格式</b>（表格、链接、加粗等）。</p>
          <p>关闭后，所有内容一律粘贴为纯文本——适合需要干净粘贴到终端/代码编辑器的场景</p>
        </>}
      />
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F43F5E, #E11D48)" }}>🚫</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            应用排除名单
            <HelpTooltip tooltip="来自这些应用的复制内容不会被记录，多个应用用英文逗号分隔" />
          </div>
          <div className={`${styles.sRowDesc}`}>来自这些应用的复制内容不会被记录（逗号分隔）</div>
          <input
            type="text"
            value={config.excluded_apps}
            placeholder="例如：KeePass, 1Password, Bitwarden"
            onChange={(e) => updateAndSave({ excluded_apps: e.target.value })}
            style={{
              marginTop: 6,
              width: "100%",
              padding: "6px 10px",
              fontSize: 12,
              borderRadius: 8,
              border: "1px solid var(--border-color)",
              background: "var(--input-bg)",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #AF52DE)" }}>👆</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            双击列表行为
            <HelpTooltip
              tooltip="设为「复制」更快捷，设为「预览」可查看详情"
              detailTitle="双击行为"
              detail={<>
                <p>设置双击卡片时的默认操作。</p>
                <p>📌 <b>复制</b>：双击直接复制内容到剪贴板</p>
                <p>📌 <b>预览</b>：双击弹出预览面板，可查看详情或编辑</p>
                <p>💡 设为「预览」后仍可通过悬停卡片快速复制</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>{config.double_click_action === "copy" ? "双击复制到剪贴板" : "双击预览/编辑"}</div>
        </div>
        <button className={styles.sVal} onClick={() => updateAndSave({ double_click_action: config.double_click_action === "copy" ? "preview" : "copy" })}>
          {config.double_click_action === "copy" ? "复制" : "预览"}
        </button>
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #6366F1, #818CF8)" }}>🖱️</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            卡片悬浮行为
            <span className={`${styles.sRowRecommend}`}>⭐推荐</span>
            <HelpTooltip
              tooltip="鼠标悬停卡片时的交互方式"
              detailTitle="卡片悬浮行为"
              detail={<>
                <p>设置鼠标悬停在卡片上时的交互方式。</p>
                <p>📌 <b>关闭</b>：无悬浮交互，界面最简洁</p>
                <p>📌 <b>操作按钮</b>：Hover 显示复制/收藏/编辑/删除按钮，时间自动隐藏</p>
                <p>📌 <b>预览气泡</b>：弹出 Popover 气泡，内容预览+操作</p>
                <p>💡 <b>推荐气泡模式</b>，适合浏览长文本内容</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {config.hover_mode === "off" ? "无悬浮交互，界面最简洁" : config.hover_mode === "inline" ? "Hover 显示操作按钮，时间自动隐藏" : "弹出 Popover 预览气泡，内容预览+操作"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button className={`${styles.sSegOpt}${config.hover_mode === "off" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "off" })} title="关闭">
            <span className={styles.sSegEmoji}>🚫</span>
          </button>
          <button className={`${styles.sSegOpt}${config.hover_mode === "inline" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "inline" })} title="操作按钮">
            <span className={styles.sSegEmoji}>👆</span>
          </button>
          <button className={`${styles.sSegOpt}${config.hover_mode === "popover" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "popover" })} title="预览气泡">
            <span className={styles.sSegEmoji}>💬</span>
          </button>
        </div>
      </div>

      {/* 来源图标模式 */}
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #EC4899, #F43F5E)" }}>🎯</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            来源图标
            <span className={`${styles.sRowRecommend}`}>⭐推荐</span>
            <HelpTooltip
              tooltip="应用真实图标更直观，首次提取约需 50ms"
              detailTitle="来源图标"
              detail={<>
                <p>控制剪贴板卡片中来源 Badge 的图标显示方式。</p>
                <p>📌 <b>应用图标</b>：提取真实程序图标（推荐，更直观）</p>
                <p>📌 <b>Emoji</b>：使用预设的 emoji 图标</p>
                <p>💡 <b>推荐真实图标</b>，一眼就能识别来源应用</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {config.source_icon_mode === "app" ? "显示真实程序图标，更直观" : "显示预设 Emoji 图标"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button className={`${styles.sSegOpt}${config.source_icon_mode === "emoji" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ source_icon_mode: "emoji" })} title="Emoji 图标">
            <span className={styles.sSegEmoji}>😀</span>
          </button>
          <button className={`${styles.sSegOpt}${config.source_icon_mode === "app" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ source_icon_mode: "app" })} title="应用真实图标">
            <span className={styles.sSegEmoji}>🖼️</span>
          </button>
        </div>
      </div>
      <WindowSystemRows
        config={config} updateAndSave={updateAndSave}
        mdAssoc={mdAssoc} mdAssocBusy={mdAssocBusy} handleMdAssocToggle={handleMdAssocToggle}
      />
    </>
  );
}
