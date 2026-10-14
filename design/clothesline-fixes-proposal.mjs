// Design-only interaction proposal; native IPC remains the established preview substitute.
await import('./clothesline-dev-preview.mjs');
const $=id=>document.getElementById(id);
$('qaNote').textContent='方案 A：只收当前绳上（最多 8 张），显示进度，可停止剩余；排队照片按页查看。预览默认适应，100% 可滚动读长图。';
const originalGather=$('gather').onclick;let batch=null;
$('gather').onclick=()=>{if(batch)return;const total=document.querySelectorAll('#hangs .hang').length;let done=0;const paint=()=>{$('batchProgress').textContent=`正在收衣 ${done}/${total} · 排队照片保留`};$('gather').disabled=true;$('batchProgress').hidden=false;$('stopBatch').hidden=false;paint();batch=setInterval(async()=>{done++;paint();if(done>=total){clearInterval(batch);batch=null;$('stopBatch').hidden=true;$('batchProgress').hidden=true;$('gather').disabled=false;await originalGather();}},700);};
$('stopBatch').onclick=()=>{clearInterval(batch);batch=null;$('batchProgress').textContent='已停止剩余 · 已完成部分可撤销';$('stopBatch').hidden=true;$('gather').disabled=false;};
$('fitImage').onclick=()=>$('loupeImage').classList.remove('actual');
$('actualImage').onclick=()=>$('loupeImage').classList.add('actual');
$('qaLong').onclick=()=>{const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="3200"><rect width="600" height="3200" fill="#e9eff5"/>${Array.from({length:40},(_,i)=>`<text x="32" y="${60+i*76}" font-family="sans-serif" font-size="24" fill="#243441">长截图正文 ${i+1} · 100% 可滚动阅读</text>`).join('')}</svg>`;const image=document.createElement('img');image.alt='长截图预览示例';image.src='data:image/svg+xml,'+encodeURIComponent(svg);const photo=document.createElement('div');photo.className='photo';photo.append(image);$('loupeImage').replaceChildren(photo);$('loupeImage').classList.remove('actual');$('loupeCaption').textContent='长截图 · 适应 / 100%';$('loupe').hidden=false;};
