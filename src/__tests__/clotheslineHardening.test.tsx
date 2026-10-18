import { readFileSync } from "node:fs";
import {layout, defaultAnchors, moveAnchors} from '../clothesline/physics.mjs';
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountClothesline } from "../clothesline/runtime.mjs";
import type { Callbacks, Photo, Pin, Snapshot, Rect } from "../clothesline/bridge.mjs";

const fixture = readFileSync("clothesline.html", "utf8").match(/<body>([\s\S]*?)<script/)![1];
const photos: Photo[] = Array.from({ length: 5 }, (_, i) => ({
  id: "photo-" + i,
  path: "C:/shots/" + i + ".png",
  name: "图片 " + i,
  source: "PastePanda 截图",
  width: 200,
  height: 120,
}));
let dispose: (() => void) | undefined;
const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
function fakeBridge() {
  let callbacks: Callbacks;
  const snapshot: Snapshot = {
    items: structuredClone(photos),
    enabled: true,
    wind: false,
    locked: false,
    anchors: null,
    workArea: { x: -1920, y: 80, width: 1440, height: 760 },
    scale: 1.25,
  };
  const pin: Pin = { hwnd: 42, generation: 7, path: photos[0].path, rect: { x: 0, y: 320, width: 200, height: 120 } };
  const bridge = {
    safe: (promise: Promise<unknown>) =>
      promise.catch((error) => document.dispatchEvent(new CustomEvent("clothesline-error", { detail: String(error) }))),
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(async (value: Callbacks) => {
      callbacks = value;
    }),
    prepare: vi.fn(async (p: Photo) => ({
      ...p,
      url: "data:image/png;base64,iVBORw0KGgo=",
      aspect: p.width / p.height,
    })),
    original: vi.fn(async (p: Photo) => p.path),
    photoForPin: vi.fn(async () => photos[0]),
    ready: vi.fn(async () => {}),
    reportError: vi.fn(async (_message: string) => {}),
    focusPreview: vi.fn(async () => {}),
    regions: vi.fn(async (_regions: Rect[], _dragging: boolean) => {}),
    config: vi.fn(async (_config: Record<string, unknown>) => {}),
    remove: vi.fn(async () => {}),
    restore: vi.fn(async (_items: Photo[]) => {}),
    order: vi.fn(async () => {}),
    idle: vi.fn(async () => {}),
    take: vi.fn(async (_photo: Photo, _rect: Pin["rect"]) => pin),
    dragTake: vi.fn(async (_photo: Photo, _rect: Pin["rect"]) => pin),
    startDrag: vi.fn(async (_pin: Pin, _rect: Rect, _held: boolean, _point?: {x:number; y:number}) => pin),
    showPin: vi.fn(async () => {}),
    closePin: vi.fn(async () => {}),
    returnPin: vi.fn(async () => photos[0]),
    logical: vi.fn((rect: Pin["rect"]) => rect),
    physical: vi.fn((rect: Pin["rect"]) => rect),
    manager: vi.fn(async () => {}),
    dispose: vi.fn(),
    emitUpdate: (next: Snapshot) => callbacks.update(next),
    emitClosed: (next: Pin) => callbacks.pinClosed(next),
    emitDrop: (next: Pin) => callbacks.pinDrop(next),
    emitPreview: (next: Pin | null) => callbacks.pinPreview(next),
    emitDismiss: () => callbacks.dismissPreview(),
    emitVisible: (value: boolean) => callbacks.visible(value),
    snapshotValue: snapshot,
    pin,
  };
  return bridge;
}
beforeEach(() => {
  document.body.innerHTML = fixture;
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 760, configurable: true });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

