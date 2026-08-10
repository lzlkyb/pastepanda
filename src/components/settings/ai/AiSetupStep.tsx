/**
 * AI 配置的主流程：**选服务商 → 选模型 → 粘密钥**。
 *
 * 模型放在主流程而不是高级区：“用哪个模型”是用户真会在意的选择，
 * 藏起来等于默认大家都用便宜档。默认值仍然是便宜档（清单第一项），
 * 但得让人一眼看到可以换。
 *
 * 其余旋钮（地址 / 协议 / 超时 / 预算）全在折叠的高级区。例外只有一个：
 * 不填就必定测失败的字段（自定义服务的地址、火山方舟/Ollama 的模型名）
 * 必须留在主流程——把必填项藏起来，只会换来一次莫名其妙的失败。
 *
 * “保存”与“测试”合成一个按钮：分成两个的话，保存完什么都不会发生，
 * 用户无法判断自己配对了没有。
 */

import type { RefObject } from "react";
import { useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import type { AiConfig, AiProviderInfo } from "@/lib/api";
import settings from "../../Settings.module.css";
import { AiBadge } from "@/components/AiBadge";
import styles from "../AiTab.module.css";

interface Props {
  providers: AiProviderInfo[];
  spec: AiProviderInfo | null;
  config: AiConfig;
  keyInput: string;
  hasKey: boolean;
  testing: boolean;
  keyRef: RefObject<HTMLInputElement | null>;
  onProviderChange: (id: string) => void;
  onKeyInput: (value: string) => void;
  /** 修改本地草稿（不落盘） */
  onDraft: (patch: Partial<AiConfig>) => void;
  /** 失焦时落盘 */
  onCommit: () => void;
  /** 点芯片这种一步到位的操作立即落盘 */
  onSave: (patch: Partial<AiConfig>) => void;
  onSaveAndTest: () => void;
  /** v6.4：自定义服务商管理 */
  onAddCustom: () => void;
  onEditCustom: (item: { id: string; name: string; baseUrl: string; model: string; protocol: string }) => void;
  onDeleteCustom: (id: string) => void;
}

async function openExternal(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    // 打不开浏览器不值得报错打断配置流程
  }
}

