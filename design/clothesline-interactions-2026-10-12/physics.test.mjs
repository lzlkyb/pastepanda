import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, equilibrium, springProgress, springImpulse, restoreSnapshot, isDetached } from './physics.mjs';

const photos = n => Array.from({ length: n }, (_, id) => ({ id, aspect: 1.6, weight: 1 }));

test('挂图负载增加下垂，端点保持固定且最大下垂封顶', () => {
  const peaks = [0, 1, 4, 8].map(n => {
    const curve = equilibrium(layout(1440, photos(n)));
    assert.equal(curve[0], 0);
    assert.equal(curve.at(-1), 0);
    assert.ok(curve.every(Number.isFinite));
    return Math.max(...curve);
  });
  assert.ok(peaks[0] < peaks[1] && peaks[1] < peaks[2] && peaks[2] < peaks[3]);
  assert.ok(Math.max(...equilibrium(layout(2560, photos(12)), 1.2)) <= 60);
});

test('图片重量与挂点改变受力形状，而非仅按数量画一条弧', () => {
  const geometry = layout(1440, photos(1));
  const light = equilibrium(geometry);
  const heavy = equilibrium(layout(1440, [{ id: 0, aspect: 1.6, weight: 2 }]));
  assert.ok(Math.max(...heavy) > Math.max(...light));
  const shifted = equilibrium({ ...geometry, cards: geometry.cards.map(card => ({ ...card, x: 900 })) });
  assert.notDeepEqual(light, shifted);
});

test('窄屏排队保留最新照片，不缩到96px以下、不越绳右端', () => {
  for (const width of [480, 768, 1366, 1440, 1920, 2560]) {
    const g = layout(width, photos(12));
    assert.equal(g.cards.at(-1).item.id, 11);
    assert.equal(g.cards.length + g.queued, 12);
    assert.ok(g.cards.every(card => card.iw >= 96 && card.x + card.width / 2 <= g.right));
  }
});

test('统一弹簧起点连续、存在回弹且衰减收敛', () => {
  assert.equal(springProgress(0), 0);
  assert.equal(springImpulse(0), 0);
  assert.ok(springProgress(.4) > 1);
  assert.ok(Math.abs(springProgress(1.2) - 1) < .001);
  assert.ok(Math.abs(springImpulse(1.2)) < .01);
});

test('清空撤销保留后来新图，重复撤销不重复挂同一ID', () => {
  const snapshot = photos(8), current = [{ id: 99, aspect: 1.6 }];
  const first = restoreSnapshot(current, snapshot, 8);
  assert.equal(first.items.at(-1).id, 99);
  assert.equal(first.queued, 1);
  const twice = restoreSnapshot(first.items, snapshot, 8);
  assert.equal(twice.items.length, 9);
  assert.equal(new Set(twice.items.map(item => item.id)).size, 9);
});

test('4px只识别拖动，绳内移动不直接取下，真正脱离才转贴图', () => {
  assert.equal(isDetached(5, 5, 150), false);
  assert.equal(isDetached(0, 25, 150), false);
  assert.equal(isDetached(0, 70, 150), true);
  assert.equal(isDetached(100, 0, 150), true);
});
