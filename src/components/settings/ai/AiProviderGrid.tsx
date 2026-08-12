/**
 * 服务商卡片网格（内置 + 自定义）。
 *
 * 从 AiSetupStep 抽出来：那个文件到了 367 行，破了规则 #7 的 300 行上限，
 * 而“选哪家”本身就是一个能独立讲清的单元：输入是厂商列表 + 当前选中，
 * 输出是“选了哪家 / 增删改自定义家”四个回调。
 *
 * 卡片布局为什么是两行（名字一行、标签一行），看 AiTab.module.css 里
 * `.provCard` 的注释——单行三列在 420px 弹窗里放不下中文厂商名，是数字问题。
 */

import { useState } from "react";
import { confirmDialog } from "@/lib/confirm";
import type { AiProviderInfo } from "@/lib/api";
import styles from "../AiTab.module.css";

interface Props {
  providers: AiProviderInfo[];
  /** 当前选中的厂商 id */
  currentId: string;
  onProviderChange: (id: string) => void;
  onAddCustom: () => void;
  onEditCustom: (item: {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    protocol: string;
  }) => void;
  onDeleteCustom: (id: string) => void;
}

/** 内置网格默认只摆前 8 家，多的收进「更多服务商」 */
const VISIBLE_PROVS = 8;

export function AiProviderGrid(p: Props) {
  const [showAll, setShowAll] = useState(false);

  const builtin = p.providers.filter((it) => !it.custom);
  const customs = p.providers.filter((it) => it.custom);

  // 第一个网格**永远只放前 8 家**，展开时由下面的第二个网格接着放剩下的。
  //
  // 原先这里是 `showAll ? builtin : builtin.slice(0, VISIBLE_PROVS)`，
  // 展开后第一个网格变成全部、而第二个网格又渲染 slice(VISIBLE_PROVS)
  // → **第 9 家及以后每家都出现两次**（用户实测到的“两个 Agnes”）。
  // key 相同但父节点不同，所以 React 不报重复 key 警告，一直没被发现。
  const shown = builtin.slice(0, VISIBLE_PROVS);

  const renderBuiltin = (it: AiProviderInfo) => {
    const on = it.id === p.currentId;
    return (
      <button
        key={it.id}
        className={`${styles.provCard}${on ? ` ${styles.provCardOn}` : ""}`}
        onClick={() => p.onProviderChange(it.id)}
        title={it.note}
      >
        <span className={styles.provName}>{it.name}</span>
        <span className={styles.provTags}>
          {/* 三个标签都必须带 provTag 基类（字号/内边距/圆角在那里统一定义），
              否则就是之前那个 bug：builtinFree 没进共享规则，标签大一圈。 */}
          {it.builtinFree && (
            <span className={`${styles.provTag} ${styles.provTagBuiltin}`}>内置免费</span>
          )}
          {!it.needsKey && !it.builtinFree && (
            <span className={`${styles.provTag} ${styles.provTagLocal}`}>本地</span>
          )}
          {it.hasKey && <span className={`${styles.provTag} ${styles.provTagSet}`}>已配置</span>}
          {/* ✓ 是标签行里靠右的成员，不再绝对定位——原来它与 .provDel 同坐标重叠，
              详见 AiTab.module.css 里 .provCk 的注释。 */}
          {on && <span className={styles.provCk}>✓</span>}
        </span>
      </button>
    );
  };

  const renderCustom = (it: AiProviderInfo) => {
    const on = it.id === p.currentId;
    return (
      <button
        key={it.id}
        className={`${styles.provCard}${on ? ` ${styles.provCardOn}` : ""}`}
        onClick={() => p.onProviderChange(it.id)}
        title={it.baseUrl || it.note}
      >
        {/* provNameInset：给右上角的 ✎ / ✕ 两个绝对定位按钮让位，
            内置卡没有这两个按钮所以不加 */}
        <span className={`${styles.provName} ${styles.provNameInset}`}>{it.name}</span>
        <span className={styles.provTags}>
          {it.hasKey && <span className={`${styles.provTag} ${styles.provTagSet}`}>已配置</span>}
          {on && <span className={styles.provCk}>✓</span>}
        </span>
        <span
          className={styles.provEdit}
          onClick={(e) => {
            e.stopPropagation();
            p.onEditCustom({
              id: it.id,
              name: it.name,
              baseUrl: it.baseUrl,
              model: it.model ?? "",
              protocol: it.protocol ?? "openai",
            });
          }}
          title="编辑"
        >
          ✎
        </span>
        <span
          className={styles.provDel}
          onClick={(e) => {
            e.stopPropagation();
            // 删除服务商 = 删配置 + 删密钥，不可恢复——统一确认弹窗
            void confirmDialog({
              title: "删除自定义服务商",
              message: `删除「${it.name}」会连配置和密钥一起清掉，确定吗？`,
              confirmText: "删除",
            }).then((ok) => {
              if (ok) p.onDeleteCustom(it.id);
            });
          }}
          title="删除"
        >
          ✕
        </span>
      </button>
    );
  };

  return (
    <>
      <div className={styles.provSection}>
        <span className={styles.provGroupLabel}>内置服务商</span>
        <div className={styles.provGrid}>{shown.map(renderBuiltin)}</div>
        {builtin.length > VISIBLE_PROVS && (
          <>
            {showAll && (
              <div className={styles.provGrid} style={{ marginTop: 7 }}>
                {builtin.slice(VISIBLE_PROVS).map(renderBuiltin)}
              </div>
            )}
            <button className={styles.moreBtn} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "▴ 收起" : `▾ 更多服务商（共 ${builtin.length} 家）`}
            </button>
          </>
        )}
      </div>

      <div className={styles.provSection}>
        <span className={styles.provGroupLabel}>
          自定义服务商
          <span className={styles.provGroupHint}>可添加多个中转 / 代理服务</span>
        </span>
        <div className={styles.provGrid}>
          {customs.map(renderCustom)}
          <button className={styles.provAdd} onClick={p.onAddCustom}>
            ＋ 添加自定义
          </button>
        </div>
      </div>
    </>
  );
}