export function AiSetupStep(p: Props) {
  const { spec, config, keyInput, hasKey, testing } = p;

  // 地址为空的厂商（自定义/中转）不填地址就没法请求，得摆在主流程
  const needsBaseUrl = !!spec && !spec.baseUrl;
  const needsKey = spec ? spec.needsKey : true;
  const freeTextModel = !!spec && spec.modelIsFreeText;

  // 模型芯片只是快捷方式；下面的输入框对**所有**服务商常驻，
  // 清单外的模型直接手填即可——厂商改模型名的速度比我们改表快。
  const chips = spec?.models ?? [];
  const current = config.model.trim();
  // 留空 = 用清单第一项，所以空值时高亮的也是第一项；
  // 填了清单外的模型则一个芯片都不高亮，当前值就在输入框里摆着
  const activeModel = current || chips[0]?.id || "";

  // 没密钥、也没新输入 → 无从测起
  const canTest = testing ? false : !needsKey || hasKey || !!keyInput.trim();
  const actionLabel = keyInput.trim() || !(hasKey || !needsKey) ? "保存并测试" : "测试连通性";

  // v6.4：模型芯片折叠——前 4 个常用，多的收进「更多模型 ▾」
  const [modelsOpen, setModelsOpen] = useState(false);
  const VISIBLE_CHIPS = 4;
  const renderChip = (m: (typeof chips)[number]) => (
    <button
      key={m.id}
      className={`${styles.chip} ${m.id === activeModel ? styles.chipActive : ""}`}
      onClick={() => p.onSave({ model: m.id })}
    >
      <span className={styles.chipTitle}>
        {m.label}
        {m.id === activeModel && <Check size={11} />}
      </span>
      <span className={styles.chipId}>
        {m.id}
        {/* 原本是拼在字符串里的纯文本，改用同一个徽标组件 */}
        {m.reasoning && <AiBadge kind="thinking" size="xs" />}
      </span>
    </button>
  );

  return (
    <>
      <div className={styles.step}>
        <span className={styles.stepNum}>1</span>
        <div className={styles.stepBody}>
          <span className={styles.stepTitle}>选服务商</span>

          {/* v6.4：卡片网格（内置 + 自定义）替代原下拉 */}
          <div className={styles.provSection}>
            <span className={styles.provGroupLabel}>内置服务商</span>
            <div className={styles.provGrid}>
              {p.providers
                .filter((it) => !it.custom)
                .map((it) => {
                  const on = it.id === config.provider;
                  return (
                    <button
                      key={it.id}
                      className={`${styles.provCard}${on ? ` ${styles.provCardOn}` : ""}`}
                      onClick={() => p.onProviderChange(it.id)}
                      title={it.note}
                    >
                      <span className={styles.provName}>{it.name}</span>
                      <span className={styles.provTags}>
                        {!it.needsKey && <span className={styles.provTagLocal}>本地</span>}
                        {it.hasKey && <span className={styles.provTagSet}>已配置</span>}
                      </span>
                      {on && <span className={styles.provCk}>✓</span>}
                    </button>
                  );
                })}
            </div>
          </div>

          <div className={styles.provSection}>
            <span className={styles.provGroupLabel}>
              自定义服务商
              <span className={styles.provGroupHint}>可添加多个中转 / 代理服务</span>
            </span>
            <div className={styles.provGrid}>
              {p.providers
                .filter((it) => it.custom)
                .map((it) => {
                  const on = it.id === config.provider;
                  return (
                    <button
                      key={it.id}
                      className={`${styles.provCard}${on ? ` ${styles.provCardOn}` : ""}`}
                      onClick={() => p.onProviderChange(it.id)}
                      title={it.baseUrl || it.note}
                    >
                      <span className={styles.provName}>{it.name}</span>
                      <span className={styles.provTags}>
                        {it.hasKey && <span className={styles.provTagSet}>已配置</span>}
                      </span>
                      {on && <span className={styles.provCk}>✓</span>}
                      <span
                        className={styles.provEdit}
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onEditCustom({ id: it.id, name: it.name, baseUrl: it.baseUrl, model: "", protocol: "" });
                        }}
                        title="编辑"
                      >
                        ✎
                      </span>
                      <span
                        className={styles.provDel}
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onDeleteCustom(it.id);
                        }}
                        title="删除"
                      >
                        ✕
                      </span>
                    </button>
                  );
                })}
              <button className={styles.provAdd} onClick={p.onAddCustom}>
                ＋ 添加自定义
              </button>
            </div>
          </div>

          {spec && (
            <div className={styles.providerNote}>
              <span>{spec.note}</span>
              {spec.keyUrl && (
                <button className={styles.linkBtn} onClick={() => void openExternal(spec.keyUrl)}>
                  去申请 Key
                  <ExternalLink size={11} />
                </button>
              )}
            </div>
          )}
          {needsBaseUrl && (
            <input
              className={styles.input}
              value={config.baseUrl}
              placeholder="https://你的中转地址/v1"
              onChange={(e) => p.onDraft({ baseUrl: e.target.value })}
              onBlur={p.onCommit}
            />
          )}
          {spec?.custom && (
            <span className={styles.hint}>
              自定义服务商：模型/地址/密钥按这条独立保存。切到别的家再回来，配置原样还在。
            </span>
          )}
        </div>
      </div>

      <div className={styles.step}>
        <span className={styles.stepNum}>2</span>
        <div className={styles.stepBody}>
          <span className={styles.stepTitle}>选模型</span>

          {chips.length > 0 && (
            <div className={styles.chips}>
              {chips.slice(0, VISIBLE_CHIPS).map(renderChip)}
            </div>
          )}

          {/* v6.4：模型多的家折叠，避免横向溢出 */}
          {chips.length > VISIBLE_CHIPS && (
            <>
              {modelsOpen && <div className={styles.moreGrid}>{chips.slice(VISIBLE_CHIPS).map(renderChip)}</div>}
              <button className={styles.moreBtn} onClick={() => setModelsOpen((v) => !v)}>
                {modelsOpen ? "▴ 收起" : `▾ 更多模型（这家共 ${chips.length} 个）`}
              </button>
            </>
          )}

          {/* 输入框对所有服务商常驻：清单永远会过时，不能把人锁在里面 */}
          <input
            className={styles.input}
            value={config.model}
            placeholder={spec?.modelHint || chips[0]?.id || "模型名"}
            onChange={(e) => p.onDraft({ model: e.target.value })}
            onBlur={p.onCommit}
          />

          <span className={styles.hint}>
            {chips.length === 0
              ? "这家服务商需要你自己填模型名。"
              : freeTextModel
                ? "清单只是快捷方式，输入框里可直接填任意模型。"
                : "剪贴板动作都是短文本，默认档基本够用。清单外的新模型直接在输入框里填；留空则用第一档。"}
          </span>

          {/* 推理模型的 token 语义和普通模型不一样，不说的话用户必然踩坑：
              把上限按“短产物 300～800”给，结果额度全花在思考上、答案一个字都没有 */}
          {chips.some((m) => m.id === activeModel && m.reasoning) && (
            <span className={styles.hint}>
              ⚠ 这是推理模型：回答前会先输出一大段思考，而思考的 token
              照样计费、也照样占用动作的 token 上限。自定义动作的上限建议给到 3000
              以上；只想要快且便宜的短产物，换回上面不带“会先思考”标记的档位更合适。
            </span>
          )}
        </div>
      </div>

      <div className={styles.step}>
        <span className={styles.stepNum}>3</span>
        <div className={styles.stepBody}>
          <span className={styles.stepTitle}>
            {needsKey ? "粘贴 API Key" : "确认本地服务已启动"}
            {hasKey && <span className={styles.keyBadge}>✓ 已存过密钥</span>}
          </span>

          {needsKey ? (
            <div className={styles.row}>
              <input
                ref={p.keyRef}
                className={`${styles.input} ${styles.rowGrow}`}
                type="password"
                value={keyInput}
                placeholder={hasKey ? "已保存；输入新密钥可替换" : "sk-..."}
                onChange={(e) => p.onKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canTest) p.onSaveAndTest();
                }}
              />
              <button className={settings.btnPrimary} disabled={!canTest} onClick={p.onSaveAndTest}>
                {testing && <Loader2 size={12} className="spin" />}
                {testing ? "测试中…" : actionLabel}
              </button>
            </div>
          ) : (
            <div className={styles.row}>
              <button className={settings.btnPrimary} disabled={!canTest} onClick={p.onSaveAndTest}>
                {testing && <Loader2 size={12} className="spin" />}
                {testing ? "测试中…" : "测试连通性"}
              </button>
            </div>
          )}

          <span className={styles.hint}>
            {needsKey ? (
              <>
                密钥以当前 Windows 用户身份加密后单独存放，<strong>不进</strong>配置库与配置备份；
                保存后无法再读出明文。每家服务商分开存，切回来不用重输。
              </>
            ) : (
              "完全本地运行：不需密钥、零费用、内容不出机器。需先自行安装并启动 Ollama。"
            )}
          </span>
        </div>
      </div>
    </>
  );
}
