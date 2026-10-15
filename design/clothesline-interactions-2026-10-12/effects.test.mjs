import test from 'node:test';
import assert from 'node:assert/strict';
import { createEffects } from './effects.mjs';

function fixture() {
  const animations=[];
  const copy={removed:false,querySelector:()=>null,querySelectorAll:()=>[],remove(){this.removed=true;},animate(keys,options){
    let resolve,reject;const finished=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const animation={keys,options,finished,finish:resolve,cancel:()=>reject(new Error('cancelled'))};animations.push(animation);return animation;
  }};
  const stage={style:{getPropertyValue:key=>key==='--sw'?'1440px':'1'},getBoundingClientRect:()=>({left:0,top:0})};
  return {copy,animations,captured:{copy,bounds:{x:80,y:100,w:200,h:120}},effects:createEffects({stage,layer:{},reduced:()=>false})};
}
test('实际大风先蓄风、逐张卸载，8张尾图1720ms，淡出留到末段',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const {effects,captured,animations}=fixture();let releases=0;
  const pending=effects.gale(7,captured,7,()=>releases++);
  assert.equal(animations[0].options.duration,1720);
  const late=animations[0].keys.at(-2);
  assert.equal(late.opacity,1);assert.ok(late.offset>.9);
  context.mock.timers.tick(919);assert.equal(releases,0);
  context.mock.timers.tick(1);assert.equal(releases,1);
  animations[0].finish();assert.equal(await pending,true);assert.equal(captured.copy.removed,true);
});
test('中途撤销大风取消卸重计时和转场副本',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const {effects,captured}=fixture();let releases=0;
  const pending=effects.gale(1,captured,0,()=>releases++);
  context.mock.timers.tick(200);effects.cancel(1);context.mock.timers.tick(2000);
  assert.equal(await pending,false);assert.equal(releases,0);assert.equal(captured.copy.removed,true);
});
test('取下转场使用松手坐标，无等待归位，取消后不报完成',async()=>{
  const {effects,captured,animations}=fixture();
  const destination={getBoundingClientRect:()=>({left:180,top:240,width:200,height:120})};
  const pending=effects.transfer(3,captured,destination,'pin',true);
  assert.equal(animations[0].options.delay,0);
  assert.equal(animations[0].keys[1].transform,'translate(100px,140px) scale(1,1)');
  effects.cancel(3);assert.equal(await pending,false);assert.equal(captured.copy.removed,true);
});
