import { ChevronRight, Plus, Search } from "lucide-react";
import type { useChainWorkspace } from "@/hooks/useChainWorkspace";
import { SequenceDiscover } from "@/components/SequenceDiscover";
import styles from "../ChainRunnerDialog.module.css";

export function ChainChoices({ workspace: w }: { workspace: ReturnType<typeof useChainWorkspace> }) {
  const list = w.chains.filter(c => `${c.name} ${c.description}`.toLocaleLowerCase().includes(w.query.trim().toLocaleLowerCase()));
  return <>
    <h3>你想得到什么结果？</h3><p className={styles.intro}>选一个现成流程，先看步骤，再决定是否运行。</p>
    {w.loadError && <div className={styles.error} role="alert">{w.loadError}<button className={styles.textButton} onClick={() => void w.reload()} disabled={w.loading}>重新加载我的流程</button></div>}
    {w.loading && <p className={styles.hint} role="status">正在读取我的流程；内置流程可先使用。</p>}
    <label className={styles.search}><Search size={14} /><input aria-label="查找现成流程" placeholder="查找流程，如 JSON、脱敏" value={w.query} onChange={e => w.setQuery(e.target.value)} /></label>
    <div className={styles.templates}>{list.map(c => <button key={c.id} className={styles.template} onClick={() => w.select(c)}>
      <span><strong>{c.name}</strong><small>{c.description || "自定义处理流程"}</small></span><ChevronRight size={15} />
    </button>)}</div>
    {!list.length && <p className={styles.hint}>没有找到这个流程。换个名称，或自己组合步骤。</p>}
    <button className={styles.textButton} onClick={() => w.edit(true)}><Plus size={13} />自己组合步骤</button>
    <SequenceDiscover open={w.open && w.view === "choose"} />
  </>;
}
