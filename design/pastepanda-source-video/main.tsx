import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import '../../src/styles/theme.css';
import '../../src/styles/globals.css';
import '../../src/styles/buttons.css';
import '../../src/styles/app.css';
import './preview.css';
import chapters from './chapters.json';
import inventory from './inventory.json';

let seconds = 0;
const steps = chapters.map(chapter => {
  const start = seconds;
  seconds += chapter.duration;
  return { ...chapter, start, end: seconds };
});

function Preview() {
  const [step, setStep] = useState(0);
  const chapter = steps[step];
  return <MotionConfig reducedMotion="always">
    <header className="reviewHeader">
      <div><strong>PastePanda / 完整软件介绍</strong><p>{seconds} 秒 · 16:9 · 月白主题 · {steps.length} 个分镜</p></div>
      <span className="proofLabel">原组件直接渲染 · 演示数据</span>
    </header>
    <main className="storyStage">
      <div className="storyCopy">
        <div className="brandLine"><img src="/icon.png" alt="" />PastePanda</div>
        <p className="sceneNumber">{String(step + 1).padStart(2, '0')} / {chapter.name}</p>
        <h1>{chapter.headline}</h1>
        <p className="sceneBody">{chapter.features.slice(0, 2).join(' · ')}</p>
        <div className="storyFoot">记录 · 处理 · 沉淀 · 互联</div>
      </div>
      <div className="productWindow" aria-label="550 × 700 的真实组件预览">
        <iframe title="550 × 700 源码界面" className="sourceFrame"
          src={`/design/pastepanda-source-video/surface.html?mode=${chapter.mode}&keyword=${encodeURIComponent(chapter.keyword || '')}`} />
      </div>
      <span className="windowDimensions">550 × 700 · 当前源码 / 原组件 / 原样式</span>
    </main>
    <section className="chapterDetail" aria-label="当前章节分镜说明">
      <div><strong>{chapter.start}–{chapter.end} 秒 · {chapter.name}</strong><p>{chapter.action}</p></div>
      <p className="referenceNote">当前 UI 参考：{chapter.reference}。静态校对页，尚未实现镜头动画。</p>
      <ul>{chapter.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
      <details><summary>已核对的源码</summary>{chapter.sources.map(source => <code key={source}>{source}</code>)}</details>
    </section>
    <nav className="shotNavigation" aria-label="选择分镜">
      {steps.map((scene, index) => <button key={scene.id} type="button"
        aria-pressed={index === step} onClick={() => setStep(index)}>
        <span>{scene.start}–{scene.end} 秒</span>{String(index + 1).padStart(2, '0')} · {scene.name}
      </button>)}
    </nav>
    <section className="chapterDetail" aria-label="源码功能清单">
      <strong>功能覆盖清单</strong>
      <p className="referenceNote">从当前源码提取入口与注册定义，辅助能力将在对应章节的清单字幕中出现。</p>
      {Object.entries(inventory).map(([group, entries]) => <details key={group}>
        <summary>{group}</summary><p className="catalogueEntries">{entries.join(' · ')}</p>
      </details>)}
    </section>
    <footer className="reviewFooter">
      <p>直接渲染 TopBar、SearchBox、ModeSwitcher、Card、ToolboxView、KnowledgeToolbar、NoteList 及其原 CSS。记录与演示笔记摘自 README。</p>
      <p>所有章节已核对源码入口；当前用三个主模式作 UI 参考，弹窗、截图、录屏、设备与灵动岛镜头待分镜确认后制作。预览不执行原生操作、不读取个人数据、不调用 AI。</p>
    </footer>
  </MotionConfig>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
