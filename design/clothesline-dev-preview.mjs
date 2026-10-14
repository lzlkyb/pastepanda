// 浏览器联调替身只替换原生 IPC；交互、排版、运动使用生产控制器。
import '/src/styles/globals.css';
import '/src/styles/theme.css';
import '/src/clothesline/clothesline.css';
import {mountClothesline} from '/src/clothesline/runtime.mjs';
document.documentElement.dataset.theme='ocean-dark';
let callbacks,uid=0;
// 通过显式测试参数复现慢盘/大图，延迟仅存在于联调替身。
const delay=Math.min(5000,Math.max(0,Number(new URLSearchParams(location.search).get('slow'))||0));
const wait=()=>new Promise(resolve=>setTimeout(resolve,delay));
const started=performance.now();
const state={items:[],enabled:true,wind:true,locked:false,anchors:null,workArea:{x:0,y:0,width:innerWidth,height:innerHeight},scale:1};
const pins=new Map();
function picture(i){return 'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="${['#e9eff5','#f3dfc1','#cddccb'][i%3]}"/><text x="32" y="64" font-family="sans-serif" font-size="28" fill="#243441">PastePanda · 图片 ${i+1}</text><path d="M40 300h520M40 140h360M40 180h450M40 220h280" stroke="#718ca1" stroke-width="10"/></svg>`);}
const publish=()=>callbacks?.update(structuredClone(state));
function add(){const i=uid++;state.items.push({id:'capture-'+i,path:'local-'+i,name:'截图 '+(i+1),source:'浏览器联调',width:600,height:400,...(delay?{}:{url:picture(i)})});publish();}
for(let i=0;i<5;i++)add();
function removePin(pin){pins.get(pin.generation)?.el?.remove();pins.delete(pin.generation);}
function showPin(pin){
  const p=pins.get(pin.generation);if(!p||p.el)return;
  const el=document.createElement('div');p.el=el;el.className='testNativePin';Object.assign(el.style,{left:pin.rect.x+'px',top:pin.rect.y+'px',width:pin.rect.width+'px',height:pin.rect.height+'px'});
  const img=document.createElement('img');img.src=p.item.url;img.draggable=false;el.append(img);
  const back=document.createElement('button');back.textContent='挂回绳子';back.onclick=()=>{pin.rect.x=400;pin.rect.y=70;callbacks.pinDrop(pin);};el.append(back);document.body.append(el);
}
const bridge={
  safe:p=>p.catch(error=>document.dispatchEvent(new CustomEvent('clothesline-error',{detail:String(error)}))),
  snapshot:async()=>structuredClone(state),subscribe:async c=>{callbacks=c;},prepare:async p=>{await wait();return {...p,url:picture(Number(p.id.split('-')[1]))};},original:async p=>p.url||picture(Number(p.id.split('-')[1])),
  ready:async()=>{document.getElementById('qaNote').textContent=`绳层就绪 ${Math.round(performance.now()-started)}ms；缩略图 / 原图准备延迟 ${delay}ms。`;},focusPreview:async()=>{},regions:()=>{},config:async patch=>{if('clothesline_locked'in patch)state.locked=patch.clothesline_locked;if('clothesline_anchors'in patch)state.anchors=patch.clothesline_anchors;publish();},
  remove:async ids=>{state.items=state.items.filter(p=>!ids.includes(p.id));publish();},
  restore:async items=>{state.items=[...items.filter(i=>!state.items.some(p=>p.id===i.id)),...state.items];publish();},
  order:async ids=>{state.items=ids.map(id=>state.items.find(p=>p.id===id)).filter(Boolean);publish();},idle:()=>{},
  logical:r=>r,physical:r=>r,
  take:async(item,rect)=>{const target={...rect,width:item.width,height:item.height,x:Math.max(0,Math.min(rect.x,innerWidth-item.width)),y:Math.max(0,Math.min(rect.y,innerHeight-item.height))};const pin={hwnd:uid+100,generation:++uid,path:item.path,rect:target};pins.set(pin.generation,{item,pin});state.items=state.items.filter(p=>p.id!==item.id);publish();return pin;},
  showPin:async pin=>showPin(pin),closePin:async pin=>removePin(pin),
  dragTake:async(item,rect)=>{await wait();return bridge.take({...item,url:item.url||picture(Number(item.id.split('-')[1]))},rect);},
  startDrag:async(pin,rect,held)=>{pin.rect={...rect,x:Math.max(0,Math.min(rect.x,innerWidth-rect.width)),y:Math.max(0,Math.min(rect.y,innerHeight-rect.height))};showPin(pin);document.getElementById('qaNote').textContent=held?'原生接收已准备完成；浏览器模拟只落成贴图，跨应用交付请在桌面 dev 验证。':'准备期间已松手：原图落在最后松手的位置，绳层保持可见。';return pin;},
  returnPin:async(pin,id)=>{const item=pins.get(pin.generation).item;removePin(pin);state.items=state.items.filter(i=>i.id!==id);state.items.push(item);publish();return item;},
  photoForPin:async pin=>pins.get(pin.generation).item,manager:()=>{document.getElementById('qaNote').textContent='桌面版在贴图管理面板中提供挂回；这里是原生 IPC 替身。';},dispose:()=>{}
};
await mountClothesline(bridge);
document.getElementById('qaAdd').onclick=add;
