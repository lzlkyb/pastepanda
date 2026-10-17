import { createMobileSpring } from '../src-mobile/ui/mobileSpring.ts';
const $ = id => document.getElementById(id);
const phone=$('phone'),reader=$('reader'),source=$('source'),sheet=$('sheet'),scrim=$('scrim');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let mode='reader',busy=false,drag=null,returning=false,exitAnimation=null;
const noMotion=()=>reduced.matches||$('reduced').checked;
const message=text=>{$('feedback').textContent=text;};
function drawBack(value){const p=Math.max(0,Math.min(1,value));phone.style.setProperty('--back-x',`${phone.clientWidth*.18*p}px`);phone.style.setProperty('--back-scale',`${1-.04*p}`);phone.style.setProperty('--back-radius',`${16*p}px`);}
const backMotion=createMobileSpring(0,drawBack);
const extent=()=>phone.dataset.layout==='landscape'?sheet.offsetWidth:sheet.offsetHeight;
const sheetMotion=createMobileSpring(0,value=>{phone.style.setProperty('--sheet-offset',`${Math.max(0,value)}px`);phone.style.setProperty('--scrim-opacity',`${1-Math.min(1,Math.max(0,value)/Math.max(1,extent()))}`);});
function back(value,done){if(noMotion()){backMotion.set(value);done?.();}else backMotion.move(value,undefined,done);}
function moveSheet(value,velocity,done){if(noMotion()){sheetMotion.set(value);done?.();}else sheetMotion.move(value,velocity,done);}
function openReader(){exitAnimation?.cancel();exitAnimation=null;backMotion.set(0);reader.hidden=false;reader.inert=false;source.inert=true;returning=false;message('从预览屏幕左边缘向右拖动；正文仍可上下滚动。');}
function cancelBack(){back(0,()=>{source.inert=true;reader.inert=false;});message('已取消返回 · 当前阅读位置保留。');}
function commitBack(){if(busy||returning)return;returning=true;reader.inert=true;back(1,()=>{const a=reader.animate([{opacity:1},{opacity:0}],{duration:noMotion()?0:150,easing:'cubic-bezier(0.2,0,0,1)'});exitAnimation=a;a.onfinish=()=>{if(exitAnimation!==a)return;exitAnimation=null;reader.hidden=true;reader.inert=true;source.inert=false;returning=false;$('source-row').focus({preventScroll:true});message('已返回来源列表 · 原位置与选中项保留。');};});}
function openSheet(){sheet.hidden=false;scrim.hidden=false;source.inert=true;reader.inert=true;sheetMotion.set(extent()+16);moveSheet(0,0,()=>{});$('close-sheet').focus({preventScroll:true});message('拖动页头：短拖回弹，快速下甩收起；横屏改为向右。');}
function closeSheet(velocity=0){if(busy)return;sheet.inert=true;moveSheet(extent()+16,velocity,()=>{sheet.hidden=true;scrim.hidden=true;sheet.inert=false;source.inert=false;$('show-sheet').focus({preventScroll:true});message('面板已收起 · 操作入口恢复。');});}
function setMode(next){exitAnimation?.cancel();exitAnimation=null;backMotion.stop();sheetMotion.stop();drag=null;returning=false;mode=next;$('show-reader').setAttribute('aria-pressed',String(next==='reader'));$('show-sheet').setAttribute('aria-pressed',String(next==='sheet'));sheet.hidden=true;scrim.hidden=true;sheet.inert=false;reader.hidden=true;source.inert=true;if(next==='reader')openReader();else openSheet();}
$('show-reader').onclick=()=>setMode('reader');$('show-sheet').onclick=()=>setMode('sheet');
$('size').onchange=()=>{phone.dataset.layout=$('size').value;setMode(mode);};
function motionPreference(){phone.dataset.motionOff=String(noMotion());backMotion.set(0);sheetMotion.set(0);drag=null;}
$('reduced').onchange=motionPreference;reduced.addEventListener('change',motionPreference);
$('large').onchange=()=>{phone.dataset.large=String($('large').checked);setMode(mode);};
$('busy').onchange=()=>{busy=$('busy').checked;['back','close-sheet','handle','apply','preview','cancel','commit'].forEach(id=>{$(id).disabled=busy;});sheet.setAttribute('aria-busy',String(busy));drag=null;backMotion.set(0);sheetMotion.set(0);message(busy?'正在提交（模拟）· 拖动与关闭暂停，避免把提交当成已取消。':'提交结束（模拟）· 恢复拖动与关闭。');};
$('preview').onclick=()=>{if(mode==='reader'){if(reader.hidden)openReader();reader.inert=true;backMotion.set(.5);message('返回预览 · 来源可见，尚未切页。');}else{if(sheet.hidden)openSheet();sheetMotion.set(extent()*.16);message('短拖预览 · 点“取消并回位”体验回弹。');}};
$('cancel').onclick=()=>{if(mode==='reader')cancelBack();else{moveSheet(0,0);message('已回弹 · 面板仍打开，选项保留。');}};
$('commit').onclick=()=>mode==='reader'?commitBack():closeSheet();
$('reopen').onclick=()=>setMode(mode);$('back').onclick=commitBack;$('handle').onclick=event=>{if(!busy&&event.detail===0)closeSheet();};$('close-sheet').onclick=()=>closeSheet();scrim.onclick=()=>closeSheet();$('apply').onclick=()=>{message('筛选已应用（模拟）');closeSheet();};
sheet.addEventListener('click',event=>{const option=event.target.closest('.option');if(!option)return;let start=option;while(start.previousElementSibling?.classList.contains('option'))start=start.previousElementSibling;for(let item=start;item?.classList.contains('option');item=item.nextElementSibling){item.setAttribute('aria-pressed',String(item===option));item.querySelector('span')?.remove();}const span=document.createElement('span');span.textContent='已选';option.append(span);message(`${option.childNodes[0].textContent.trim()} · 尚未应用`);});
function start(event,kind){if(busy||drag||event.button!==0||returning)return;const interactive=event.target.closest('button,a,input,textarea');if(kind==='sheet'&&interactive&&interactive!==$('handle'))return;if(kind==='back'&&(reader.hidden||event.clientX-reader.getBoundingClientRect().left>24))return;const sideways=kind==='back'||phone.dataset.layout==='landscape';const point=sideways?event.clientX:event.clientY;drag={id:event.pointerId,kind,sideways,start:point,cross:sideways?event.clientY:event.clientX,locked:false,origin:kind==='sheet'?sheetMotion.stop().position:backMotion.stop().position,samples:[{point,time:event.timeStamp}]};event.currentTarget.setPointerCapture(event.pointerId);}
function move(event){if(!drag||event.pointerId!==drag.id)return;const point=drag.sideways?event.clientX:event.clientY,cross=drag.sideways?event.clientY:event.clientX,delta=point-drag.start;
  if(!drag.locked){if(Math.max(Math.abs(delta),Math.abs(cross-drag.cross))<8)return;if(Math.abs(delta)<Math.abs(cross-drag.cross)*1.25){drag=null;return;}drag.locked=true;}
  drag.samples.push({point,time:event.timeStamp});drag.samples=drag.samples.filter(sample=>event.timeStamp-sample.time<=80);
  if(drag.kind==='back')backMotion.set(Math.max(0,Math.min(1,drag.origin+delta/(phone.clientWidth*.65))));else sheetMotion.set(Math.max(0,drag.origin+delta));
}
function finish(event,canceled=false){if(!drag||event.pointerId!==drag.id)return;const old=drag;drag=null;const point=old.sideways?event.clientX:event.clientY,last=old.samples.at(-1),first=old.samples[0];const velocity=!canceled&&last&&event.timeStamp-last.time<=80&&last.time>first.time?(last.point-first.point)/(last.time-first.time)*1000:0;
  if(old.kind==='back'){if(!canceled&&old.locked&&(backMotion.read().position>.55||velocity>600))commitBack();else cancelBack();}
  else{const distance=Math.max(0,old.origin+point-old.start),threshold=Math.max(48,Math.min(128,extent()*.2));if(!canceled&&((old.locked&&(distance>threshold||(distance>16&&velocity>600)))||(!old.locked&&event.target.closest('#handle'))))closeSheet(velocity);else{moveSheet(0,velocity);message('已回弹 · 面板仍打开，选项保留。');}}
}
reader.addEventListener('pointerdown',event=>start(event,'back'));$('sheet-drag').addEventListener('pointerdown',event=>start(event,'sheet'));
for(const target of[reader,$('sheet-drag')]){target.addEventListener('pointermove',move);target.addEventListener('pointerup',event=>finish(event));target.addEventListener('pointercancel',event=>finish(event,true));target.addEventListener('lostpointercapture',event=>finish(event,true));}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!busy){if(!sheet.hidden)closeSheet();else if(!reader.hidden)cancelBack();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){drag=null;backMotion.set(0);sheetMotion.set(0);}});
motionPreference();openReader();
