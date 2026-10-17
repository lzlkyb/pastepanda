import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {createOriginalCache} from '../clothesline/originalCache.mjs';
const photo=(id:string)=>({id,path:id,width:100,height:100});
beforeEach(()=>vi.stubGlobal('Image',class { src=''; async decode() {} }));
afterEach(()=>vi.unstubAllGlobals());
describe('Bounded original image cache',()=>{
 it('evicts least recently used originals and refuses oversized entries',async()=>{
  const read=vi.fn(async (p:{id:string})=>p.id);const cache=createOriginalCache(read,100000);
  await cache.load(photo('a'));await cache.load(photo('b'));await cache.load(photo('a'));await cache.load(photo('c'));await cache.load(photo('b'));
  expect(read).toHaveBeenCalledTimes(4);
  await cache.load({...photo('large'),width:1000});await cache.load({...photo('large'),width:1000});expect(read).toHaveBeenCalledTimes(6);
 });
 it('stale queued previews release their reserved slot without blocking the next image',async()=>{
  const complete:((url:string)=>void)[]=[];const read=vi.fn(()=>new Promise<string>(resolve=>complete.push(resolve)));const cache=createOriginalCache(read);
  const jobs=[cache.load(photo('a')),cache.load(photo('b')),cache.load(photo('stale'),()=>false).catch(error=>String(error)),cache.load(photo('last'))];
  expect(read).toHaveBeenCalledTimes(2);complete.shift()!('a');complete.shift()!('b');
  await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(3));complete.shift()!('last');
  const result=await Promise.all(jobs);expect(result[2]).toContain('预览已关闭');expect(result[3]).toBe('last');
 });
});