// Regressions first reproduced during the full interaction audit.
const card0=()=>document.querySelector('#hangs [data-id="photo-0"]') as HTMLElement;
const deferred=<T,>()=>{let resolve!:(v:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve};};
const begin=(card:HTMLElement)=>{
  card.setPointerCapture=vi.fn();card.hasPointerCapture=vi.fn(()=>true);card.releasePointerCapture=vi.fn();
  const x=parseFloat(card.style.left),y=parseFloat(card.style.top);
  const event=(dx:number,dy:number)=>({button:0,pointerId:1,clientX:x+dx,clientY:y+dy,target:card} as unknown as PointerEvent);
  const hangs=document.getElementById('hangs')!;hangs.onpointerdown!(event(0,0));
  return {hangs,event};
};
describe('Clothesline hardening regressions',()=>{
  it('disposing while detach creation is pending restores and closes its late pin without touching a new DOM',async()=>{
    const bridge=fakeBridge(),ready=deferred<Pin>();bridge.dragTake.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const {hangs,event}=begin(card0());hangs.onpointermove!(event(0,120));
    dispose();dispose=undefined;
    document.body.innerHTML=fixture;
    document.getElementById('stageStatus')!.textContent='new controller';
    document.getElementById('takeProgress')!.hidden=false;
    ready.resolve(bridge.pin);await waitFor(()=>expect(bridge.closePin).toHaveBeenCalled());
    expect(document.getElementById('stageStatus')!.textContent).toBe('new controller');
    expect(document.getElementById('takeProgress')!.hidden).toBe(false);expect(bridge.restore).toHaveBeenCalledOnce();
    expect(bridge.startDrag).not.toHaveBeenCalled();
  });
  it('clear removal awaiting IPC blocks photo drag detachment, not just action buttons',async()=>{
    const bridge=fakeBridge(),ready=deferred<void>();bridge.remove.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const card=card0();fireEvent.click(document.getElementById('clear')!);
    const {hangs,event}=begin(card);hangs.onpointermove!(event(0,120));
    expect(bridge.dragTake).not.toHaveBeenCalled();ready.resolve();
  });
  it('dropping another pin while one is receiving is handled independently without a blocking toast',async()=>{
    const bridge=fakeBridge(),ready=deferred<Photo>();bridge.photoForPin.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const pending=bridge.emitDrop({...bridge.pin,force:true});
    // 安静优先：不再为「另一张正在接收」弹提示，也不再把它弹回去；两张各自独立处理。
    const second=bridge.emitDrop({...bridge.pin,hwnd:43,force:true});
    expect(document.getElementById('toast')!.hidden).toBe(true);
    expect(bridge.closePin).not.toHaveBeenCalled();
    ready.resolve(photos[0]);await Promise.all([pending,second]);
  });
  it.each([false,true])('disposing during native commit must not render into the removed window (reject=%s)',async(reject)=>{
    const bridge=fakeBridge(),ready=deferred<Photo>();bridge.returnPin.mockImplementation(()=>ready.promise.then(item=>{if(reject)throw new Error('window closed');return item;}));
    dispose=await mountClothesline(bridge);const pending=bridge.emitDrop({...bridge.pin,force:true});
    await waitFor(()=>expect(bridge.returnPin).toHaveBeenCalled());
    dispose();dispose=undefined;document.body.innerHTML='';ready.resolve(photos[0]);
    await expect(pending).resolves.toBeUndefined();
  });
  it('Esc after native commit begins must not promise the original pin is still kept',async()=>{
    const bridge=fakeBridge(),ready=deferred<Photo>();bridge.returnPin.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const pending=bridge.emitDrop({...bridge.pin,force:true});
    await waitFor(()=>expect(bridge.returnPin).toHaveBeenCalled());fireEvent.keyDown(document,{key:'Escape'});
    // 已经进入提交阶段就不能再承诺「原贴图保留」，也不该再出现撤销字样。
    expect(document.getElementById('toast')!.textContent).toBe('正在完成挂回');
    ready.resolve(photos[0]);await pending;
  });
  it('Esc while reading a native photo stops hangback and leaves its native pin alone',async()=>{
    const bridge=fakeBridge(),ready=deferred<Photo>();bridge.photoForPin.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const pending=bridge.emitDrop({...bridge.pin,force:true});
    fireEvent.keyDown(document,{key:'Escape'});ready.resolve(photos[0]);await pending;
    expect(bridge.returnPin).not.toHaveBeenCalled();expect(bridge.closePin).not.toHaveBeenCalled();
    expect((document.getElementById('clear') as HTMLButtonElement).disabled).toBe(false);
  });
  it('duplicate native drops during photo preparation receive exactly one photo',async()=>{
    const bridge=fakeBridge(),ready=deferred<Photo>();bridge.photoForPin.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);
    const dropped={...bridge.pin,force:true};
    const first=bridge.emitDrop(dropped),second=bridge.emitDrop(dropped);
    ready.resolve(photos[0]);await Promise.all([first,second]);
    expect(bridge.photoForPin).toHaveBeenCalledOnce();expect(bridge.returnPin).toHaveBeenCalledOnce();
  });
  it('closing a native pin while its photo is reading aborts hangback without a stale ghost',async()=>{
    const bridge=fakeBridge(),ready=deferred<Photo>();bridge.photoForPin.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const pending=bridge.emitDrop({...bridge.pin,force:true});
    bridge.emitClosed(bridge.pin);ready.resolve(photos[0]);await pending;
    expect(bridge.returnPin).not.toHaveBeenCalled();
    expect(document.querySelectorAll('#pins > *')).toHaveLength(0);
  });
  it('hangback preparation no longer locks unrelated actions but still ignores late movement previews',async()=>{
    const bridge=fakeBridge(),ready=deferred<Photo>();bridge.photoForPin.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const pending=bridge.emitDrop({...bridge.pin,force:true});
    // 取挂只锁「这一张」：旧版会把收衣/清空一起灰掉，用户看着就是「点不动」。
    expect((document.getElementById('clear') as HTMLButtonElement).disabled).toBe(false);
    bridge.emitPreview({...bridge.pin,point:[600,180],rect:{x:500,y:55,width:200,height:120}});
    expect(document.getElementById('slotMarker')!.hidden).toBe(true);
    ready.resolve(photos[0]);await pending;
  });
  it('大图上沿靠绳不能误挂，拖拽预览的鼠标靠绳才能挂回',async()=>{
    const bridge=fakeBridge();dispose=await mountClothesline(bridge);
    const button=card0().querySelector('button') as HTMLButtonElement;
    await button.onclick!.call(button,new MouseEvent('click'));
    const dropped={...bridge.pin,point:[600,180] as [number,number],rect:{x:500,y:55,width:200,height:120}};
    bridge.emitPreview(dropped);
    expect(document.getElementById('slotMarker')!.hidden).toBe(true);
    bridge.emitPreview({...dropped,point:[600,80]});
    expect(document.getElementById('slotMarker')!.hidden).toBe(false);
    await bridge.emitDrop({...dropped,point:[600,80]});
    expect(bridge.returnPin).toHaveBeenCalledOnce();
  });
  it('hanging a known decoded photo back reuses its thumbnail instead of preparing it again',async()=>{
    const bridge=fakeBridge();dispose=await mountClothesline(bridge);
    const button=card0().querySelector('button') as HTMLButtonElement;
    await button.onclick!.call(button,new MouseEvent('click'));
    bridge.prepare.mockClear();
    await bridge.emitDrop({...bridge.pin,force:true});
    expect(bridge.returnPin).toHaveBeenCalledOnce();
    expect(bridge.prepare).not.toHaveBeenCalled();
  });
  it('native preparation focus changes must not release a photo while the pointer is held',async()=>{
    const bridge=fakeBridge(),ready=deferred<Pin>();bridge.dragTake.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const {hangs,event}=begin(card0());
    hangs.onpointermove!(event(0,60));
    fireEvent.blur(window);
    hangs.onpointermove!(event(0,80));
    ready.resolve(bridge.pin);
    await waitFor(()=>expect(bridge.startDrag).toHaveBeenCalled());
    expect(bridge.startDrag.mock.calls[0][2]).toBe(true);
    expect(bridge.restore).not.toHaveBeenCalled();
  });
  it('showPin failure must not permanently disable collect/clear',async()=>{
    const bridge=fakeBridge();bridge.showPin.mockRejectedValue(new Error('native window already closed'));
    dispose=await mountClothesline(bridge);
    const button=card0().querySelector('button')! as HTMLButtonElement;
    await button.onclick!.call(button,new MouseEvent('click'));
    expect((document.getElementById('gather') as HTMLButtonElement).disabled).toBe(false);
  });
  it('new captures must retain the card under an in-flight detach',async()=>{
    const bridge=fakeBridge(),ready=deferred<Pin>();bridge.dragTake.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const card=card0(),{hangs,event}=begin(card);
    hangs.onpointermove!(event(0,120));
    await bridge.emitUpdate({...bridge.snapshotValue,items:[...photos,...Array.from({length:8},(_,i)=>({...photos[0],id:'new-'+i}))]});
    expect(card.isConnected).toBe(true);
  });
  it('pulling an unprepared photo back onto the rope must cancel detach',async()=>{
    const bridge=fakeBridge(),ready=deferred<Pin>();bridge.dragTake.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const {hangs,event}=begin(card0());
    hangs.onpointermove!(event(0,120));hangs.onpointermove!(event(0,0));hangs.onpointerup!(event(0,0));
    ready.resolve(bridge.pin);await waitFor(()=>expect(bridge.closePin).toHaveBeenCalled());
    expect(bridge.startDrag).not.toHaveBeenCalled();
  });
  it('Esc after early mouse-up must still cancel pending conversion',async()=>{
    const bridge=fakeBridge(),ready=deferred<Pin>();bridge.dragTake.mockImplementation(()=>ready.promise);
    dispose=await mountClothesline(bridge);const {hangs,event}=begin(card0());
    hangs.onpointermove!(event(0,120));hangs.onpointerup!(event(0,120));fireEvent.keyDown(document,{key:'Escape'});
    ready.resolve(bridge.pin);await waitFor(()=>expect(bridge.closePin).toHaveBeenCalled());
    expect(bridge.startDrag).not.toHaveBeenCalled();
  });
  it('short work area must keep dragged anchors inside top margin',()=>{
    const result=moveAnchors(defaultAnchors(1024),0,0,1024,240);
    expect(result.left.y).toBeGreaterThanOrEqual(32);
  });
  it('panorama thumbnails must retain a nonzero visible photo region',()=>{
    expect(layout(1440,[{id:'panorama',aspect:1000}]).cards[0].ih).toBeGreaterThan(0);
  });
  it('oversized pin at the left monitor boundary needs a visible hang-back target',async()=>{
    const bridge=fakeBridge();dispose=await mountClothesline(bridge);
    bridge.emitPreview({...bridge.pin,rect:{x:0,y:32,width:3840,height:2160}});
    expect(document.getElementById('slotMarker')!.hidden).toBe(false);
  });
});


