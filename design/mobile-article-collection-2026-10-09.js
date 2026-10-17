// Design-only state machine: no IPC, network fetch, local persistence or AI calls.
const app = document.querySelector('#app');
const phone = document.querySelector('#phone');
const sampleUrl = 'https://mp.weixin.qq.com/s/demo-article';
const sampleTitle = '读过很多，为什么还是记不住？';
const labels = { home:'知识库入口', link:'粘贴文章链接', loading:'正在读取正文', preview:'正常文章预览', error:'正文读取失败', partial:'部分图片缺失', duplicate:'重复收藏', bookmark:'仅链接阅读页', storage:'本机保存失败', draft:'已有笔记草稿', saved:'正文阅读页' };
const notes = {
  home:'只在“新建”中增加收藏文章；首页沿用现有结构。',
  link:'只有用户点“粘贴”才读取剪贴板。此设计稿提供示例链接，不会抓取真实网页。',
  loading:'先保留链接，再读取正文。返回时保留任务，不承诺退出 App 后自动完成。',
  preview:'正文占主要区域。分类和备注默认收起；保存后直接阅读。',
  error:'取得不到正文时明确告知；链接仍保留，可以重试或仅存链接。',
  partial:'正文可先保存。缺失图片逐张补齐，更新原笔记，不重复创建。',
  duplicate:'按文章身份检查已有收藏；不覆盖已有正文和用户备注。',
  bookmark:'仅存链接不会显示“已保存全文”。以后补正文仍更新这条笔记。',
  storage:'保存失败与保存按钮同时可见。保持预览和备注，允许重试。',
  draft:'文章收集与笔记草稿分别保留；不为了收藏而强迫用户放弃草稿。',
  saved:'短反馈放在工具区域上方，不浮盖正文。同步状态与本机保存分开。',
};
const paths = {
  back:'m12 19-7-7 7-7M5 12h14', plus:'M12 5v14M5 12h14', link:'M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2',
  book:'M4 4h7l1 2 1-2h7v16h-7l-1 2-1-2H4zM12 6v16', image:'M3 3h18v18H3zM3 17l6-6 5 5 3-3 4 4M8 7h.01', check:'m5 12 4 4L19 6', alert:'m12 3 10 18H2zM12 9v4M12 17h.01',
  star:'m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z', more:'M5 12h.01M12 12h.01M19 12h.01', search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  monitor:'M3 4h18v13H3zM12 17v4M8 21h8', folder:'M3 7V4h6l3 3h9v13H3z', settings:'M4 6h16M4 18h16M8 3v6M16 15v6', pen:'m4 16-1 5 5-1L21 7l-4-4zM14 6l4 4',
  clock:'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', share:'M12 16V2m-5 5 5-5 5 5M4 12v9h16v-9',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.link}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action, label, kind='text-button', image='') => `<button type="button" class="${kind}" data-action="${action}">${image ? icon(image) : ''}${label}</button>`;
let scene = 'home', sheet = '', link = '', remarks = '', tags = '', category = '未分类', title = sampleTitle;
let pending = false, hasDraft = false, saved = false, missing = 0, favorite = false, result = '', toast = '';
let taskTimer = 0, toastTimer = 0, taskToken = 0, focusBeforeSheet = null, renderedScene = '', infoMessage = '', completingBookmark = false;
let savedRecord = null, pendingRecord = null;
const snapshot = () => ({ link, title, remarks, tags, category, missing, completingBookmark });
function restore(record) { ({ link, title, remarks, tags, category, missing, completingBookmark } = record); }

