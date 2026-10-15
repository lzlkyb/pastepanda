import { layout, equilibrium, springProgress, springImpulse, sample, restoreSnapshot, clamp, defaultAnchors, constrainAnchors, moveAnchors, ropePoint, canSettle, insertAtSlot } from './physics.mjs';
import { createEffects } from './effects.mjs';
import { installGestures } from './gestures.mjs';

const $ = id => document.getElementById(id);
const systemReduce = matchMedia('(prefers-reduced-motion: reduce)');
const state = { width:1440, items:[], pins:[], uid:0, enabled:true, wind:true, full:false, locked:false, anchors:defaultAnchors(1440), custom:false, clearingIds:new Set(), pendingHangs:new Set() };
const urls = new Set(), cards = new Map(), storageKey = 'pastepanda-clothesline-anchors-r2';
let geometry, target, curve, frame=0, motion=null, windTimer=0, gestures, dragging=false;
let hovered=false, focused=false, previewId=null, returnFocus=null, clearOperation=null;
let undoAction=null, undoTimer=0, toastTimer=0, undoDeadline=0, undoRemaining=0, undoPaused=false, assetGeneration=0;
const reduced = () => systemReduce.matches || $('reduce').checked;
const blocked = () => dragging || hovered || focused || previewId!==null || !!clearOperation;
const available = () => state.enabled && !document.hidden && state.items.length>0 && !reduced();
const effects = createEffects({stage:$('stage'),layer:$('fxLayer'),reduced});
const titles = ['Q4 定价讨论','页面布局参考','交互验收清单','版本数据','产品讨论记录'];

