/**
 * 设置页「复制与粘贴」分区（2026-09-29 分区重排 方案A）。
 *
 * 这一节原先叫「通用」，是个兜底筐：采集、粘贴、隐私、观感、窗口、编辑器全塞在一起。
 * 现在只留「内容进出的规则」这一族，其余各归各节（观感→外观，窗口/编辑器→系统与编辑，
 * 保留天数→数据管理）。
 *
 * 🔴 必须返回片段，原因同 StatsSection：搜索过滤要求容器 children 是「标题 + 行」一层扁平结构。
 */
import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "@/stores/appStore";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow, SettingTile } from "../ToggleRow";
import styles from "../../Settings.module.css";

interface CopyPasteSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

export function CopyPasteSection({ config, updateAndSave }: CopyPasteSectionProps) {
  /*
   * 应用排除名单：本地草稿 + onBlur 提交（与同页其它文本输入 AiSetupStep 一致）。
   *
   * 原写法是 `onChange={() => updateAndSave(...)}`，而 updateAndSave = 改 store + 写整份配置：
   * 输「KeePass, 1Password」就是 18 次全量写库；写库失败时还会每敲一个字弹一次错误 toast。
   */
  const [excludedDraft, setExcludedDraft] = useState(config.excluded_apps);
  /** 已提交值：用它判「草稿真的变了吗」，避免每次 blur 都写一遍库 */
  const committedRef = useRef(config.excluded_apps);
  // 外部改了配置（恢复默认 / 其它窗口）时把草稿拉齐
  useEffect(() => {
    setExcludedDraft(config.excluded_apps);
    committedRef.current = config.excluded_apps;
  }, [config.excluded_apps]);

  // ❗ 改成 onBlur 后多了一条丢数据路径：用户输完直接按 Esc 退设置，blur 来不及触发。
  //   用 ref 装最新的提交函数 + 空依赖的卸载清理，在卸载时补一次提交。
  //   （不能把 commit 直接写进依赖：updateAndSave 每次渲染都是新函数，那样会变成每渲染都跑一次清理。）
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => {
    if (excludedDraft === committedRef.current) return;
    committedRef.current = excludedDraft;
    void updateAndSave({ excluded_apps: excludedDraft });
  };
  useEffect(() => () => commitRef.current(), []);

  return (
    <>
      <div className={styles.sSection}>复制与粘贴</div>
      <ToggleRow icon="✂️" hue="save" label="自动去除空白" desc="复制时去除首尾空白字符" value={config.auto_strip} onChange={(v) => updateAndSave({ auto_strip: v })}
        tooltip="粘贴代码时尤其有用，避免多余缩进"
        detailTitle="自动去除空白"
        detail={<>
          <p>复制文本时自动去除首尾的空格、换行等空白字符。</p>
          <p>📌 <b>适合场景</b>：复制代码、复制网页文字</p>
          <p>💡 开启后粘贴更干净，无需手动删空格</p>
        </>}
      />
      <ToggleRow icon="📄" hue="capture" label="文档保真采集" desc="从 Word/网页等复制时保留格式结构" value={config.doc_capture} onChange={(v) => updateAndSave({ doc_capture: v })}
        tooltip="开启后，从 Word/Excel/网页复制带表格/标题/列表的内容时，会保留 HTML 格式片段，便于清洗与转 Markdown"
        detailTitle="文档保真采集"
        detail={<>
          <p>开启后，从 Word/Excel/网页复制<b>带结构的内容</b>（表格、标题、列表）时，会保留 HTML 格式片段，不再只存纯文本。</p>
          <p>📌 保留的结构可在编辑器中清洗、转 Markdown、表格保真输出</p>
          <p>💡 无结构的普通复制（聊天、记事本）不受影响</p>
        </>}
      />
      <ToggleRow icon="📋" hue="paste" label="保留格式粘贴" desc="粘贴文档/图文时保留富格式" value={config.paste_format_default !== "plain"} onChange={(v) => updateAndSave({ paste_format_default: v ? "auto" : "plain" })}
        tooltip="开启时粘贴文档/图文内容保留富格式（CF_HTML）；关闭则全部粘贴纯文本"
        detailTitle="保留格式粘贴"
        detail={<>
          <p>开启时，粘贴文档或图文内容到目标应用时保留<b>富格式</b>（表格、链接、加粗等）。</p>
          <p>关闭后，所有内容一律粘贴为纯文本——适合需要干净粘贴到终端/代码编辑器的场景</p>
        </>}
      />
      <ToggleRow icon="🛡️" hue="privacy" label="敏感内容防护" desc="不记录匹配密钥/凭证模式的内容" value={config.skip_sensitive} onChange={(v) => updateAndSave({ skip_sensitive: v })}
        tooltip="开启后，复制密码、Token、密钥等敏感内容时不会记录到历史，也不会通过局域网同步"
        detailTitle="敏感内容防护"
        detail={<>
          <p>开启后，剪贴板捕获到匹配密钥/凭证特征的内容（如 JWT、AWS Key、GitHub Token、长 Base64 串）时，将<b>不写入历史、不显示、不局域网同步</b>。</p>
          <p>📌 <b>适合场景</b>：从密码管理器或网页复制密码、复制 API 密钥</p>
          <p>💡 建议保持开启，避免敏感信息意外留存</p>
        </>}
      />
      <div className={styles.sRow}>
        <SettingTile hue="privacy">🚫</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            应用排除名单
            <HelpTooltip tooltip="来自这些应用的复制内容不会被记录，多个应用用英文逗号分隔" />
          </div>
          <div className={`${styles.sRowDesc}`}>来自这些应用的复制内容不会被记录（逗号分隔）</div>
          <input
            type="text"
            className={styles.sTextInput}
            value={excludedDraft}
            aria-label="应用排除名单"
            placeholder="例如：KeePass, 1Password, Bitwarden"
            onChange={(e) => setExcludedDraft(e.target.value)}
            onBlur={() => commitRef.current()}
            onKeyDown={(e) => { if (e.key === "Enter") commitRef.current(); }}
          />
        </div>
      </div>
      <ToggleRow icon="🔁" hue="paste" label="依次粘贴循环" desc="到达末尾后从头开始" value={config.sequential_loop} onChange={(v) => updateAndSave({ sequential_loop: v })}
        tooltip="适合重复粘贴同一组内容时使用"
      />
    </>
  );
}
