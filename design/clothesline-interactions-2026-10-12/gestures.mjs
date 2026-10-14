import { clamp, constrainAnchors, moveAnchors, ropeDrop } from './physics.mjs';

export function installGestures({ stage, hangs, pins, left, right, mover, marker, hint, getState, getGeometry, getCurve, onAnchors, onAnchorCommit, onDetach, onHangBack, onReorder, onPreview, onInteraction, onFinish, onGeometryCancel, onSlotPreview }) {
  let drag = null;
  const zoom = () => parseFloat(stage.style.getPropertyValue('--zoom')) || 1;
  const point = event => { const r=stage.getBoundingClientRect(); return {x:(event.clientX-r.left)/zoom(),y:(event.clientY-r.top)/zoom()}; };
  function hide() { marker.hidden=true;hint.hidden=true;onSlotPreview(null,null); }
  function begin(event, el, kind, id = null) {
    if (event.button !== 0) return;
    const state=getState(); if ((kind==='left'||kind==='right'||kind==='whole') && (state.locked||state.clearingIds.size)) return;
    if(id!==null&&(state.clearingIds.has(id)||state.pendingHangs.has(id)||state.pins.some(p=>p.item.id===id&&(p.pending||p.pendingBack))))return;
    drag={el,kind,id,pointerId:event.pointerId,start:point(event),anchors:structuredClone(state.anchors),x:parseFloat(el.style.left)||0,y:parseFloat(el.style.top)||0,moved:false,slot:null,detached:false};
    el.setPointerCapture(event.pointerId);onInteraction(true);
  }
  function finishDrag(cancelled = false) {
    if (!drag) return null;
    const active=drag;drag=null;hide();active.el.classList.remove('dragging','unclipped');
    if(active.el.hasPointerCapture(active.pointerId))active.el.releasePointerCapture(active.pointerId);
    onInteraction(false);
    if(cancelled){
      if(['left','right','whole'].includes(active.kind))onGeometryCancel(active.anchors);
      else if(active.kind==='pin'){active.el.style.left=active.x+'px';active.el.style.top=active.y+'px';}
      onFinish();
    }
    return active;
  }
  function cancelDrag(){finishDrag(true);}
  function slotAt(p, geometry, ignoreId) {
    const cards=geometry.cards.filter(c=>c.item.id!==ignoreId);
    const index=cards.findIndex(c=>p.x<c.x);
    return index<0?cards.length:index;
  }
  function showSlot(p, geometry, ignoreId, label) {
    const cards=geometry.cards.filter(c=>c.item.id!==ignoreId), slot=slotAt(p,geometry,ignoreId);
    const projected=onSlotPreview(drag.id,slot);
    const x=projected?.x??(cards.length ? slot===0?cards[0].x-cards[0].width/2:slot===cards.length?cards.at(-1).x+cards.at(-1).width/2:(cards[slot-1].x+cards[slot].x)/2 : (geometry.left+geometry.right)/2);
    const y=ropeDrop(geometry,getCurve(),x).y;
    const width=projected?.width??100;
    marker.style.width=width+'px';marker.style.height=(projected?.height??70)+'px';
    marker.style.left=clamp(x-width/2,geometry.left,geometry.right-width)+'px';marker.style.top=y+6+'px';marker.hidden=false;
    hint.textContent=label;hint.hidden=false;return slot;
  }
  function move(event) {
    if(!drag)return;
    const p=point(event),dx=p.x-drag.start.x,dy=p.y-drag.start.y;
    if(!drag.moved&&Math.hypot(dx,dy)<4)return;
    drag.moved=true;drag.el.classList.add('dragging');
    const state=getState(),g=getGeometry();
    if(drag.kind==='left'||drag.kind==='right'){
      const next=structuredClone(drag.anchors);next[drag.kind]={x:drag.anchors[drag.kind].x+dx,y:drag.anchors[drag.kind].y+dy};
      onAnchors(constrainAnchors(next,drag.kind,state.width));return;
    }
    if(drag.kind==='whole'){onAnchors(moveAnchors(drag.anchors,dx,dy,state.width));return;}
    drag.el.style.left=drag.x+dx+'px';drag.el.style.top=drag.y+dy+'px';
    if(drag.kind==='pin'){
      const pin=state.pins.find(x=>x.item.id===drag.id);if(!pin)return;
      const contact={x:drag.x+dx+pin.width/2,y:drag.y+dy};
      const projected=ropeDrop(g,getCurve(),contact.x);
      if(contact.x>=g.left-24&&contact.x<=g.right+24&&Math.abs(contact.y-projected.y)<40)drag.slot=showSlot(contact,g,null,'松手挂回 · Esc 取消');
      else {drag.slot=null;hide();}return;
    }
    const center={x:drag.x+dx,y:drag.y+dy}, contact=ropeDrop(g,getCurve(),center.x);
    drag.detached=center.x<g.left-24||center.x>g.right+24||Math.abs(center.y-contact.y)>36;
    drag.el.classList.toggle('unclipped',drag.detached);
    if(drag.detached){onSlotPreview(null,null);marker.hidden=true;hint.textContent='夹子已松开 · 松手转为贴图';hint.hidden=false;drag.slot=null;}
    else drag.slot=showSlot(center,g,drag.id,'松手调整顺序 · 拉离绳带取下');
  }
  function up() {
    if(!drag)return;
    const active=finishDrag();
    if(['left','right','whole'].includes(active.kind)){if(active.moved)onAnchorCommit(active.anchors);else onFinish();return;}
    if(active.kind==='pin'){
      if(active.slot!==null)onHangBack(active.id,active.slot,active.el,true);
      else {const pin=getState().pins.find(x=>x.item.id===active.id);if(pin){pin.x=clamp(parseFloat(active.el.style.left),16,getState().width-pin.width-16);pin.y=clamp(parseFloat(active.el.style.top),32,720-pin.height);active.el.style.left=pin.x+'px';active.el.style.top=pin.y+'px';}}
      onFinish();return;
    }
    if(!active.moved){onPreview(active.id);return;}
    if(active.detached)onDetach(active.id, active.el, true);
    else if(active.slot!==null)onReorder(active.id,active.slot);
    else onFinish();
  }
  for(const [el,kind] of [[left,'left'],[right,'right'],[mover,'whole']])el.onpointerdown=e=>begin(e,el,kind);
  hangs.onpointerdown=e=>{const el=e.target.closest('.hang');if(el&&!e.target.closest('button'))begin(e,el,'card',+el.dataset.id);};
  pins.onpointerdown=e=>{const el=e.target.closest('.pinGhost');if(el&&!e.target.closest('button'))begin(e,el,'pin',+el.dataset.pin);};
  for(const el of [hangs,pins,left,right,mover]){
    el.onpointermove=move;el.onpointerup=up;el.onpointercancel=cancelDrag;el.onlostpointercapture=()=>{if(drag)cancelDrag();};
  }
  return {cancelDrag,isDragging:()=>!!drag,draggedId:()=>drag?.kind==='card'?drag.id:null};
}