function makeItem(url=null,aspect=1.6,name=null) {
  const id=++state.uid;
  return {id,aspect,url,name:name||titles[(id-1)%titles.length],weight:1};
}
function photo(item) {
  const box=document.createElement('div');box.className='photo';
  if(item.url){const img=document.createElement('img');img.src=item.url;img.alt=item.name;box.append(img);}
  else {
    const content=document.createElement('div');content.className='sample';
    const bar=document.createElement('div');bar.className='sampleBar';bar.textContent='PastePanda · 演示图片';
    const title=document.createElement('strong');title.textContent=item.name;
    const text=document.createElement('p');text.textContent=item.id%2?'把三个档位的价格再核一遍，特别是年付折后价。':'拖近绳子挂回，沿绳拖动调整顺序。';
    content.append(bar,title,text);
    if(!(item.id%2)){
      const bars=document.createElement('div');bars.className='sampleLines';
      [40,72,52,96].forEach(height=>{const b=document.createElement('i');b.style.setProperty('--bar',height+'%');bars.append(b);});content.append(bars);
    }
    box.append(content);
  }
  return box;
}
function resize() {
  const zoom=state.full?1:Math.min(1,$('viewport').clientWidth/state.width);
  $('stage').style.setProperty('--sw',state.width+'px');$('stage').style.setProperty('--zoom',zoom);
  $('stageWrap').style.width=state.width*zoom+'px';$('stageWrap').style.height=760*zoom+'px';
}
function saveAnchors() {
  try {
    if(!state.custom){localStorage.removeItem(storageKey);return;}
    localStorage.setItem(storageKey,JSON.stringify({left:{x:state.anchors.left.x/state.width,y:state.anchors.left.y/760},right:{x:state.anchors.right.x/state.width,y:state.anchors.right.y/760}}));
  } catch { toast('本浏览器未能保存位置，本次摆放仍保留'); }
}
function readAnchors() {
  try {
    const saved=JSON.parse(localStorage.getItem(storageKey));
    if(!saved||!['left','right'].every(side=>Number.isFinite(saved[side]?.x)&&Number.isFinite(saved[side]?.y)))return;
    const next={left:{x:saved.left.x*state.width,y:saved.left.y*760},right:{x:saved.right.x*state.width,y:saved.right.y*760}};
    if(next.right.x-next.left.x<240)return;
    state.anchors=constrainAnchors(constrainAnchors(next,'right',state.width),'left',state.width);state.custom=true;
  } catch { /* 损坏的预览位置不应阻止默认绳子显示。 */ }
}
function renderCards() {
  const ids=new Set(geometry.cards.map(c=>c.item.id));
  for(const [id,el] of cards)if(!ids.has(id)){el.remove();cards.delete(id);}
  for(const card of geometry.cards){
    let el=cards.get(card.item.id);
    if(!el){
      el=document.createElement('div');el.className='hang';el.dataset.id=card.item.id;el.tabIndex=0;
      el.setAttribute('role','group');el.setAttribute('aria-label','查看 '+card.item.name+'，Enter 打开预览');
      const paper=document.createElement('div');paper.className='frame';paper.append(photo(card.item));
      const caption=document.createElement('span');caption.className='caption';caption.textContent='已保存 · '+card.item.name;
      const take=document.createElement('button');take.className='takeOne';take.textContent='取下为贴图';take.onclick=()=>takeItem(card.item.id);
      paper.append(caption,take);el.append(paper);$('hangs').append(el);cards.set(card.item.id,el);
      if(!reduced()&&!state.pendingHangs.has(card.item.id)&&!state.clearingIds.has(card.item.id))paper.animate([{opacity:0,transform:'translateY(-24px)'},{opacity:1,transform:'translateY(0)'}],{duration:300,easing:'cubic-bezier(.05,.7,.1,1)'});
    }
    el.style.setProperty('--iw',card.iw+'px');el.style.setProperty('--ih',card.ih+'px');
    el.style.visibility=state.clearingIds.has(card.item.id)||state.pendingHangs.has(card.item.id)?'hidden':'visible';
    const count=card.iw>=150?2:1;
    if(el.querySelectorAll('.clip').length!==count){el.querySelectorAll('.clip').forEach(c=>c.remove());for(let i=0;i<count;i++){const clip=document.createElement('span');clip.className='clip';el.prepend(clip);}}
  }
  $('emptyRope').hidden=state.items.length>0||!!clearOperation;
  $('ropeLayer').hidden=!state.enabled;
  $('gather').disabled=!state.enabled||!state.items.length||!!clearOperation||!!state.pendingHangs.size;
  $('clear').disabled=!state.enabled||!state.items.length||!!clearOperation||!!state.pendingHangs.size;
  $('breeze').disabled=!available()||!!clearOperation;
  $('restoreAnchors').disabled=state.locked||!!clearOperation;
  for(const id of ['anchorLeft','anchorRight','moveRope'])$(id).disabled=state.locked||!!clearOperation;
  $('stageStatus').textContent=!state.enabled?'晾衣绳已关闭 · 原有采集照旧':clearOperation?'大风正在吹走 · 可随时撤销':state.items.length+' 张照片 · 拖离取下 / 拖回挂上';
  $('countValue').textContent=geometry.cards.length+' / '+geometry.queued;
  $('sagValue').textContent=Math.max(...target).toFixed(1)+'px';
  $('anchorValue').textContent=['left','right'].map(side=>`(${Math.round(state.anchors[side].x)}, ${Math.round(state.anchors[side].y)})`).join(' → ');
  $('queue').replaceChildren();
  for(const item of state.items.filter(item=>!ids.has(item.id)&&!state.clearingIds.has(item.id))){const b=document.createElement('button');b.textContent='排队 · '+item.name+' → 转贴图';b.onclick=()=>takeItem(item.id);$('queue').append(b);}
}
function draw(values,windAngle=0) {
  curve=values;
  $('ropePath').setAttribute('d',values.map((_,i)=>{const p=ropePoint(geometry,values,i/64);return `${i?'L':'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;}).join(' '));
  for(const [id,side] of [['anchorLeft','left'],['anchorRight','right']]){const p=state.anchors[side];$(id).style.left=p.x-16+'px';$(id).style.top=p.y-16+'px';}
  const middle=ropePoint(geometry,values,.5);$('moveRope').style.left=middle.x-48+'px';$('moveRope').style.top=Math.max(2,middle.y-29)+'px';
  for(const card of geometry.cards){
    const el=cards.get(card.item.id);if(!el||gestures?.draggedId()===card.item.id)continue;
    const t=(card.x-geometry.left)/geometry.span,p=ropePoint(geometry,values,t);
    el.style.left=card.x+'px';el.style.top=p.y+'px';
    const clips=[...el.querySelectorAll('.clip')];
    clips.forEach((clip,i)=>{
      const fraction=clips.length===1?.5:i?.74:.26,ct=(card.x+(fraction-.5)*card.width-geometry.left)/geometry.span;
      const y=ropePoint(geometry,values,ct).y,slope=(ropePoint(geometry,values,ct+.002).y-ropePoint(geometry,values,ct-.002).y)/(.004*geometry.span);
      clip.style.left=fraction*100+'%';clip.style.top=y-p.y-5+'px';clip.style.setProperty('--tilt',Math.atan(slope)*180/Math.PI+'deg');
    });
    el.style.setProperty('--angle',clamp((sample(values,t)-sample(target,t))*-.5+windAngle*Math.sin(Math.PI*t),-5,5)+'deg');
  }
}
function stop(){cancelAnimationFrame(frame);frame=0;motion=null;$('motionValue').textContent='休眠 · 无逐帧更新';}
function scheduleWind(){
  clearTimeout(windTimer);windTimer=0;
  if(available()&&state.wind&&!blocked())windTimer=setTimeout(gust,20000+Math.random()*25000);
  $('windStatus').textContent=!state.enabled?'风已停止':reduced()?'减少动态 · 静态反馈':blocked()?'互动中 · 微风暂停':state.wind?'偶发微风 · 20–45 秒':'微风已关闭';
}
function animate(now){
  if(!motion||!state.enabled||document.hidden){stop();return;}
  const seconds=(now-motion.start)/1000;
  if(motion.kind==='spring'){
    if(seconds>=1.2){draw(target);stop();scheduleWind();return;}
    const progress=springProgress(seconds),impulse=springImpulse(seconds,motion.kick);
    draw(target.map((y,i)=>motion.from[i]+(y-motion.from[i])*progress+impulse*Math.sin(Math.PI*i/64)));
  }else{
    if(seconds>=2.4||blocked()||reduced()){draw(target);stop();scheduleWind();return;}
    const envelope=Math.sin(Math.PI*seconds/2.4)**2;
    draw(target.map((y,i)=>y+3*envelope*Math.sin(Math.PI*i/64)*Math.sin(seconds*3+i/64)*motion.direction),2*envelope*Math.sin(seconds*3)*motion.direction);
  }
  frame=requestAnimationFrame(animate);
}
function settle(kick=0){
  stop();clearTimeout(windTimer);
  if(!canSettle({enabled:state.enabled,hidden:document.hidden,reduced:reduced(),dragging,preview:previewId!==null})){draw(target);scheduleWind();return;}
  motion={kind:'spring',from:[...curve],start:performance.now(),kick};$('motionValue').textContent='弹簧响应 · k130 / c16';frame=requestAnimationFrame(animate);
}
function update(kick=0,instant=false){
  geometry=layout(state.width,state.items,state.anchors);target=equilibrium(geometry);curve||=[...target];renderCards();draw(instant?target:curve);
  if(instant||reduced()||!state.enabled){stop();draw(target);scheduleWind();}else settle(kick);
}
function gust(){
  clearTimeout(windTimer);
  if(!available()||blocked()){scheduleWind();return;}
  stop();draw(target);motion={kind:'wind',start:performance.now(),direction:Math.random()<.5?-1:1};
  $('motionValue').textContent='短阵风 · 2.4 秒';$('windStatus').textContent='一阵轻风经过';frame=requestAnimationFrame(animate);
}
function interactionChanged(){
  if(dragging||previewId!==null){stop();}
  else if(blocked()&&motion?.kind==='wind'){stop();draw(target);}
  scheduleWind();
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},4000);}
function tickUndo(){
  clearTimeout(undoTimer);if(undoPaused)return;
  const seconds=Math.max(0,(undoDeadline-performance.now())/1000);$('undoTime').textContent=Math.ceil(seconds)+'s';
  if(!seconds){undoAction=null;$('undoBar').hidden=true;return;}undoTimer=setTimeout(tickUndo,200);
}
function setUndo(message,run,kind='add'){
  clearTimeout(undoTimer);undoAction={run,kind};undoPaused=false;undoDeadline=performance.now()+8000;
  $('undoText').textContent=message;$('undoBar').hidden=false;tickUndo();
}
$('undo').onclick=()=>{const action=undoAction;undoAction=null;clearTimeout(undoTimer);$('undoBar').hidden=true;if(action)action.run();};
function pauseUndo(){if(undoAction&&!undoPaused){undoPaused=true;undoRemaining=Math.max(0,undoDeadline-performance.now());clearTimeout(undoTimer);}}
function resumeUndo(){if(undoAction&&undoPaused&&!$('undoBar').matches(':hover')&&!$('undoBar').contains(document.activeElement)){undoPaused=false;undoDeadline=performance.now()+undoRemaining;tickUndo();}}
$('undoBar').onpointerenter=pauseUndo;$('undoBar').onpointerleave=resumeUndo;
$('undoBar').onfocusin=pauseUndo;$('undoBar').onfocusout=e=>{if(!$('undoBar').contains(e.relatedTarget))resumeUndo();};
function add(item){
  if(!state.enabled){toast('晾衣绳已关闭，本张不上绳；产品原有采集照旧');return;}
  state.items.push(item);update(130);
  if(undoAction?.kind!=='clear')setUndo('已挂上「'+item.name+'」',()=>{state.items=state.items.filter(x=>x.id!==item.id);update(-90);toast('本张已从绳上移除，历史保留');});
  toast('新照片已挂上'+(geometry.queued?' · 另有 '+geometry.queued+' 张排队':''));
}
function renderPins(){
  $('pins').replaceChildren();$('pinList').replaceChildren();$('pinCount').textContent=state.pins.length+' 张';
  if(!state.pins.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='取下的照片可拖近绳子重新挂上';$('pinList').append(empty);}
  for(const pin of state.pins){
    const el=document.createElement('div');el.className='pinGhost';el.dataset.pin=pin.item.id;
    Object.assign(el.style,{left:pin.x+'px',top:pin.y+'px',width:pin.width+'px',height:pin.height+'px',visibility:pin.pending||pin.pendingBack?'hidden':'visible'});el.append(photo(pin.item));
    const close=document.createElement('button');close.className='pinClose';close.textContent='×';close.setAttribute('aria-label','关闭贴图 '+pin.item.name);
    close.onclick=()=>{effects.cancel(pin.item.id);state.pins=state.pins.filter(p=>p!==pin);renderPins();toast('贴图已关闭，历史保留');};el.append(close);$('pins').append(el);
    const row=document.createElement('div');row.className='row';const name=document.createElement('span');name.className='name';name.textContent=pin.item.name;
    const back=document.createElement('button');back.textContent=pin.pending||pin.pendingBack?'转场中…':'挂回';back.disabled=pin.pending||pin.pendingBack||!state.enabled||!!clearOperation;back.onclick=()=>hangBack(pin.item.id);
    row.append(name,back);$('pinList').append(row);
  }
}
function consumeFailure(){if(!$('failPin').checked)return false;$('failPin').checked=false;return true;}
async function takeItem(id,sourceEl=cards.get(id),dragged=false,batch=false){
  const item=state.items.find(i=>i.id===id);if(!item||state.clearingIds.has(id))return false;
  if(consumeFailure()){sourceEl?.copy?.remove();renderPins();draw(target);settle();toast('贴图创建失败，照片仍在绳上 · 可重试');return false;}
  // 必须先捕获松手位置，再改列表；否则渲染会把源照片归位。
  const captured=sourceEl?.copy?sourceEl:effects.capture(sourceEl),index=state.pins.length,order=state.items.indexOf(item);
  const width=200,height=Math.min(180,Math.round(width/item.aspect));
  const pin={item,width,height,x:clamp(dragged?captured.bounds.x:80+index%3*224,16,state.width-width-16),y:clamp(dragged?captured.bounds.y:320+Math.floor(index/3)%3*140,32,720-height),pending:true};
  state.pins.push(pin);state.items=state.items.filter(i=>i.id!==id);renderPins();update(-90);
  if(!batch)toast('夹子已松开 · 正在转为贴图');
  if(!batch)setUndo('已取下「'+item.name+'」',()=>{
    effects.cancel(id);state.pins=state.pins.filter(p=>p!==pin);if(!state.items.some(i=>i.id===id))state.items.splice(Math.min(order,state.items.length),0,item);
    renderPins();update(90);toast('已重新挂回');
  },'take');
  const completed=await effects.transfer(id,captured,$('pins').querySelector(`[data-pin="${id}"]`),'pin',dragged);
  if(completed&&state.pins.includes(pin)){pin.pending=false;renderPins();if(!batch)toast('已转为贴图 · 拖近绳子或点击「挂回」');}
  return completed;
}
async function hangBack(id,slot=geometry.cards.length,sourceEl=$('pins').querySelector(`[data-pin="${id}"]`),dragged=false){
  const pin=state.pins.find(p=>p.item.id===id);if(!pin||pin.pending||pin.pendingBack)return;
  if(!state.enabled||clearOperation){renderPins();toast('请先开启晾衣绳，或等待本阵大风结束');return;}
  if(consumeFailure()){renderPins();settle();toast('挂回失败，原贴图保留 · 可重试');return;}
  const captured=effects.capture(sourceEl),before=[...state.items];pin.pendingBack=true;
  state.pendingHangs.add(id);state.items=insertAtSlot(state.items,pin.item,slot,Math.min(8,Math.max(1,Math.floor((geometry.span+12)/126))));renderPins();update(100);
  toast('正在挂回 · 贴图接收成功后再关闭');
  setUndo('已挂回「'+pin.item.name+'」',()=>{
    effects.cancel(id);state.pendingHangs.delete(id);state.items=state.items.filter(i=>i.id!==id);pin.pendingBack=false;
    if(!state.pins.includes(pin))state.pins.push(pin);renderPins();update(-90);toast('已回到桌面贴图');
  },'back');
  const completed=await effects.transfer(id,captured,cards.get(id),'hang',dragged);
  if(completed&&state.pendingHangs.has(id)){
    state.pendingHangs.delete(id);state.pins=state.pins.filter(p=>p!==pin);renderPins();renderCards();draw(curve);
    toast('已夹住绳子，桌面贴图已移除'+(state.items.length>before.length&&geometry.queued?' · 旧图已排队':''));
  }
}
async function gather(){
  gestures.cancelDrag();closePreview(false);
  const snapshot=[...state.items],pinIds=new Set(snapshot.map(i=>i.id));
  const sources=new Map(snapshot.map(item=>[item.id,effects.capture(cards.get(item.id))]));
  const operations=snapshot.map(item=>takeItem(item.id,sources.get(item.id),false,true));
  const createdIds=new Set(state.pins.filter(p=>pinIds.has(p.item.id)).map(p=>p.item.id));
  setUndo('已收衣 '+createdIds.size+' 张 · 可放回',()=>{
    createdIds.forEach(id=>effects.cancel(id));state.pins=state.pins.filter(p=>!createdIds.has(p.item.id));
    state.items=restoreSnapshot(state.items,snapshot,8).items;renderPins();update(100);toast('本次收衣已放回绳上');
  },'gather');
  const results=await Promise.all(operations),succeeded=results.filter(Boolean).length;
  if(succeeded)toast(succeeded===snapshot.length?`已收下 ${succeeded} 张，转为桌面贴图`:`已转贴图 ${succeeded}/${snapshot.length} 张；失败照片留在绳上，可重试`);
}
async function clearRope(){
  if(!state.items.length||clearOperation)return;
  gestures.cancelDrag();closePreview(false);
  const snapshot=[...state.items],operation={ids:new Set(snapshot.map(i=>i.id))};clearOperation=operation;state.clearingIds=new Set(operation.ids);
  setUndo('正在吹走 '+snapshot.length+' 张 · 可叫停',()=>{
    operation.ids.forEach(id=>effects.cancel(id));if(clearOperation===operation)clearOperation=null;state.clearingIds.clear();
    state.items=restoreSnapshot(state.items.filter(i=>!operation.ids.has(i.id)),snapshot,8).items;
    update(100);renderPins();toast('本阵大风已撤销；之后新增的照片仍保留');
  },'clear');
  // 先冻结所有可见源，再逐张卸重；排队图不会把离场时长拉长。
  const captured=new Map(geometry.cards.map(card=>[card.item.id,reduced()?null:effects.capture(cards.get(card.item.id))]));
  let visibleIndex=0;
  const operations=snapshot.map(item=>effects.gale(item.id,captured.get(item.id),captured.has(item.id)?visibleIndex++:0,()=>{
    if(clearOperation!==operation)return;state.items=state.items.filter(i=>i.id!==item.id);update(-35);
  }));
  renderCards();scheduleWind();await Promise.all(operations);
  if(clearOperation!==operation)return;
  clearOperation=null;state.clearingIds.clear();renderCards();renderPins();scheduleWind();toast('大风吹走了本次照片，剪贴板历史保留');
  if(undoAction?.kind==='clear')$('undoText').textContent='已吹走 '+snapshot.length+' 张 · 历史保留';
}
function reorder(id,slot){
  const before=[...state.items],item=state.items.find(i=>i.id===id);if(!item)return;
  const positions=new Map([...cards].map(([key,el])=>[key,parseFloat(el.style.left)]));
  state.items=insertAtSlot(state.items,item,slot,geometry.cards.length);update(45);
  if(!reduced())for(const [key,el] of cards){const dx=(positions.get(key)??parseFloat(el.style.left))-parseFloat(el.style.left);if(dx)el.animate([{translate:dx+'px 0'},{translate:'0px 0'}],{duration:220,easing:'ease-out'});}
  setUndo('已调整照片顺序',()=>{const present=new Set(state.items.map(i=>i.id));state.items=[...before.filter(i=>present.has(i.id)),...state.items.filter(i=>!before.some(old=>old.id===i.id))];update(40);},'reorder');toast('顺序已调整');
}
function commitAnchors(before,beforeCustom=true){
  state.custom=true;saveAnchors();update(30);
  setUndo('绳位置已更新',()=>{state.anchors=before;state.custom=beforeCustom;saveAnchors();update(20);toast('已恢复上一次位置');},'position');
}
function previewSlot(id,slot){
  for(const el of cards.values()){el.style.translate='';el.style.opacity='';}
  if(id===null)return;
  const item=state.items.find(i=>i.id===id)||state.pins.find(p=>p.item.id===id)?.item;if(!item)return;
  const capacity=Math.min(8,Math.max(1,Math.floor((geometry.span+12)/126)));
  const preview=layout(state.width,insertAtSlot(state.items,item,slot,capacity),state.anchors);
  for(const card of geometry.cards){
    if(card.item.id===id)continue;const next=preview.cards.find(c=>c.item.id===card.item.id),el=cards.get(card.item.id);
    if(next)el.style.translate=next.x-card.x+'px 0';else el.style.opacity='.35';
  }
  return preview.cards.find(c=>c.item.id===id);
}
function openPreview(id){
  const item=state.items.find(x=>x.id===id);if(!item)return;
  returnFocus=document.activeElement;previewId=id;$('loupeImage').replaceChildren(photo(item));$('loupeCaption').textContent=item.name;$('loupe').hidden=false;interactionChanged();$('closePreview').focus();
}
function closePreview(focus=true){
  if(previewId===null)return;previewId=null;$('loupe').hidden=true;if(focus&&returnFocus?.isConnected)returnFocus.focus();focused=false;interactionChanged();
}
$('pinPreview').onclick=()=>{const id=previewId;closePreview(false);takeItem(id);};$('closePreview').onclick=()=>closePreview();
gestures=installGestures({stage:$('stage'),hangs:$('hangs'),pins:$('pins'),left:$('anchorLeft'),right:$('anchorRight'),mover:$('moveRope'),marker:$('slotMarker'),hint:$('dragHint'),getState:()=>state,getGeometry:()=>geometry,getCurve:()=>curve,
  onAnchors:anchors=>{state.anchors=anchors;update(0,true);},onAnchorCommit:before=>commitAnchors(before),onDetach:takeItem,onHangBack:hangBack,onReorder:reorder,onPreview:openPreview,
  onInteraction:active=>{dragging=active;interactionChanged();},onFinish:()=>{draw(target);settle();},onGeometryCancel:anchors=>{state.anchors=anchors;update(0,true);},onSlotPreview:previewSlot});
for(const [id,side] of [['anchorLeft','left'],['anchorRight','right'],['moveRope','whole']])$(id).onkeydown=e=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||state.locked||clearOperation)return;e.preventDefault();
  const step=e.shiftKey?16:4,dx=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,dy=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0;
  const before=structuredClone(state.anchors),custom=state.custom;
  if(side==='whole')state.anchors=moveAnchors(before,dx,dy,state.width);
  else{const next=structuredClone(before);next[side].x+=dx;next[side].y+=dy;state.anchors=constrainAnchors(next,side,state.width);}
  commitAnchors(before,custom);
};
$('hangs').onkeydown=e=>{if(e.target.closest('button'))return;const el=e.target.closest('.hang');if(el&&['Enter',' '].includes(e.key)){e.preventDefault();openPreview(+el.dataset.id);}};
document.onkeydown=e=>{if(e.key==='Escape'){if(gestures.isDragging())gestures.cancelDrag();else closePreview();}};
$('stage').onpointermove=e=>{const next=!!e.target.closest('.hang,.loupe,.undoBar,.pinPanel,.pinGhost,.anchor,.moveGrip');if(next!==hovered){hovered=next;interactionChanged();}};
$('stage').onpointerleave=()=>{hovered=false;interactionChanged();};$('stage').onfocusin=()=>{focused=true;interactionChanged();};
$('stage').onfocusout=e=>{if(!$('stage').contains(e.relatedTarget)){focused=false;interactionChanged();}};
$('addShot').onclick=$('emptyAdd').onclick=()=>add(makeItem());$('clear').onclick=clearRope;$('gather').onclick=gather;$('breeze').onclick=gust;
$('locked').onchange=()=>{gestures.cancelDrag();state.locked=$('locked').checked;renderCards();toast(state.locked?'绳位置已锁定，照片仍可取挂':'绳位置已解锁');};
$('restoreAnchors').onclick=()=>{const before=structuredClone(state.anchors),custom=state.custom;state.anchors=defaultAnchors(state.width);state.custom=false;saveAnchors();update(30);setUndo('已恢复默认位置',()=>{state.anchors=before;state.custom=custom;saveAnchors();update(20);},'position');toast('端点回到工作区顶部，右端让开灵动岛');};
$('enabled').onchange=()=>{gestures.cancelDrag();closePreview(false);state.enabled=$('enabled').checked;update(0,true);renderPins();toast(state.enabled?'晾衣绳已开启，照片仍保留':'晾衣绳已关闭，照片保留；自然风与逐帧更新停止');};
$('wind').onchange=()=>{state.wind=$('wind').checked;if(!state.wind&&motion?.kind==='wind'){stop();draw(target);}scheduleWind();};
$('reduce').onchange=()=>update(0,true);systemReduce.onchange=()=>update(0,true);
$('width').onchange=()=>{gestures.cancelDrag();const old=state.width;state.width=+$('width').value;if(state.custom){state.anchors.left.x*=state.width/old;state.anchors.right.x*=state.width/old;state.anchors=constrainAnchors(constrainAnchors(state.anchors,'right',state.width),'left',state.width);}else state.anchors=defaultAnchors(state.width);resize();update(0,true);};
$('theme').onchange=()=>{document.documentElement.dataset.theme=$('theme').value;};
$('scale').onclick=()=>{state.full=!state.full;$('scale').setAttribute('aria-pressed',state.full);$('scale').textContent=state.full?'适应窗口':'100% 查看';resize();};
$('files').onchange=async()=>{
  const files=[...$('files').files],generation=assetGeneration;$('files').value='';
  for(const file of files){const url=URL.createObjectURL(file),img=new Image();img.src=url;
    try{await img.decode();if(generation!==assetGeneration){URL.revokeObjectURL(url);return;}urls.add(url);add(makeItem(url,img.naturalWidth/img.naturalHeight,file.name));}
    catch{URL.revokeObjectURL(url);toast('图片读取失败：'+file.name+' · 请换一张重试');}}
};
function reset(){
  assetGeneration++;gestures.cancelDrag();closePreview(false);stop();clearTimeout(windTimer);clearTimeout(undoTimer);undoAction=null;$('undoBar').hidden=true;
  effects.cancelAll();clearOperation=null;state.clearingIds.clear();state.pendingHangs.clear();for(const url of urls)URL.revokeObjectURL(url);urls.clear();
  state.items=Array.from({length:5},()=>makeItem());state.pins=[];renderPins();update(0,true);
}
$('reset').onclick=reset;
document.onvisibilitychange=()=>{if(document.hidden){gestures.cancelDrag();stop();clearTimeout(windTimer);windTimer=0;}else update(0,true);};
window.addEventListener('blur',()=>{gestures.cancelDrag();stop();clearTimeout(windTimer);windTimer=0;});window.addEventListener('focus',()=>update(0,true));
window.addEventListener('resize',resize);window.addEventListener('pagehide',()=>{stop();effects.cancelAll();clearTimeout(windTimer);clearTimeout(undoTimer);clearTimeout(toastTimer);for(const url of urls)URL.revokeObjectURL(url);});
// 只读验收读数；演示交互始终走实际按钮与指针事件。
window.clotheslineReadout=()=>({count:state.items.length,pins:state.pins.length,queued:geometry.queued,sag:Math.max(...target),activeFrame:!!frame,windScheduled:!!windTimer,ids:state.items.map(i=>i.id),pinIds:state.pins.map(p=>p.item.id),anchors:structuredClone(state.anchors),clearing:!!clearOperation,pendingHangs:[...state.pendingHangs],reduced:reduced()});
readAnchors();resize();reset();