function header(name, reader=false) {
  return `<header class="page-head ${reader ? 'reader-head' : ''}">${button('back','返回','text-button','back')}${reader ? '<span class="center">知识库</span>' : `<h2>${name}</h2>`}${reader ? button('more','更多','text-button','more') : ''}</header>`;
}
function notice(name, detail='', action='', tone='info') {
  return `<section class="notice" data-tone="${tone}" role="${tone === 'error' ? 'alert' : 'status'}"><strong>${icon(tone === 'error' || tone === 'warning' ? 'alert' : 'link')}<span>${name}</span></strong>${detail ? `<p>${detail}</p>` : ''}${action}</section>`;
}
function metadata() {
  return `<details class="article-details"><summary>分类、备注与来源</summary><label class="link-label" for="article-title">标题</label><input class="input" id="article-title" value="${escape(title)}"><label class="link-label" for="category">分类</label><select class="select" id="category">${['未分类','阅读笔记','工作参考'].map(c=>`<option${category===c?' selected':''}>${c}</option>`).join('')}</select><label class="link-label" for="tags">标签（可不填）</label><input class="input" id="tags" placeholder="例如：阅读、学习" value="${escape(tags)}"><label class="link-label" for="remarks">收藏原因（可不填）</label><textarea class="textarea" id="remarks" placeholder="留下当时想记住的事…">${escape(remarks)}</textarea><p class="address">原链接：${escape(link || sampleUrl)}</p></details>`;
}
function bodyContent() {
  return `<article class="article"><h1>${escape(title)}</h1><p class="source"><span>示例公众号</span><span>·</span><span>文章内容为设计演示</span></p><p>我们常常收藏一篇好文章，却在需要用到的时候，想不起它到底说了什么。收藏只是起点，把它和眼前的问题连起来，才更容易留下印象。</p><h3 id="point-one">先留下一个有用的问题</h3><p>读完一段，试着写一句话：这段内容能帮我解决什么问题？不用总结整篇文章，也不必整理得很漂亮。</p><blockquote>给未来的自己留一个线索，比再多收藏十篇文章更有用。</blockquote>${missing ? Array.from({length:missing},(_,i)=>`<div class="missing-image">${icon('image')}<span>图片 ${i+1} 未保存到手机</span>${button('image-one','补齐这张','secondary')}</div>`).join('') : ''}<h3 id="point-two">需要时，再回来看</h3><p>下次遇到类似的问题，从自己写下的线索找到这篇文章。重新阅读时，答案会变得更具体。</p><p>把知识留在能找到的地方，也给阅读留一点余地。</p></article>`;
}
function home() {
  return `<section class="page home"><header class="page-head"><h2>知识库</h2>${button('new','新建','text-button','plus')}</header><div class="scroll">${button('sync','<span>本机知识库</span><small>同步状态</small>','sync-summary','monitor')}${toast ? flowToast() : ''}${hasDraft ? notice('有一份未完成草稿','读书笔记：关于专注',button('draft-open','继续写')) : ''}${pending ? notice('有 1 条待收集文章','链接已保留，继续预览后再保存。',button('resume','继续收藏')) : ''}<label class="search">${icon('search')}<input id="search" placeholder="搜索笔记" aria-label="搜索本机笔记"></label><div class="tabs">${['全部','常用','最近阅读'].map((t,i)=>`<button data-action="tab" aria-pressed="${i===0}">${t}</button>`).join('')}</div><p class="subtle" id="count">3 篇笔记 · 示例数据</p><div class="notes" id="note-list">${button('existing',`<strong>${escape(title)}</strong><small>${saved?'正文已保存到手机':'阅读笔记 · 已有收藏'} · 今天</small>`,'note-row')}${button('note-demo','<strong>给自己留一点专注的时间</strong><small>工作参考 · 昨天</small>','note-row')}${button('note-demo','<strong>周末散步时想到的事</strong><small>未分类 · 10月7日</small>','note-row')}</div></div><nav class="nav" aria-label="页面导航">${[['monitor','设备'],['folder','文件'],['book','知识库'],['settings','设置']].map(([i,t])=>`<button data-action="${t==='知识库'?'home':'nav-demo'}" aria-pressed="${t==='知识库'}">${icon(i)}${t}</button>`).join('')}</nav></section>`;
}
function linkInput() {
  return `<section class="page">${header('收藏文章')}<div class="scroll"><h3>从微信复制文章链接</h3><p class="subtle">在文章右上角菜单选择“复制链接”，回到这里粘贴。支持可公开访问的文章。</p><form id="link-form"><label class="link-label" for="url">文章链接</label><textarea class="textarea" id="url" placeholder="https://…" aria-describedby="url-help url-error">${escape(link)}</textarea><p id="url-error" class="input-error" role="alert" hidden></p><div class="link-tools">${button('paste','粘贴链接','secondary','link')}<button type="submit" class="primary">读取文章</button></div></form><p id="url-help" class="subtle">粘贴后直接读取正文；失败时也能仅存链接。</p>${button('sample','试用示例链接')}<p class="subtle">设计演示：读取与保存均为模拟结果。</p></div></section>`;
}
function loading() {
  return `<section class="page">${header('收藏文章')}<div class="capture-layout"><div class="scroll"><div class="loading-title" role="status">${icon('clock')}正在读取文章正文…</div><p class="subtle">链接已保留，可以返回稍后继续。</p><div class="skeleton title"></div><div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div><p class="address">${escape(link||sampleUrl)}</p></div><aside class="save-pane"><div class="save-actions">${button('bookmark-save','仅存链接','secondary')}${button('back','返回，稍后继续')}</div></aside></div></section>`;
}
function preview() {
  return `<section class="page">${header('文章预览')}<div class="capture-layout"><div class="scroll">${missing ? notice(`正文可用，${missing} 张图片未保存`,'可以先保存正文，之后在这篇笔记里补齐。','','warning') : '<p class="note-status">正文已取得 · 尚未保存</p>'}${bodyContent()}${metadata()}</div><aside class="save-pane" aria-label="保存文章操作">${result ? `<div class="result" role="alert"><strong>文章还没有保存</strong><p>${result}</p></div>` : ''}<div class="save-actions">${button(result?'save-retry':'save',result?'重试保存':'保存文章','primary','check')}${button('bookmark-save','仅存链接')}</div></aside></div></section>`;
}
function failed() {
  return `<section class="page">${header('收藏文章')}<div class="capture-layout"><div class="scroll">${notice('暂时无法读取正文','可能需要登录、验证，或原文已不可用。链接仍保留。',button('original','打开原文'),'error')}<article class="article"><h1>${escape(title)}</h1><p class="address">${escape(link||sampleUrl)}</p></article><p class="subtle">你也可以从原文复制文字，或收集截图作为补充。</p>${button('supplement','补充文字或截图','secondary','pen')}${metadata()}</div><aside class="save-pane"><div class="save-actions">${button('retry-fetch','重新读取正文','primary')}${button('bookmark-save','仅存链接','secondary')}</div></aside></div></section>`;
}
function duplicate() {
  return `<section class="page">${header('收藏文章')}<div class="capture-layout"><div class="scroll">${notice('这篇文章已经收藏过','已有正文和备注保持原样，直接继续阅读。')}<article class="article"><h1>${escape(title)}</h1><p class="source">示例公众号 · 10月8日收藏</p><p>正文已保存在手机。</p><h3>你之前的备注</h3><blockquote>下次整理项目文档时，再读一下“留下有用的问题”这一段。</blockquote></article></div><aside class="save-pane"><div class="save-actions">${button('existing','查看已有笔记','primary','book')}${button('original','打开原文')}</div></aside></div></section>`;
}
function flowToast() { return `<div class="flow-toast" role="status">${icon('check')}<span>${toast}</span>${button('dismiss-toast','关闭')}</div>`; }
function reader(bookmark=false) {
  return `<section class="page">${header('',true)}<div class="scroll">${bookmark ? `<article class="article"><h1>${escape(title)}</h1><p class="source">示例公众号 · 来源链接</p>${notice('仅保存了链接','手机还没有这篇文章的正文。',button('fill-body','读取并补充正文'))}<p class="address">${escape(link||sampleUrl)}</p>${button('original','打开原文','secondary','link')}${remarks ? `<h3>我的备注</h3><p>${escape(remarks)}</p>` : ''}</article>` : `<p class="note-status">${missing ? `正文已保存 · ${missing} 张图片待补齐` : '正文已保存到手机 · 可离线阅读'}</p>${missing ? notice(`${missing} 张图片未保存在手机`,'正文仍可阅读，补图不会覆盖你的备注。',button('image-all','补齐剩余图片'),'warning') : ''}${bodyContent()}${remarks ? `<article class="article"><h3>我的备注</h3><p>${escape(remarks)}</p></article>` : ''}`}</div><footer class="reader-footer">${toast ? flowToast() : ''}<div class="reader-actions"><button data-action="favorite" aria-pressed="${favorite}">${icon('star')}${favorite?'已常用':'常用'}</button>${button('outline','目录','secondary','list')}${button('share','分享','secondary','share')}</div></footer></section>`;
}
function render() {
  // Feedback changes keep the reading position and expanded optional fields.
  const sameScene = renderedScene === scene;
  const scrollTop = sameScene ? document.querySelector('.page>.scroll,.capture-layout>.scroll')?.scrollTop || 0 : 0;
  const detailsOpen = sameScene && !!document.querySelector('.article-details[open]');
  document.querySelector('#sceneLabel').textContent = labels[scene] || labels.home;
  document.querySelector('#stageNote').textContent = notes[scene] || notes.home;
  document.querySelectorAll('[data-scene]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scene === scene || (scene==='draft'&&b.dataset.scene==='draft'))));
  app.innerHTML = scene==='home'||scene==='draft' ? home() : scene==='link' ? linkInput() : scene==='loading' ? loading() : scene==='error' ? failed() : scene==='duplicate' ? duplicate() : scene==='bookmark' ? reader(true) : scene==='saved' ? reader() : preview();
  renderedScene = scene;
  if (detailsOpen && document.querySelector('.article-details')) document.querySelector('.article-details').open = true;
  const scroll = document.querySelector('.page>.scroll,.capture-layout>.scroll');
  if (scroll) scroll.scrollTop = scrollTop;
  if (sheet) renderSheet();
}
function go(next) { ++taskToken; clearTimeout(taskTimer); sheet=''; scene=next; render(); }
function showToast(message) { clearTimeout(toastTimer); toast=message; render(); toastTimer=setTimeout(()=>{ toast=''; document.querySelector('.flow-toast')?.remove(); },4500); }
function startFetch(value, destination='preview') {
  try { const url=new URL(value); if (!['http:','https:'].includes(url.protocol)||url.username||url.password) throw new Error(); link=url.href; }
  catch { const error=document.querySelector('#url-error'); if(error) { error.hidden=false; error.textContent='请粘贴完整的 http 或 https 文章链接。'; document.querySelector('#url').setAttribute('aria-invalid','true'); } return; }
  pending=true; result=''; go('loading'); const token=taskToken;
  taskTimer=setTimeout(()=>{ if(token===taskToken) { scene=destination; render(); } },1200);
}
function saveArticle(retry=false) {
  if (!title.trim()) title=sampleTitle;
  if(scene==='storage'&&!retry) { result='手机可用空间不足。清理空间后重试，正文和备注仍保留。'; render(); return; }
  result=''; go('loading'); const token=taskToken;
  app.innerHTML=`<section class="page">${header('保存文章')}<div class="scroll"><p class="loading-title" role="status">${icon('clock')}正在保存到手机…</p><p class="subtle">正在提交这篇文章的正文与附件。</p></div></section>`;
  taskTimer=setTimeout(()=>{ if(token!==taskToken) return; saved=true; pending=false; pendingRecord=null; savedRecord={...snapshot(),linkOnly:false}; scene='saved'; showToast(missing?'正文已保存，图片可以稍后补齐。':completingBookmark?'正文已补充到原笔记':'文章已保存到手机'); completingBookmark=false; },900);
}
function openSheet(kind) { focusBeforeSheet=document.activeElement; sheet=kind; renderSheet(); }
function closeSheet() { document.querySelector('.sheet-layer')?.remove(); if(app.querySelector('.page')) app.querySelector('.page').inert=false; sheet=''; focusBeforeSheet?.isConnected && focusBeforeSheet.focus(); }
function renderSheet() {
  document.querySelector('.sheet-layer')?.remove();
  app.querySelector('.page').inert=true;
  const menus={
    new:['新建',`${button('write',`${icon('pen')}<span>写笔记<small>记录自己的想法</small></span>`,'menu-item')}${button('article',`${icon('link')}<span>收藏文章<small>保存链接、正文和可取得图片</small></span>`,'menu-item')}${button('images',`${icon('image')}<span>收集图片<small>沿用现有图片收集流程</small></span>`,'menu-item')}`],
    more:['更多',`${button('original','查看原文','menu-item','link')}${button('outline','目录','menu-item','list')}${button('edit-demo','修改笔记','menu-item','pen')}${button('sync','同步状态','menu-item','monitor')}`],
    outline:['目录',`${button('jump-one','先留下一个有用的问题','menu-item')}${button('jump-two','需要时，再回来看','menu-item')}`],
    draft:['原草稿已单独保留',`<p class="subtle">“读书笔记：关于专注”仍保留在本机。收藏文章不使用这份草稿。</p>${button('article','继续收藏文章','primary')}${button('draft-open','返回原草稿','secondary')}`],
    supplement:['补充内容',`${button('text-supplement','粘贴正文文字','menu-item','pen')}${button('images','收集截图','menu-item','image')}<p class="subtle">这是替代收集方式，不会将截图标记为已取得全文。</p>`],
    info:['设计演示',`<p class="subtle">${escape(infoMessage)}</p>${button('close-sheet','知道了','primary')}`],
  };
  const [name,content]=menus[sheet]||menus.info;
  app.insertAdjacentHTML('beforeend',`<div class="sheet-layer"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><button class="sheet-handle" data-action="close-sheet" aria-label="收起面板"></button><header class="sheet-head"><h3 id="sheet-title">${name}</h3>${button('close-sheet','关闭')}</header><div class="sheet-body">${content}</div></section></div>`);
  document.querySelector('.sheet-head button').focus();
}
function info(message) { infoMessage=message; openSheet('info'); }

app.addEventListener('submit',e=>{ if(e.target.id==='link-form') { e.preventDefault(); startFetch(document.querySelector('#url').value.trim()); } });
app.addEventListener('input',e=>{
  if(e.target.id==='url') { ++taskToken; link=e.target.value; e.target.removeAttribute('aria-invalid'); document.querySelector('#url-error').hidden=true; }
  if(e.target.id==='remarks') remarks=e.target.value;
  if(e.target.id==='tags') tags=e.target.value;
  if(e.target.id==='article-title') title=e.target.value;
  if(e.target.id==='search') { const rows=[...document.querySelectorAll('.note-row')]; rows.forEach(r=>r.hidden=!r.textContent.includes(e.target.value)); document.querySelector('#count').textContent=`${rows.filter(r=>!r.hidden).length} 篇笔记 · 示例数据`; }
});
app.addEventListener('change',e=>{ if(e.target.id==='category') category=e.target.value; });
app.addEventListener('paste',e=>{ if(e.target.id==='url') { const text=e.clipboardData?.getData('text')?.trim(); if(text) { e.preventDefault(); link=text; e.target.value=text; startFetch(text); } } });
app.addEventListener('click',async e=>{
  if(e.target.classList.contains('sheet-layer')) { closeSheet(); return; }
  const el=e.target.closest('[data-action]'); if(!el) return;
  switch(el.dataset.action) {
    case 'home': go('home'); break;
    case 'back': if(['preview','partial','error','loading','storage'].includes(scene)) { pending=true; pendingRecord={...snapshot(),scene:scene==='loading'?'preview':scene}; } go('home'); break;
    case 'new': openSheet('new'); break;
    case 'close-sheet': closeSheet(); break;
    case 'article': closeSheet(); if(pendingRecord) { restore(pendingRecord); go(pendingRecord.scene); } else { link=''; remarks=''; tags=''; category='未分类'; title=sampleTitle; missing=0; completingBookmark=false; go('link'); } break;
    case 'sample': link=sampleUrl; startFetch(link); break;
    case 'paste': {
      const token=taskToken, field=document.querySelector('#url');
      try { const text=await navigator.clipboard.readText(); if(token!==taskToken || field!==document.querySelector('#url')) return; if(!text.trim()) throw new Error(); field.value=text; startFetch(text.trim()); }
      catch { if(token!==taskToken || field!==document.querySelector('#url')) return; const error=document.querySelector('#url-error'); if(error) { error.hidden=false; error.textContent='未能读取剪贴板。请长按输入框粘贴，或试用示例链接。'; } } break;
    }
    case 'resume': if(pendingRecord) { restore(pendingRecord); go(pendingRecord.scene); } else startFetch(link||sampleUrl,missing?'partial':'preview'); break;
    case 'retry-fetch': startFetch(link||sampleUrl); break;
    case 'save': saveArticle(); break;
    case 'save-retry': saveArticle(true); break;
    case 'bookmark-save': pending=false; pendingRecord=null; saved=true; savedRecord={...snapshot(),linkOnly:true}; go('bookmark'); showToast('链接已保存到手机，尚未保存正文'); break;
    case 'existing': if(savedRecord) { restore(savedRecord); go(savedRecord.linkOnly?'bookmark':'saved'); } else { saved=true; missing=0; remarks='下次整理项目文档时，再读一下“留下有用的问题”这一段。'; go('saved'); } break;
    case 'fill-body': completingBookmark=true; startFetch(link||sampleUrl); break;
    case 'image-one': missing=Math.max(0,missing-1); if(scene==='saved') { if(savedRecord) savedRecord.missing=missing; showToast('这张图片已补齐到原笔记'); } else render(); break;
    case 'image-all': missing=0; if(savedRecord) savedRecord.missing=0; showToast('剩余图片已补齐到原笔记'); break;
    case 'favorite': favorite=!favorite; showToast(favorite?'已加入常用':'已取消常用'); break;
    case 'dismiss-toast': clearTimeout(toastTimer); toast=''; document.querySelector('.flow-toast')?.remove(); break;
    case 'more': openSheet('more'); break;
    case 'outline': if(scene==='bookmark') info('仅存链接时没有正文目录。'); else openSheet('outline'); break;
    case 'jump-one': case 'jump-two': { const target=el.dataset.action==='jump-one'?'#point-one':'#point-two'; closeSheet(); document.querySelector(target)?.scrollIntoView({block:'start'}); break; }
    case 'original': info('正式版会由用户确认后打开原文。本设计稿不访问微信或外部文章。'); break;
    case 'share': info('沿用 Android 系统分享。打开分享面板与实际发送成功分别反馈；设计稿不会发送内容。'); break;
    case 'sync': info('本机保存独立完成。电脑同步沿用现有配对与同步流程，结果另行显示。'); break;
    case 'supplement': openSheet('supplement'); break;
    case 'write': case 'draft-open': info('沿用现有笔记编辑器；文章链接单独保留，不覆盖笔记草稿。'); break;
    case 'images': info('沿用现有手机图片收集预览。本稿不调用真实相册。'); break;
    case 'text-supplement': info('沿用现有文字收集，可手动粘贴正文。来源与用户补充内容分别记录。'); break;
    case 'edit-demo': info('沿用现有笔记修改流程。补图或重新读取不会自动覆盖用户修改。'); break;
    case 'note-demo': info('首页普通笔记沿用现有阅读页，本稿重点展示文章收藏流程。'); break;
    case 'nav-demo': info('其他页面保持现有界面，本稿不重做设备、文件和设置。'); break;
    case 'tab': document.querySelectorAll('.tabs button').forEach(b=>b.setAttribute('aria-pressed',String(b===el))); break;
  }
});
document.addEventListener('keydown',e=>{
  if(!sheet) return;
  if(e.key==='Escape') { e.preventDefault(); closeSheet(); }
  if(e.key==='Tab') { const items=[...document.querySelector('.sheet').querySelectorAll('button,input,textarea,select,summary,a')]; const first=items[0],last=items.at(-1); if(e.shiftKey&&document.activeElement===first) { e.preventDefault(); last.focus(); } else if(!e.shiftKey&&document.activeElement===last) { e.preventDefault(); first.focus(); } }
});
document.querySelector('#scenarios').addEventListener('click',e=>{
  const el=e.target.closest('[data-scene]'); if(!el) return;
  clearTimeout(toastTimer); savedRecord=null; pendingRecord=null; toast=''; result=''; title=sampleTitle; remarks=''; tags=''; category='未分类'; saved=false; pending=false; hasDraft=false; completingBookmark=false; missing=el.dataset.scene==='partial'?2:0; link=sampleUrl;
  go(el.dataset.scene);
  if(scene==='draft') { hasDraft=true; pending=true; render(); openSheet('draft'); }
  if(scene==='storage') { result='手机可用空间不足。清理空间后重试，正文和备注仍保留。'; render(); }
});
document.querySelector('#presets').addEventListener('click',e=>{ const el=e.target.closest('[data-size]'); if(!el) return; phone.dataset.size=el.dataset.size; document.querySelectorAll('#presets button').forEach(b=>b.setAttribute('aria-pressed',String(b===el))); });
document.querySelector('#dark').addEventListener('change',e=>document.documentElement.dataset.theme=e.target.checked?'midnight':'ocean');
document.querySelector('#large').addEventListener('change',e=>phone.dataset.large=String(e.target.checked));
render();
