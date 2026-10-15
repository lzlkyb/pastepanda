import { WIND_TIMING } from './physics.mjs';

export function createEffects({ stage, layer, reduced }) {
  const running = new Map();
  function rect(el) {
    const a = el.getBoundingClientRect(), b = stage.getBoundingClientRect();
    const zoom = parseFloat(stage.style.getPropertyValue('--zoom')) || 1;
    return { x: (a.left - b.left) / zoom, y: (a.top - b.top) / zoom, w: a.width / zoom, h: a.height / zoom };
  }
  function capture(el) {
    if (!el) return null;
    const bounds = rect(el), copy = el.cloneNode(true);
    copy.removeAttribute('id'); copy.removeAttribute('tabindex'); copy.removeAttribute('role');
    copy.querySelectorAll('button,[id]').forEach(node => node.tagName === 'BUTTON' ? node.remove() : node.removeAttribute('id'));
    copy.classList.remove('dragging'); copy.classList.add('effectCopy');
    Object.assign(copy.style, { position: 'absolute', left: bounds.x + 'px', top: bounds.y + 'px', width: bounds.w + 'px', height: bounds.h + 'px', transform: 'none', visibility: 'visible', transformOrigin: '0 0' });
    layer.append(copy); return { copy, bounds };
  }
  function cancel(id) { const operation = running.get(id); if (operation) operation.cancel(); }
  function cancelAll() { [...running.keys()].forEach(cancel); }

  async function transfer(id, captured, destination, mode, dragged = false) {
    cancel(id);
    if (!captured || !destination || reduced()) { captured?.copy.remove(); return true; }
    const { copy, bounds } = captured, end = rect(destination), delay = dragged ? 0 : 200;
    const animations = [];
    const run = (node, keys, options) => { const a = node.animate(keys, options); animations.push(a); return a; };
    const frame = copy.querySelector('.frame');
    copy.querySelectorAll('.clip,.caption').forEach(node => run(node, [{opacity:1},{opacity:0}], {duration:150,fill:'forwards'}));
    if (frame && mode === 'pin') {
      frame.style.height = bounds.h - 5 + 'px';
      run(frame, [{padding:'8px 8px 20px',marginTop:'5px',height:bounds.h-5+'px',borderRadius:'12px'}, {padding:'0px',marginTop:'0px',height:bounds.h+'px',borderRadius:'4px'}], {duration:400,delay,fill:'forwards'});
    }
    if (mode === 'hang') {
      copy.style.overflow = 'visible';copy.classList.remove('pinGhost');
      const paper=document.createElement('div');paper.className='frame';paper.style.height=bounds.h+'px';
      const picture=copy.querySelector('.photo');paper.append(picture);copy.append(paper);
      run(paper,[{padding:'0px',marginTop:'0px',borderRadius:'4px'},{padding:'8px 8px 20px',marginTop:'5px',borderRadius:'12px'}],{duration:400,delay,fill:'both'});
      const caption=destination.querySelector('.caption')?.cloneNode(true);
      if(caption){paper.append(caption);run(caption,[{opacity:0},{opacity:1}],{duration:150,delay:delay+250,fill:'both'});}
      for (const clip of destination.querySelectorAll('.clip')) {
        const incoming = clip.cloneNode(true); copy.append(incoming);
        run(incoming, [{opacity:0},{opacity:1}], {duration:150,delay:delay+250,fill:'both'});
      }
    }
    const motion = run(copy, [
      {transform:'translate(0,0) scale(1,1)'},
      {transform:`translate(${end.x-bounds.x}px,${end.y-bounds.y}px) scale(${end.w/bounds.w},${end.h/bounds.h})`}
    ], {duration:400,delay,easing:'cubic-bezier(.05,.7,.1,1)',fill:'both'});
    let cancelled = false;
    const operation = {cancel:()=>{cancelled=true; animations.forEach(a=>a.cancel()); copy.remove();}};
    running.set(id, operation);
    try { await motion.finished; return !cancelled; } catch { return false; }
    finally { copy.remove(); if (running.get(id) === operation) running.delete(id); }
  }

  function gale(id, el, index, onRelease) {
    cancel(id);
    if (reduced() || !el) { onRelease(); return Promise.resolve(true); }
    const captured = el.copy ? el : capture(el), {copy,bounds} = captured;
    const lead = WIND_TIMING.lead + index * WIND_TIMING.stagger;
    const distance = parseFloat(stage.style.getPropertyValue('--sw')) - bounds.x + bounds.w;
    const a = copy.animate([
      {transform:'translate(0,0) rotate(0deg)',opacity:1},
      {transform:'translate(12px,-4px) rotate(-5deg)',opacity:1,offset:lead/(lead+800)},
      {transform:`translate(${distance*.28}px,-22px) rotate(5deg)`,opacity:1,offset:(lead+400)/(lead+800)},
      {transform:`translate(${distance*.65}px,-62px) rotate(12deg)`,opacity:1,offset:(lead+650)/(lead+800)},
      {transform:`translate(${distance}px,-100px) rotate(18deg)`,opacity:0}
    ], {duration:lead+WIND_TIMING.flight,easing:'linear',fill:'both'});
    const clipAnimations = [...copy.querySelectorAll('.clip')].map(clip => clip.animate([{opacity:1,scale:'1 1'},{opacity:0,scale:'1 .3'}], {duration:150,delay:lead-150,fill:'forwards'}));
    let cancelled = false;
    const timer = setTimeout(()=>{if (!cancelled) onRelease();}, lead);
    const operation = {cancel:()=>{cancelled=true; clearTimeout(timer); a.cancel(); clipAnimations.forEach(x=>x.cancel()); copy.remove();}};
    running.set(id,operation);
    return a.finished.then(()=>!cancelled,()=>false).finally(()=>{clearTimeout(timer);copy.remove();if(running.get(id)===operation)running.delete(id);});
  }
  return {capture,transfer,gale,cancel,cancelAll,rect};
}