describe('Bounded batch, preview and landing',()=>{
 it('clearing a large queue batches hidden removals instead of rendering every queued image',async()=>{
  const bridge=fakeBridge();bridge.snapshotValue.items=Array.from({length:2000},(_,i)=>({...photos[0],id:'p'+i}));
  dispose=await mountClothesline(bridge);
  let updates=0;
  const observer=new MutationObserver(records=>{updates+=records.length;});
  observer.observe(document.getElementById('stageStatus')!,{childList:true});
  const clear=document.getElementById('clear') as HTMLButtonElement;
  await clear.onclick!.call(clear,new MouseEvent('click'));
  expect(document.getElementById('countValue')!.textContent).toBe('0 张');
  await Promise.resolve();observer.disconnect();
  expect(updates).toBeLessThan(100);
 });
 it('preview mode changes refresh the native hit region',async()=>{
  const bridge=fakeBridge();dispose=await mountClothesline(bridge);
  const box=document.getElementById('loupe')!;
  let height=240;
  vi.spyOn(box,'getBoundingClientRect').mockImplementation(()=>({x:300,y:100,left:300,top:100,right:800,bottom:100+height,width:500,height,toJSON:()=>({})}));
  fireEvent.keyDown(card0(),{key:'Enter'});
  await waitFor(()=>expect((document.getElementById('actualImage') as HTMLButtonElement).disabled).toBe(false));
  await waitFor(()=>expect(bridge.regions.mock.calls[bridge.regions.mock.calls.length-1][0]).toContainEqual({x:300,y:100,width:500,height:240}));
  height=480;fireEvent.click(document.getElementById('actualImage')!);
  await waitFor(()=>expect(bridge.regions.mock.calls[bridge.regions.mock.calls.length-1][0]).toContainEqual({x:300,y:100,width:500,height:480}));
 });
 it('collect only the visible rope and keep queued images',async()=>{
  const bridge=fakeBridge();bridge.snapshotValue.items=Array.from({length:32},(_,i)=>({...photos[0],id:'p'+i}));
  bridge.take.mockImplementation(async(item,rect)=>({...bridge.pin,path:item.path,rect,generation:Number(item.id.slice(1))+100}));
  dispose=await mountClothesline(bridge);fireEvent.click(document.getElementById('gather')!);
  await waitFor(()=>expect(document.getElementById('batchProgress')!.hidden).toBe(true));
  expect(bridge.take).toHaveBeenCalledTimes(8);
  expect(document.getElementById('countValue')!.textContent).toContain('排队');
 });
 it('stop remaining batch work while the two already started are receiving',async()=>{
  const bridge=fakeBridge(),ready=deferred<Pin>();bridge.take.mockImplementation(()=>ready.promise);
  dispose=await mountClothesline(bridge);fireEvent.click(document.getElementById('gather')!);
  expect(bridge.take).toHaveBeenCalledTimes(2);fireEvent.click(document.getElementById('stopBatch')!);
  ready.resolve(bridge.pin);await waitFor(()=>expect(document.getElementById('stopBatch')!.hidden).toBe(true));
  expect(bridge.take).toHaveBeenCalledTimes(2);expect(document.querySelectorAll('#hangs .hang')).toHaveLength(3);
  expect(document.querySelectorAll('#fxLayer > *')).toHaveLength(0);
 });
 it('two thousand queued photos render at most twenty rows plus page controls',async()=>{
  const bridge=fakeBridge();bridge.snapshotValue.items=Array.from({length:2000},(_,i)=>({...photos[0],id:'p'+i}));
  dispose=await mountClothesline(bridge);expect(document.querySelectorAll('#queue button')).toHaveLength(22);
  const next=Array.from(document.querySelectorAll('#queue button')).find(b=>b.textContent==='下一页')!;
  fireEvent.click(next);expect(document.getElementById('queue')!.textContent).toContain('2/100 页');
 });
 it('repeat preview reuses the original and 100 percent remains mouse accessible',async()=>{
  const bridge=fakeBridge();dispose=await mountClothesline(bridge);
  fireEvent.keyDown(card0(),{key:'Enter'});await waitFor(()=>expect((document.getElementById('actualImage') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(document.getElementById('actualImage')!);expect(document.getElementById('loupeImage')!.classList.contains('previewActual')).toBe(true);
  fireEvent.click(document.getElementById('closePreview')!);fireEvent.keyDown(card0(),{key:'Enter'});
  await waitFor(()=>expect(document.getElementById('previewLoad')!.hidden).toBe(true));expect(bridge.original).toHaveBeenCalledOnce();
 });
 it('snapshot arriving during landing waits until the target is stable',async()=>{
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('matchMedia', () => ({matches:false}));
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:()=>({finished:Promise.resolve(),cancel:vi.fn()})});
  const bridge=fakeBridge();dispose=await mountClothesline(bridge);
  const button=card0().querySelector('button') as HTMLButtonElement;await button.onclick!.call(button,new MouseEvent('click'));
  const landing=deferred<Animation>();Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:()=>({finished:landing.promise,cancel:vi.fn()})});
  const dropping=bridge.emitDrop({...bridge.pin,force:true});await waitFor(()=>expect(bridge.returnPin).toHaveBeenCalled());
  const original=document.querySelector('#hangs [data-id="photo-0"]');
  await bridge.emitUpdate({...bridge.snapshotValue,items:[...photos,...Array.from({length:10},(_,i)=>({...photos[0],id:'new'+i}))]});
  expect(original?.isConnected).toBe(true);expect((document.getElementById('anchorLeft') as HTMLButtonElement).disabled).toBe(true);
  landing.resolve({} as Animation);await dropping;expect(document.getElementById('countValue')!.textContent).toContain('排队');
  hidden.mockRestore();
 });
 it('initial failure reports outside the hidden WebView and removes subscriptions',async()=>{
  const {startClothesline}=await import('../clothesline/startup.mjs');const bridge=fakeBridge();bridge.snapshot.mockRejectedValue(new Error('initial IPC failed'));
  expect(await startClothesline(bridge)).toBeUndefined();expect(bridge.reportError).toHaveBeenCalledWith(expect.stringContaining('initial IPC failed'));expect(bridge.dispose).toHaveBeenCalled();
 });
});
