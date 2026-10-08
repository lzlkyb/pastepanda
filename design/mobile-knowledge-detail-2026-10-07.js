"use strict";
const $ = (s) => document.querySelector(s);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (text) => String(text).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const button = (action, label, glyph, cls="action", extra="") => `<button type="button" class="${cls}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ""}${label}</button>`;
const notice = (title, detail, tone="", action="", label="") => `<section class="notice ${tone}" role="status"><strong>${title}</strong><p>${detail}</p>${action ? button(action,label) : ""}</section>`;
const baseNotes = [
  {id:"guide",title:"电脑远程连接检查清单",folder:"工作笔记",tag:"指南",time:"今天 08:40",excerpt:"连接之前，核对网络、授权与画面。遇到异常，按步骤排查。",common:true},
  {id:"meeting",title:"项目会议记录 · 客户交付",folder:"项目资料",tag:"会议",time:"昨天 17:20",excerpt:"会议确认了交付范围和三个待核对事项，周五前回复客户。",common:true},
  {id:"network",title:"办公室网络配置",folder:"工作笔记",tag:"配置",time:"10月5日",excerpt:"办公网络的配置说明与检查步骤。含一张电脑端截图。",common:false},
  {id:"decision",title:"项目会议记录 · 实施决定",folder:"项目资料",tag:"会议",time:"10月4日",excerpt:"会议决定分两批交付，先完成查阅，再接快速记录。",common:false},
  {id:"travel",title:"出差资料清单",folder:"个人资料",tag:"清单",time:"10月3日",excerpt:"出发前核对常用地址、会议材料和已保存到手机的资料。",common:false}
];
const explanations = {
  home:"首版：最近、手机常用和全部。分类按需展开，正文资料优先。",
  welcome:"首版：知识库授权与远控配对分开。未授权也可以在手机记内容。",
  local:"首版：尚未开启同步时，只查阅手机独立记录，不混入电脑示例资料。",
  first:"首版：初次同步只显示真实可确认的状态；不虚构百分比，可取消。",
  search:"首版：在已落盘内容中搜索。返回阅读前的关键词、筛选与位置。",
  empty:"首版：无结果与读取失败分开；可清除筛选，不让用户猜。",
  loaderror:"首版：读取失败给明确恢复动作；不会假装库是空的。",
  reader:"首版：全文阅读，代码和表格局部横滚，更多动作不抢正文空间。",
  missing:"首版：文字已经保存，图片尚缺失；不能标成完整离线资料。",
  offline:"首版：电脑离线仍读手机已有内容，说明版本可能不是最新。",
  new:"首版：独立新建，不自动追加电脑今日速记。标题可后填。",
  draft:"首版：返回、旋转和重开都需要恢复已落盘草稿。此稿使用预览专用暂存。",
  saved:"首版：保存到手机即可结束记录，电脑离线不等于保存失败。",
  saveerror:"首版：保存失败保留输入；恢复后重试不创建重复笔记。",
  partial:"首版：文字与图片分别反馈。同步部分失败不报告全部完成。",
  revoked:"首版：撤销授权停止后续同步，手机新内容保留，已保存内容继续可读。",
  conflict:"后续批次：轻编辑须核验基础版本；出现冲突，保留手机草稿及电脑新版。",
  deleted:"后续批次：对端删除不能被手机编辑静默复活；可另存新笔记。",
  share:"后续批次：系统分享文字/链接，先预览再保存到手机，不等待电脑开机。",
  shareerror:"后续批次：临时分享内容无法读取，给重新分享/返回的恢复路径。",
  duplicate:"后续批次：发现相同的文字或链接时先核对已有笔记，不自动保存两次。",
  link:"后续批次边界：相同标题有多篇，明确选择，不能直接打开第一篇。",
  broken:"后续批次边界：已删除/未同步的笔记链接有说明，并可回到原资料。"
};
const state = {scene:"home",page:"home",view:"recent",query:"",folder:"",tag:"",active:"guide",modal:null,draft:null,savedId:null,result:null,readResult:null,online:true,authorized:true,missing:false,failSave:false,conflict:false,deleted:false,scroll:0,tab:"knowledge",returnPage:"home"};
let notes=baseNotes.map(n=>({...n})), savedCounter=0, draftTimer=null, modalOrigin=null;
const readingPositions = new Map();
let recentIds=["guide","meeting","network"];
const DRAFT_KEY="pastepanda-design-kb-draft-20261007";
function storeDraft() { try { sessionStorage.setItem(DRAFT_KEY,JSON.stringify(state.draft)); return true; } catch { return false; } }
function readDraft() { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY)||"null"); } catch { return null; } }
function removeDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} }
function createDraft() { state.draft={id:`capture-${++savedCounter}`,title:"",body:""}; state.result=null; state.failSave=false; state.conflict=false; state.deleted=false; }
function chooseScene(scene) {
  clearTimeout(draftTimer); Object.assign(state,{scene,page:"home",tab:"knowledge",query:"",folder:"",tag:"",view:"recent",modal:null,active:"guide",result:null,readResult:null,online:true,authorized:true,missing:false,failSave:false,conflict:false,deleted:false,scroll:0});
  if(scene==="welcome"||scene==="local") state.authorized=false;
  if(["reader","missing","offline","link","broken"].includes(scene)) state.page="reader";
  if(scene==="missing") { state.active="network"; state.missing=true; }
  if(scene==="offline") state.online=false;
  if(scene==="search") state.query="会议";
  if(scene==="empty") state.query="年度预算不存在";
  if(["new","draft","saved","saveerror","conflict","deleted","share","duplicate"].includes(scene)) {
    createDraft(); state.page="editor";
    if(scene!=="new") state.draft={id:`capture-${savedCounter}`,title:scene==="share"?"一个值得保存的链接":"客户交付备忘",body:scene==="share"?"https://example.com/reference\n\n备注：周五开会前再看这份资料。":"周五确认交付范围，补充测试设备清单。\n先记在手机，回电脑后继续整理。"};
    if(scene==="draft") { state.draft=readDraft()||state.draft; state.result={title:"发现未完成的草稿",detail:"上次的内容已恢复，可以继续写。"}; }
    if(scene==="saveerror") { state.failSave=true; state.result={title:"笔记尚未保存",detail:"手机存储空间不足。输入仍在，请腾出空间后重试。",tone:"error"}; }
    if(scene==="conflict") { state.conflict=true; state.draft.title="项目会议记录 · 客户交付"; state.result={title:"这篇笔记已有新版本",detail:"手机修改尚未覆盖原笔记。保留两份内容后再决定。",tone:"error"}; }
    if(scene==="deleted") { state.deleted=true; state.result={title:"这篇笔记已被删除",detail:"手机上的修改仍保留，可以另存为新笔记。",tone:"error"}; }
    if(scene==="share") state.result={title:"来自系统分享",detail:"先核对内容，再保存到手机。链接网页不会自动下载。"};
    if(scene==="duplicate") state.result={title:"手机已有相同内容",detail:"请核对已有笔记。仍然需要新副本时，可主动保存。"};
    if(scene==="saved") saveNote();
  }
  if(scene==="revoked") { state.authorized=false; state.result={title:"电脑已撤销同步授权",detail:"后续同步已停止。手机已有资料与新记录仍然保留。",tone:"error"}; }
  if(scene==="link") state.modal="link";
  if(scene==="broken") state.modal="broken";
  render();
}
function filteredNotes() { const matches=notes.filter(n=>(state.scene!=="local"||n.id.startsWith("capture"))&&(!state.folder||n.folder===state.folder)&&(!state.tag||n.tag===state.tag)&&(state.view!=="common"||n.common)&&(!state.query||`${n.title} ${n.excerpt} ${n.body||""}`.includes(state.query))); return state.view==="recent"&&!state.query?matches.filter(n=>recentIds.includes(n.id)).sort((a,b)=>recentIds.indexOf(a.id)-recentIds.indexOf(b.id)):matches; }
function highlighted(text) { const safe=esc(text); const q=esc(state.query); return q?safe.split(q).join(`<mark>${q}</mark>`):safe; }
function resultMarkup(result) { return result?notice(esc(result.title),esc(result.detail),result.tone||"",state.failSave?"storage":"",state.failSave?"查看恢复方式":""):""; }
function renderList() {
  const matches=filteredNotes(); let body="";
  if(state.scene==="loaderror") body=`<div class="empty"><h3>笔记暂时无法读取</h3><p>本机读取遇到问题，重试不会删除内容。</p>${button("retry-list","重新读取",null,"primary")}</div>`;
  else if(!state.authorized && state.scene==="welcome") body=`<div class="empty"><h3>把资料带在身边</h3><p>允许知识库同步后，可在手机查阅电脑资料。也可以先记一条本机笔记。</p>${button("authorize","连接知识库",null,"primary")}${button("new","先记一条")}</div>`;
  else if(!matches.length) body=`<div class="empty"><h3>${state.query?"没有找到匹配笔记":"这里还没有笔记"}</h3><p>${state.query?"换一个关键词，或清除当前筛选。":"先记一条本机笔记，或连接知识库取得资料。"}</p>${button(state.query||state.folder||state.tag?"clear-search":"new",state.query||state.folder||state.tag?"清除关键词与筛选":"先记一条",null,"secondary")}</div>`;
  else body=`<div class="note-list">${matches.map(n=>`<button class="note-row" data-action="open" data-id="${n.id}" data-selected="${state.page==="reader"&&state.active===n.id}"><strong>${highlighted(n.title)}</strong><p>${highlighted(n.excerpt)}</p><span class="meta">${esc(n.folder)} · ${esc(n.time)}${n.id.startsWith("capture")?" · 等待同步":""}</span></button>`).join("")}</div>`;
  const first=state.scene==="first"?notice("首次同步进行中","已取得部分文字，剩余资料仍在同步。图片完成后才能完整离线查看。","","cancel-sync","取消本次同步"):"";
  const partial=state.scene==="partial"?notice("文字已同步，1张图片未能取得","已有资料可以阅读。打开同步详情查看缺失内容。","","sync","查看详情"):"";
  const draft=readDraft();
  if(state.scene==="shareerror") body=`<div class="empty"><h3>分享内容暂时无法读取</h3><p>来源 App 的临时内容可能已过期。请返回来源 App 重新分享，手机已有笔记仍保留。</p>${button("retry-share","模拟重新分享",null,"primary")}${button("retry-list","返回知识库")}</div>`;
  return `<section class="page index"><header class="head"><h2>知识库</h2>${button("new","新建","plus")}</header><div class="scroll" id="list-scroll">
    <label class="query">${icon("search")}<input id="search" type="search" aria-label="搜索笔记与资料" placeholder="搜索笔记与资料" value="${esc(state.query)}"></label>
    <div class="list-controls"><div class="views" role="tablist" aria-label="笔记视图">${[ ["recent","最近"],["common","常用"],["all","全部"] ].map(([id,label])=>`<button role="tab" class="view" aria-selected="${state.view===id}" data-action="view" data-id="${id}">${label}</button>`).join("")}</div>${button("filter","筛选","filter")}</div>
    ${state.folder||state.tag?`<div class="filter-chip">${esc([state.folder,state.tag].filter(Boolean).join(" · "))}${button("clear-filter","清除筛选","close")}</div>`:""}
    ${first}${partial}${resultMarkup(state.result)}${draft&&state.scene!=="welcome"?notice("有一份未完成草稿",esc(draft.title||"未命名记录"),"","resume","继续写"):""}
    <div class="result-meta"><span>${state.query?`在手机已有内容中找到 ${matches.length} 篇`:(state.view==="common"?"仅此手机的常用资料":"手机已有资料")}</span></div>${body}
    <div class="sync-line">${button("sync",state.scene==="first"?"首次同步尚未完成":state.online?(state.authorized?"上次成功同步 · 今天 08:42":"同步未开启"):"电脑离线 · 资料仍可阅读",state.online?"check":"offline")}</div>
  </div></section>`;
}
function guideContent(n) {
  if(n.body) return `<p>${esc(n.body).replace(/\n/g,"<br>")}</p>`;
  if(n.id==="meeting"||n.id==="decision") return `<p>这次会议重点确认交付范围。先把决定与待核对事项分开，避免遗漏。</p><h2 id="decisions">已经确认</h2><ul><li>第一批交付查阅与搜索。</li><li>记录可以离线保存，恢复连接后再同步。</li><li>重要资料需要核对文字与图片是否齐全。</li></ul><h2 id="followup">下一步</h2><p>周五前核对测试设备与交付清单。相关资料见 <a href="#related" data-action="open" data-id="guide">《电脑远程连接检查清单》</a>。</p><div class="table-scroll"><table><thead><tr><th>事项</th><th>负责人</th><th>完成条件</th></tr></thead><tbody><tr><td>查阅测试</td><td>项目组</td><td>断网可阅读已保存正文</td></tr><tr><td>同步核对</td><td>实施组</td><td>电脑与手机内容一致</td></tr></tbody></table></div>`;
  if(n.id==="network") return `<p>这是办公室网络的检查记录。更换环境前先核对连接方式，不要直接套用旧配置。</p><h2 id="decisions">连接检查</h2><p>确认设备已经联网，再检查电脑是否允许连接。</p>${state.missing?notice("这张图片尚未保存到手机","正文仍可阅读。电脑上线后，可再次尝试同步。","","retry-image","重试取得图片"):notice("图片已保存到手机","示例资料中的截图已完整取得。")}<h2 id="followup">后续记录</h2><p>如果设备网络发生变化，把新的配置另存一份，保留原记录供核对。</p>`;
  return `<p>出门在外，也能按这份清单核对电脑连接。先从简单步骤检查，避免重复操作。</p><h2 id="decisions">连接之前</h2><ul><li>确认电脑开机并联网。</li><li>核对当前设备与连接授权。</li><li>先看画面，再选择适合的操作方式。</li></ul><h2 id="followup">遇到问题</h2><p>画面未出现时，查看连接状态。网络变化后重试，不需要反复添加同一台电脑。</p><div class="block-code"><div class="code-head"><span>检查命令 · PowerShell</span>${button("copy-code","复制","copy")}</div><pre><code>Get-NetConnectionProfile\nTest-NetConnection -ComputerName example.com</code></pre></div><p>更多记录见 <a href="#related" data-action="link">《项目会议记录》</a>。正文中的资料链接不会自动发送到其他设备。</p>`;
}
function renderReader() {
  const n=notes.find(n=>n.id===state.active)||notes[0];
  return `<section class="page reader"><header class="head">${button("back","","back","action icon-btn",'aria-label="返回笔记列表"')}<h2 class="read-title">${esc(n.title)}</h2>${button("more","更多","more")}</header><div class="scroll article" id="reader-scroll">
    ${resultMarkup(state.readResult)}${!state.online?notice("正在阅读手机已有版本","电脑目前离线。最后成功同步于今天08:42，内容可能不是最新。",""):""}
    <div class="meta">${esc(n.folder)} · ${esc(n.time)}</div><h1>${esc(n.title)}</h1>${guideContent(n)}<p class="meta">正文结束</p>
    </div><footer class="read-footer">${button("common",n.common?"已加入常用":"加入常用","star")}${button("toc","目录","list")}</footer></section>`;
}
function renderEditor() {
  const d=state.draft; const label=state.conflict||state.deleted?"保留这份修改":(state.scene==="share"?"收集内容":"新建笔记");
  return `<section class="page editor"><header class="head">${button("editor-back","","back","action icon-btn",'aria-label="返回并保留草稿"')}<h2>${label}</h2>${button("preview","预览")}</header><div class="scroll" id="editor-scroll">${resultMarkup(state.result)}
    <label for="title">标题（可后填）</label><input id="title" placeholder="用一句话记住它" value="${esc(d.title)}">
    <label for="body">内容</label><textarea id="body" placeholder="记下需要保留的内容…">${esc(d.body)}</textarea>
    <p class="draft-status" id="draft-status" role="status">${d.body?"草稿内容已保留":"保存后可在手机查阅，电脑离线也能记。"}</p>
    <p class="meta">保存到未分类，稍后可在电脑整理。</p>${state.scene==="duplicate"?button("show-duplicate","查看已有笔记"):""}
    </div><footer class="editor-footer">${button(state.conflict?"review-conflict":"save",state.conflict?"查看两个版本":state.deleted?"另存为新笔记":state.failSave?"重试保存":"保存到手机",null,"primary")}</footer></section>`;
}
function renderOther() {
  const label={devices:"设备",files:"文件",settings:"设置"}[state.tab];
  return `<section class="page"><header class="head"><h2>${label}</h2></header><div class="scroll"><div class="empty"><h3>本稿聚焦知识库</h3><p>${label}沿用已确认的手机B界面，返回知识库继续体验。</p>${button("knowledge","返回知识库",null,"primary")}</div></div></section>`;
}
function render() {
  const focus=document.activeElement, focusId=focus?.id, selection=focus?.selectionStart;
  const scrolls={}; ["list-scroll","reader-scroll","editor-scroll"].forEach(id=>{ const el=$(`#${id}`); if(el) scrolls[id]=el.scrollTop; });
  const split=$("#size").value==="tablet"&&$("#font").value!=="2"&&!$("#keyboard").checked&&state.page==="reader";
  $("#screen").innerHTML=state.tab!=="knowledge"?renderOther():split?`<div class="workspace">${renderList()}${renderReader()}</div>`:state.page==="home"?renderList():state.page==="reader"?renderReader():renderEditor();
  $("#nav").innerHTML=[["devices","设备","monitor"],["files","文件","folder"],["knowledge","知识库","book"],["settings","设置","settings"]].map(([id,label,glyph])=>`<button data-action="nav" data-id="${id}" ${state.tab===id?'aria-current="page"':""}>${icon(glyph)}<span>${label}</span></button>`).join("");
  for(const [id,top] of Object.entries(scrolls)) if($(`#${id}`)) $(`#${id}`).scrollTop=top;
  if(state.page==="home"&&!Object.hasOwn(scrolls,"list-scroll")&&$("#list-scroll")) $("#list-scroll").scrollTop=state.scroll;
  if(focusId&&$(`#${focusId}`)&&focusId!=="scenario") { const next=$(`#${focusId}`); next.focus({preventScroll:true}); if(selection!=null&&next.setSelectionRange) {try {next.setSelectionRange(selection,selection);} catch {}} }
  $("#scenario").value=state.scene; $("#explanation").textContent=explanations[state.scene];
  $("#caption").textContent=`${["conflict","deleted","share","shareerror","duplicate","link","broken"].includes(state.scene)?"后续批次":"首版"} · ${$("#scenario").selectedOptions[0]?.textContent||"知识库"}`;
  renderModal();
}
function showModal(name) { modalOrigin=document.activeElement?.dataset.action||null; state.modal=name; renderModal(); const el=$("#overlay button"); el?.focus(); }
function closeModal() { state.modal=null; renderModal(); if(modalOrigin) document.querySelector(`[data-action="${modalOrigin}"]`)?.focus({preventScroll:true}); }
function renderModal() {
  $("#screen").inert=Boolean(state.modal); $("#nav").inert=Boolean(state.modal);
  const host=$("#overlay"); if(!state.modal){host.hidden=true;host.innerHTML="";return;} host.hidden=false;
  const name=state.modal; let title="",body="";
  const n=notes.find(n=>n.id===state.active)||notes[0];
  if(name==="filter") {title="筛选资料";body=`<label for="filter-folder">文件夹</label><select id="filter-folder">${["","工作笔记","项目资料","个人资料"].map(v=>`<option value="${v}" ${state.folder===v?"selected":""}>${v||"全部文件夹"}</option>`).join("")}</select><label for="filter-tag">标签</label><select id="filter-tag">${["","指南","会议","配置","清单"].map(v=>`<option value="${v}" ${state.tag===v?"selected":""}>${v||"全部标签"}</option>`).join("")}</select><div class="actions">${button("clear-filter","清除筛选",null,"secondary")}${button("apply-filter","显示结果",null,"primary")}</div>`;}
  if(name==="more") {title="笔记操作";body=`${button("copy-note","复制正文","copy","menu-row")}${button("share-out","分享笔记","book","menu-row")}${button("common",n.common?"移出手机常用":"加入手机常用","star","menu-row")}<p>常用只影响这台手机，不改变电脑置顶。</p>`;}
  if(name==="toc") {title="文章目录";body=`${button("heading","连接之前 / 已经确认",null,"menu-row",'data-id="decisions"')}${button("heading","后续记录 / 下一步",null,"menu-row",'data-id="followup"')}`;}
  if(name==="sync") {title="知识库同步";body=notice(state.authorized?(state.online?"上次成功同步 · 今天08:42":"电脑暂时离线"):"同步未开启",state.authorized?"手机已有资料可以阅读。新记录与缺失图片的同步状态，请分别核对。":"手机已有内容仍可查阅。允许同步需要独立授权。")+(state.scene==="partial"?notice("1张图片未能同步","《办公室网络配置》正文已取得，图片缺失。","error"):"")+`<p>同步电脑：LAPTOP-LZL<br>范围：整个当前知识库</p>${button(state.authorized?"retry-sync":"authorize",state.authorized?"重试同步":"重新连接知识库",null,"primary")}`;}
  if(name==="authorize") {title="允许知识库同步？";body=`<p>设备：LAPTOP-LZL<br>范围：整个当前知识库</p><p>笔记正文与支持的图片将保存到这台手机。此版本不提供按文件夹授权。远程连接权限与知识库同步是独立的。</p>${notice("同步前先核对范围","本次将同步5篇笔记、1张图片。请确认愿意将这些内容保存到手机。")}${button("allow-sync","同意并开始同步",null,"primary")}${button("close-modal","暂时不用")}`;}
  if(name==="link") {title="选择要打开的笔记";body=`<p>“项目会议记录”有多个匹配，请核对文件夹与标题。</p>${notes.filter(v=>v.tag==="会议").map(v=>button("open",`${esc(v.title)}<br><span class="meta">${esc(v.folder)}</span>`,null,"menu-row",`data-id="${v.id}"`)).join("")}`;}
  if(name==="broken") {title="相关笔记暂不可用";body=`<p>这篇笔记可能已删除或尚未同步到手机。当前资料仍保留，可以继续阅读。</p>${button("close-modal","返回当前资料",null,"primary")}`;}
  if(name==="preview") {title="记录预览";body=`<h4>${esc(state.draft.title||state.draft.body.split("\n")[0]||"未命名记录")}</h4><p>${esc(state.draft.body).replace(/\n/g,"<br>")||"还没有正文"}</p>${button("close-modal","继续写",null,"primary")}`;}
  if(name==="storage") {title="笔记尚未保存";body=`<p>手机空间不足，输入仍保留。腾出空间后可重试。</p>${button("storage-fixed","模拟空间已恢复",null,"primary")}${button("close-modal","返回保留内容")}`;}
  if(name==="conflict") {title="保留两份内容";body=`<p>原笔记有新版本，手机草稿不会直接覆盖它。</p><h4>手机修改</h4><p>${esc(state.draft.body)}</p><h4>电脑当前版本</h4><p>周五核对交付范围，新增图片往返测试。保留原项目记录。</p>${button("save-copy","手机修改另存一篇",null,"primary")}${button("close-modal","稍后在电脑比较")}`;}
  if(name==="share-out") {title="分享笔记";body=`<p>将打开系统分享面板。选择目标 App 后，发送结果由那个 App 展示。</p>${button("open-share","打开系统分享",null,"primary")}`;}
  if(name==="resume-choice") {title="先处理未完成的草稿";body=`<p>已有一份草稿。继续编辑可保留当前内容，或明确放弃后新建。</p>${button("resume","继续已有草稿",null,"primary")}${button("replace-draft","放弃草稿并新建",null,"secondary")}`;}
  if(name==="duplicate") {title="已有内容预览";body=`<h4>客户交付备忘</h4><p>周五确认交付范围，补充测试设备清单。先记在手机，回电脑后继续整理。</p><p>这份内容与本次分享相同。此处只核对已有笔记，不创建副本。</p>${button("close-modal","返回分享内容",null,"primary")}`;}
  host.innerHTML=`<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="sheet-header"><h3 id="modal-title">${title}</h3>${button("close-modal","关闭","close")}</header><div class="sheet-body">${body}</div></section>`;
}
function saveNote(copy=false) {
  if(!state.draft) return;
  clearTimeout(draftTimer);
  if(state.failSave) {storeDraft();state.result={title:"笔记尚未保存",detail:"手机存储空间不足，输入仍保留。恢复空间后请重试。",tone:"error"};render();return;}
  if(!state.draft.body.trim()) {state.result={title:"先记一点内容",detail:"正文为空，还没有可保存的内容。",tone:"error"};render();return;}
  if(copy) state.draft.id=`capture-${++savedCounter}`;
  const d=state.draft, title=d.title.trim()||d.body.trim().split("\n")[0].slice(0,32);
  if(!notes.some(n=>n.id===d.id)) notes.unshift({id:d.id,title,body:d.body,folder:"未分类",tag:"",time:"刚刚",excerpt:d.body.slice(0,120),common:false});
  state.savedId=d.id;state.active=d.id;state.page="reader";state.modal=null;state.conflict=false;state.deleted=false;state.result=null;
  recentIds=[d.id,...recentIds.filter(id=>id!==d.id)];
  state.readResult={title:"已保存到手机",detail:"电脑同步尚未完成。可以继续使用，稍后核对同步结果。",tone:"success"};removeDraft();state.draft=null;render();
}
document.addEventListener("input",e=>{
  if(e.target.id==="search") {state.query=e.target.value;state.scroll=0;render();$("#search")?.focus();return;}
  if(["title","body"].includes(e.target.id)&&state.draft) {state.draft[e.target.id]=e.target.value;$("#draft-status").textContent="正在保留草稿…";clearTimeout(draftTimer);draftTimer=setTimeout(()=>{const ok=storeDraft();if($("#draft-status")) $("#draft-status").textContent=ok?"草稿内容已保留":"预览暂存失败，输入仍在。";},300);}
});
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-action]");if(!b)return;e.preventDefault(); const a=b.dataset.action;
  if(a==="close-modal") {closeModal();return;}
  if(["filter","more","toc","sync","authorize","link","broken","preview","storage","share-out"].includes(a)) {showModal(a);return;}
  if(a==="open") {state.scroll=$("#list-scroll")?.scrollTop??state.scroll; if($("#reader-scroll")) readingPositions.set(state.active,$("#reader-scroll").scrollTop);state.active=b.dataset.id;recentIds=[state.active,...recentIds.filter(id=>id!==state.active)];state.page="reader";state.modal=null;state.readResult=null;render();if($("#reader-scroll"))$("#reader-scroll").scrollTop=readingPositions.get(state.active)||0;return;}
  if(a==="back") {readingPositions.set(state.active,$("#reader-scroll")?.scrollTop||0);state.page="home";state.readResult=null;state.result=null;render();return;}
  if(a==="new") {if(readDraft()){showModal("resume-choice");return;}createDraft();state.page="editor";render();return;}
  if(a==="replace-draft") {removeDraft();state.modal=null;createDraft();state.page="editor";render();return;}
  if(a==="resume") {state.modal=null;state.draft=readDraft();state.page="editor";state.result={title:"草稿已恢复",detail:"可以继续编辑，保存后生成独立笔记。"};render();return;}
  if(a==="editor-back") {if(state.draft)storeDraft();clearTimeout(draftTimer);state.page="home";state.result=null;render();return;}
  if(a==="save") {if(state.conflict){showModal("conflict");return;}saveNote();return;}
  if(a==="save-copy") {saveNote(true);return;}
  if(a==="review-conflict") {showModal("conflict");return;}
  if(a==="view") {state.view=b.dataset.id;state.scroll=0;render();return;}
  if(a==="clear-search") {state.query="";state.folder="";state.tag="";state.view="all";render();return;}
  if(a==="clear-filter") {state.folder="";state.tag="";state.modal=null;render();return;}
  if(a==="apply-filter") {state.folder=$("#filter-folder").value;state.tag=$("#filter-tag").value;state.modal=null;state.scroll=0;render();return;}
  if(a==="common") {const n=notes.find(n=>n.id===state.active);n.common=!n.common;state.modal=null;state.readResult={title:n.common?"已加入手机常用":"已移出手机常用",detail:"仅影响这台手机，电脑置顶保持原样。",tone:"success"};render();return;}
  if(a==="copy-code"||a==="copy-note") {state.modal=null;state.readResult={title:a==="copy-code"?"已复制代码":"已复制正文",detail:"复制反馈显示在当前资料中。",tone:"success"};render();return;}
  if(a==="open-share") {state.modal=null;state.readResult={title:"已打开系统分享",detail:"是否发送成功，请查看目标App的结果。"};render();return;}
  if(a==="heading") {state.modal=null;renderModal();$(`#${b.dataset.id}`)?.scrollIntoView({block:"start"});return;}
  if(a==="retry-list") {state.scene="home";render();return;}
  if(a==="retry-share") {chooseScene("share");return;}
  if(a==="show-duplicate") {showModal("duplicate");return;}
  if(a==="cancel-sync") {state.scene="home";state.result={title:"已取消本次同步",detail:"已经取得的资料仍可阅读。稍后可继续同步。"};render();return;}
  if(a==="allow-sync") {state.authorized=true;state.scene="first";state.modal=null;state.page="home";render();return;}
  if(a==="retry-sync") {state.modal=null;state.result={title:"本次同步尚未完成",detail:"文字已取得，1张图片仍缺失。请在电脑在线时重试。"};state.scene="partial";render();return;}
  if(a==="retry-image") {state.readResult={title:"图片仍未取得",detail:"请确认电脑在线。正文可继续阅读。",tone:"error"};render();return;}
  if(a==="storage-fixed") {state.failSave=false;state.modal=null;state.result={title:"可以重试保存",detail:"输入未变化，点击保存到手机继续。"};render();return;}
  if(a==="hide-keyboard") {$("#keyboard").checked=false;updateDevice();return;}
  if(a==="nav"||a==="knowledge") {if(state.page==="editor"&&state.draft)storeDraft();state.tab=a==="knowledge"?"knowledge":b.dataset.id;state.page="home";state.result=null;state.modal=null;render();}
});
// Escape and Tab follow the same modal focus rules as the mobile shell.
document.addEventListener("keydown",e=>{if(!state.modal)return; if(e.key==="Escape"){e.preventDefault();closeModal();} if(e.key==="Tab"){const items=[...$("#overlay").querySelectorAll("button,select,input,a[href]")];const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
$("#overlay").addEventListener("click",e=>{if(e.target===$("#overlay"))closeModal();});
function updateDevice(){const d=$("#device");d.dataset.size=$("#size").value;d.dataset.font=$("#font").value==="2"?"huge":$("#font").value==="1.3"?"large":"standard";d.dataset.dark=String($("#dark").checked);d.dataset.keyboard=String($("#keyboard").checked);document.body.dataset.reduced=String($("#reduced").checked);$("#ime").hidden=!$("#keyboard").checked;render();}
for(const id of ["size","font","dark","reduced","keyboard"]) $(`#${id}`).addEventListener("change",updateDevice);
$("#scenario").addEventListener("change",()=>chooseScene($("#scenario").value));
$("#reset").addEventListener("click",()=>{removeDraft();notes=baseNotes.map(n=>({...n}));recentIds=["guide","meeting","network"];readingPositions.clear();savedCounter=0;state.draft=null;$("#font").value="1";for(const id of ["dark","reduced","keyboard"]) $(`#${id}`).checked=false;chooseScene("home");updateDevice();});
chooseScene("home");
