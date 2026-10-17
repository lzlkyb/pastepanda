import { createMobileSpring } from "../src-mobile/ui/mobileSpring.ts";
const $ = id => document.getElementById(id);
const state = { detail: false, sheet: false, sideways: false, reduced: false, current: "均衡", timer: null, request: 0, drag: null };
const status = text => $("status").textContent = text;
const detailMotion = createMobileSpring(0, x => $("detail").style.setProperty("--detail-x", `${x}px`));
const sheetMotion = createMobileSpring(0, x => $("sheet").style.setProperty("--sheet-offset", `${Math.max(0,x)}px`));
const move = (motion, value, velocity, done) => state.reduced ? (motion.set(value), done?.()) : motion.move(value, velocity, done);
function reader(open) {
 $("remote").hidden = true; $("home").hidden = false;
 state.detail = open; $("detail").inert = !open;
 $("back-progress").value = 0;
 for (const id of ["back-progress","cancel-back","commit-back"]) $(id).disabled = !open;
 document.querySelector(".mainNav").hidden = open;
 $("home").inert = open;
 if (open) { $("detail").hidden = false; detailMotion.set($("app").clientWidth); move(detailMotion,0); status("详情进入；底层列表和位置保留。返回手势只预览，提交才改变页面。"); }
 else { move(detailMotion,$("app").clientWidth,undefined,()=>{if(!state.detail)$("detail").hidden=true;}); status("已返回原列表；未修改底层位置。"); }
}
function closeSheet() {
 state.sheet=false; state.request++; clearTimeout(state.timer);
 $("sheet-feedback").hidden=true;
 const distance=(state.sideways?$("sheet").offsetWidth:$("sheet").offsetHeight)+16;
 move(sheetMotion,distance,state.drag?.velocity,()=>{if(!state.sheet){$("sheet").hidden=true;$("scrim").hidden=true;$("home").inert=state.detail;$("detail").inert=!state.detail;$("remote").inert=false;document.querySelector(".mainNav").inert=false;}});
 status("弹层退出完成后释放遮罩；草稿和页面保留。");
}
function remote(){state.detail=false;detailMotion.stop();$("detail").hidden=true;$("home").hidden=true;$("remote").hidden=false;document.querySelector(".mainNav").hidden=true;for(const id of ["back-progress","cancel-back","commit-back"])$(id).disabled=true;}
function scene(id){for(const name of ["list","quality","receipt"])$(name).setAttribute("aria-pressed",`${name===id}`);}
function sheet(type="quality") {
 clearTimeout(state.timer); state.request++; state.sheet=true; state.drag=null;
 $("sheet-title").textContent=type==="quality"?"画面":type==="toc"?"目录":type==="pending"?"待处理":"更多";
 $("sheet-body").innerHTML=type==="quality"?`<h3>画质</h3><div class="quality" role="group" aria-label="画质">${["自动","清晰","均衡","流畅"].map(q=>`<button data-quality="${q}" aria-pressed="${q===state.current}">${q}</button>`).join("")}</div><button data-action="fit">适应屏幕</button><button data-action="strategy">画质策略与操作手势</button><p>演示真实请求与结果的区分，不发送远控命令。</p>`:type==="toc"?`<button data-heading="0">先完成眼前的事</button><button data-heading="1">返回仍是熟悉的位置</button>`:type==="pending"?`<button data-action="draft">继续写 · 通勤记录</button><p>草稿、分享与文章汇总；打开后返回原列表。</p>`:`<button data-action="copy">复制正文</button><button data-action="share">系统分享</button><p>菜单在一个弹层内部切换；长任务进入全页。</p>`;
 $("sheet-feedback").hidden=true;$("sheet").hidden=false;$("scrim").hidden=false;$("home").inert=true;$("detail").inert=true;$("remote").inert=true;document.querySelector(".mainNav").inert=true;
 sheetMotion.set((state.sideways?$("sheet").offsetWidth:$("sheet").offsetHeight)+16);move(sheetMotion,0);
 status("拖动整个弹层页头；短拖松手回弹，越过阈值或快速甩动收起。正文单独滚动。");
}
function feedback(text,error=false){$("sheet-feedback").hidden=false;$("sheet-feedback").textContent=text;$("sheet-feedback").dataset.state=error?"error":"info";}
$("sheet-body").addEventListener("click",event=>{
 const target=event.target.closest("button");if(!target)return;
 const q=target.dataset.quality;
 if(q){const epoch=++state.request;feedback("正在发送画质设置…");clearTimeout(state.timer);state.timer=setTimeout(()=>{if(epoch!==state.request||!state.sheet)return;state.current=q;document.querySelectorAll("[data-quality]").forEach(b=>b.setAttribute("aria-pressed",`${b.dataset.quality===q}`));feedback(`电脑已接受设置 · ${q}（模拟回执）`);status("请求与接受分开；接受回执不等于新帧已应用。");},900);return;}
 if(target.dataset.heading){const h=$("detail").querySelectorAll("h3")[Number(target.dataset.heading)];closeSheet();h?.scrollIntoView({block:"start"});return;}
 feedback(target.dataset.action==="strategy"?"沿用当前操作方式的说明；普通选项不藏在长说明下面。":"交互示意：保留原页面，仅反馈当前动作。");
});
$("sheet-handle").addEventListener("pointerdown",event=>{
 if(event.target.closest("button")||!state.sheet)return;
 const position=sheetMotion.stop().position;state.drag={id:event.pointerId,start:state.sideways?event.clientX:event.clientY,origin:position,last:position,time:event.timeStamp,velocity:0};event.currentTarget.setPointerCapture(event.pointerId);
});
$("sheet-handle").addEventListener("pointermove",event=>{
 const d=state.drag;if(!d||d.id!==event.pointerId)return;
 const distance=Math.max(0,d.origin+(state.sideways?event.clientX:event.clientY)-d.start),dt=event.timeStamp-d.time;
 if(dt>0)d.velocity=(distance-d.last)/dt*1000;d.last=distance;d.time=event.timeStamp;sheetMotion.set(distance);
});
$("sheet-handle").addEventListener("pointerup",event=>{
 const d=state.drag;if(!d||d.id!==event.pointerId)return;
 const length=state.sideways?$("sheet").offsetWidth:$("sheet").offsetHeight;
 if(d.last>Math.max(48,Math.min(128,length*.2))||(d.last>16&&event.timeStamp-d.time<80&&d.velocity>600))closeSheet();else{move(sheetMotion,0,d.velocity);status("未越过退出阈值，面板回弹；当前选择保留。");}state.drag=null;
});
const cancelDrag=()=>{if(state.drag){state.drag=null;move(sheetMotion,0,0);}};
$("sheet-handle").addEventListener("pointercancel",cancelDrag);$("sheet-handle").addEventListener("lostpointercapture",cancelDrag);
$("open-note").onclick=$("open-note-two").onclick=()=>reader(true);$("back").onclick=()=>reader(false);
$("list").onclick=()=>{scene("list");if(state.sheet)closeSheet();reader(false);};
$("quality").onclick=()=>{scene("quality");remote();sheet();};$("new").onclick=()=>sheet("pending");$("receipt").onclick=()=>{scene("receipt");remote();sheet();feedback("设置未确认 · 保留原档位，重试会在这里显示结果。",true);};
$("pending").onclick=()=>sheet("pending");$("toc").onclick=()=>sheet("toc");$("more").onclick=()=>sheet("more");$("close-sheet").onclick=$("scrim").onclick=closeSheet;
$("common").onclick=()=>{const button=$("common"),on=button.getAttribute("aria-pressed")==="true";button.setAttribute("aria-pressed",`${!on}`);button.lastElementChild.textContent=on?"常用":"已常用";$("reader-feedback").hidden=false;$("reader-feedback").textContent=on?"已移出手机常用":"已加入手机常用";};
$("back-progress").oninput=event=>{detailMotion.set(Number(event.target.value)/100*$("app").clientWidth*.45);status("这里只预览返回，原数据和输入不变。可取消或完成。");};
$("cancel-back").onclick=()=>{$("back-progress").value=0;move(detailMotion,0,0);status("取消返回：回到当前阅读状态。");};$("commit-back").onclick=()=>reader(false);
for(const id of ["portrait","landscape"]){$(id).onclick=()=>{cancelDrag();state.sideways=id==="landscape";$("device").classList.toggle("landscape",state.sideways);$("portrait").setAttribute("aria-pressed",`${!state.sideways}`);$("landscape").setAttribute("aria-pressed",`${state.sideways}`);sheetMotion.set(0);status("方向改变，布局适配；阅读和任务状态保留。");};}
$("large").onclick=()=>{const on=$("device").classList.toggle("large");$("large").setAttribute("aria-pressed",`${on}`);};
$("reduced").onclick=()=>{state.reduced=!state.reduced;$("reduced").setAttribute("aria-pressed",`${state.reduced}`);detailMotion.stop();sheetMotion.stop();detailMotion.set(state.detail?0:$("app").clientWidth);if(!state.detail)$("detail").hidden=true;sheetMotion.set(0);if(!state.sheet){$("sheet").hidden=true;$("scrim").hidden=true;$("home").inert=state.detail;$("detail").inert=!state.detail;$("remote").inert=false;document.querySelector(".mainNav").inert=false;}status(state.reduced?"减少动效：保留状态变化，关闭大幅位移。":"恢复普通动效。");};
document.addEventListener("keydown",event=>{if(event.key!=="Escape")return;if(state.sheet)closeSheet();else if(state.detail)reader(false);});
window.addEventListener("pagehide",()=>{clearTimeout(state.timer);detailMotion.dispose();sheetMotion.dispose();});

$("remote-tools").onclick=()=>sheet();$("remote-exit").onclick=()=>reader(false);
