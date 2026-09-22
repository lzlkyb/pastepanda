/**
 * RcA2ConnectionFacts — 详情面的「连接与权限」4 行事实表。
 *
 * 从 `RcA2DeviceDetail` 拆出（2026-09-22）：详情面当时 294 行，已贴着 `.tsx ≤ 300`
 * 的红线，而这一轮要给它加在线 pill 和四个语义色图标 —— 原地加必然超标。
 * 这一块是纯展示（四行固定结构、输入全是算好的字符串），没有状态、没有副作用，
 * 是这次改动里最干净的一刀。
 *
 * 拆分时的约定：**表格结构一行没动**，只是每行的 `dt` 前面多了一个 26px 的
 * 语义色图标块（设计稿 C 的「权限项语义色图标」）。图标走语义名（U6），
 * 「设备身份」那行走中性 —— 项目没有紫色语义令牌，而身份是客观事实不是状态。
 */
import { Check, FileUp, Link, ShieldCheck } from "lucide-react";
import styles from "./RemoteComputerA2.module.css";

export function RcA2ConnectionFacts({
  connection,
  hasPath,
  measuredRtt,
  trusted,
  autoAccept,
  fingerprint,
}: {
  /** 「上次连接」的值（`pathKindLabel` 的结果，空则调用侧已经给了兜底文案）。 */
  connection: string;
  /** 是否真有过一次成功连接 —— 决定注解写「来自最近一次会话实测」还是「首次连接后显示」。 */
  hasPath: boolean;
  /** 最近一次采到的实测 RTT（ms）。0 = 从没采到过，整段不显示（不编数字）。 */
  measuredRtt: number;
  trusted: boolean;
  autoAccept: boolean;
  fingerprint: string;
}) {
  return (
    <dl className={styles.factList}>
      <div>
        <dt>
          <span className={styles.factIcon} data-tone="link" aria-hidden="true">
            <Link size={14} />
          </span>
          上次连接
        </dt>
        <dd>{connection}</dd>
        <span>
          {hasPath ? "来自最近一次会话实测" : "首次连接后显示实际路径"}
          {measuredRtt > 0 ? ` · 最近实测 ~${measuredRtt} ms` : ""}
        </span>
      </div>
      <div>
        <dt>
          <span className={styles.factIcon} data-tone="ok" aria-hidden="true">
            <Check size={14} />
          </span>
          连接确认
        </dt>
        <dd>{trusted ? "免确认连接" : "每次由对方确认"}</dd>
        <span>{trusted ? "仍可随时结束会话" : "默认更安全"}</span>
      </div>
      <div>
        <dt>
          <span className={styles.factIcon} data-tone="file" aria-hidden="true">
            <FileUp size={14} />
          </span>
          文件接收
        </dt>
        <dd>{autoAccept ? "自动接收" : "每次询问"}</dd>
        <span>{autoAccept ? "文件会保存到默认目录" : "接受后才写入电脑"}</span>
      </div>
      <div>
        <dt>
          <span className={styles.factIcon} data-tone="id" aria-hidden="true">
            <ShieldCheck size={14} />
          </span>
          设备身份
        </dt>
        <dd className={styles.mono}>{fingerprint}</dd>
        <span>
          <ShieldCheck size={14} aria-hidden="true" /> 已完成配对核验
        </span>
      </div>
    </dl>
  );
}
