import test from 'node:test';
import assert from 'node:assert/strict';
import * as physics from './physics.mjs';
import { readFileSync } from 'node:fs';

test('默认端点位于24/32，右端让开灵动岛16px', () => {
  assert.deepEqual(physics.defaultAnchors(1440), { left: { x: 24, y: 32 }, right: { x: 1200, y: 32 } });
});
test('拖端点不交叉、不出屏，整体移动保持跨度和倾斜', () => {
  const initial = physics.defaultAnchors(1440);
  const adjusted = physics.constrainAnchors({ left: { x: 1300, y: 900 }, right: initial.right }, 'left', 1440);
  assert.ok(adjusted.right.x - adjusted.left.x >= 240);
  assert.ok(adjusted.left.y <= 480);
  const tilted = { left: { x: 24, y: 100 }, right: { x: 1200, y: 200 } };
  const moved = physics.moveAnchors(tilted, 999, 999, 1440);
  assert.equal(moved.right.x - moved.left.x, 1176);
  assert.equal(moved.right.y - moved.left.y, 100);
});
test('斜绳端点准确落在指定坐标，不强行保持同高', () => {
  const anchors = { left: { x: 40, y: 80 }, right: { x: 1100, y: 160 } };
  const g = physics.layout(1440, [{id:1,aspect:1.6}], anchors);
  const curve = physics.equilibrium(g);
  assert.deepEqual(physics.ropePoint(g, curve, 0), anchors.left);
  assert.deepEqual(physics.ropePoint(g, curve, 1), anchors.right);
});
test('右端上移避让灵动岛时仍保留240px跨度', () => {
  const anchors={left:{x:1140,y:120},right:{x:1416,y:32}};
  const next=physics.constrainAnchors(anchors,'right',1440);
  assert.ok(next.right.x-next.left.x>=240);
  assert.ok(next.right.y>=80||next.right.x<=1200);
});
test('宽绳整体上移不能为了避岛而把左端推出工作区', () => {
  const moved=physics.moveAnchors({left:{x:24,y:120},right:{x:1416,y:120}},0,-999,1440);
  assert.ok(moved.left.x>=24);
  assert.ok(moved.right.y>=80||moved.right.x<=1200);
  assert.equal(moved.right.x-moved.left.x,1392);
});
test('满绳挂回到第一格，新挂回图可见，旧图排队且无重复ID', () => {
  const items = Array.from({length:8}, (_,id)=>({id,aspect:1.6}));
  const next = physics.insertAtSlot(items, {id:99,aspect:1.6}, 0, 8);
  assert.equal(next.slice(-8)[0].id, 99);
  assert.equal(next.length, 9);
  assert.equal(new Set(next.map(x=>x.id)).size, 9);
  assert.equal(physics.insertAtSlot(next, next.at(-1), 1, 8).length, 9);
});
test('大风包含蓄风和800ms漂移，8张总时长1.5–1.8秒', () => {
  assert.ok(physics.WIND_TIMING.flight >= 800);
  assert.ok(physics.WIND_TIMING.lead + physics.WIND_TIMING.flight + 7 * physics.WIND_TIMING.stagger >= 1500);
  assert.ok(physics.WIND_TIMING.lead + physics.WIND_TIMING.flight + 7 * physics.WIND_TIMING.stagger <= 1800);
});
test('操作弹性不被鼠标悬停关闭，预览或拖拽仍可冻结底层', () => {
  assert.equal(physics.canSettle({enabled:true,hidden:false,reduced:false,hovered:true,focused:true,dragging:false,preview:false}), true);
  assert.equal(physics.canSettle({enabled:true,hidden:false,reduced:false,dragging:true,preview:false}), false);
});
test('接受取下手势前不调用取消归位，转场在当前位置接续', () => {
  const source = readFileSync(new URL('./gestures.mjs', import.meta.url), 'utf8');
  assert.match(source, /finishDrag/);
  assert.match(source, /onDetach\(active\.id, active\.el/);
  assert.doesNotMatch(source, /cancelDrag\(\);\s*.*onDetach/);
});
