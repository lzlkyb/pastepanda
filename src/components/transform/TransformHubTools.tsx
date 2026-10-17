import { useMemo, useState } from "react";
import { ChevronDown, LockKeyhole, QrCode, Search } from "lucide-react";
import { listTransforms } from "@/lib/transforms";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { TIcon } from "./TransformIcon";
import styles from "../TransformHub.module.css";

/** 仅在用户展开时列工具名称；不挂载全部卡片，避免同时运行所有本地预览。 */
export function TransformHubTools({ onSelect, onQr, onCodec }: {
  onSelect: (id: string) => void;
  onQr: () => void;
  onCodec: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const aiAvailable = isAiAvailable();
  const tools = useMemo(() => listTransforms().filter(t => !t.remote || aiAvailable), [aiAvailable]);
  const keyword = query.trim().toLocaleLowerCase();
  const matches = (label: string) => !keyword || label.toLocaleLowerCase().includes(keyword);
  const filtered = tools.filter(t => matches(`${t.label} ${t.description ?? ""} ${t.id}`));
  return (
    <div className={styles.tools}>
      <button className={styles.toolsToggle} aria-expanded={open}
        aria-controls="hub-all-tools" onClick={() => setOpen(v => !v)}>
        {open ? "收起全部变换" : "查看全部变换"}
        <ChevronDown size={14} className={open ? styles.toolsChevronOpen : undefined} />
      </button>
      {open && <div id="hub-all-tools" className={styles.toolsBody}>
        <label className={styles.toolSearch}>
          <Search size={14} />
          <input value={query} onChange={e => setQuery(e.target.value)}
            aria-label="查找全部变换" placeholder="查找名称，如二维码、Base64、SQL" />
        </label>
        <div className={styles.toolList}>
          {matches("二维码 QR 生成 识别") && <button className={styles.toolEntry} onClick={onQr}>
            <QrCode size={15} /> 二维码工作台
          </button>}
          {matches("编解码 工作台 Base64 URL JWT 时间戳") && <button className={styles.toolEntry} onClick={onCodec}>
            <LockKeyhole size={15} /> 编解码工作台
          </button>}
          {filtered.map(t => <button key={t.id} className={styles.toolEntry}
            onClick={() => { onSelect(t.id); setOpen(false); }}>
            <TIcon name={t.icon} /> {t.label}
          </button>)}
          {filtered.length === 0 && !matches("二维码 QR 生成 识别") && !matches("编解码 工作台 Base64 URL JWT 时间戳") &&
            <p className={styles.toolEmpty}>没有找到，请换个名称试试。</p>}
        </div>
        <p className={styles.toolHint}>手动选择仅代表你的意图，请核对转换预览。</p>
      </div>}
    </div>
  );
}
