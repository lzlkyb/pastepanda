import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginDrag, moveDrag, endDrag, originalPinRect, resolveDropRect, regrabPreviewRect, snapToRope } from './policy.mjs';

test('小距离下拉和等待不会结束按住状态', () => {
  const drag = beginDrag({ x: 100, y: 100, width: 200, height: 120 }, { x: 180, y: 150 }, 20);
  moveDrag(drag, { x: 180, y: 158 });
  assert.equal(drag.held, true);
  assert.equal(drag.rect.y, 108);
  assert.equal(drag.returned, false);
  moveDrag(drag, { x: 220, y: 240 });
  assert.deepEqual(drag.rect, { x: 140, y: 190, width: 200, height: 120 });
  assert.equal(endDrag(drag), 'pin');
});

test('主动拉回固定接触位置或取消才能恢复', () => {
  const drag = beginDrag({ x: 100, y: 100, width: 200, height: 120 }, { x: 180, y: 150 }, 20);
  moveDrag(drag, { x: 180, y: 70 });
  assert.equal(drag.returned, true);
  assert.equal(drag.held, true);
  assert.equal(endDrag(drag), 'return');
  assert.equal(endDrag(beginDrag(drag.rect, { x: 180, y: 70 }, 20), true), 'return');
});

test('松手后的迟到移动不能改变落点', () => {
  const drag = beginDrag({ x: 100, y: 100, width: 200, height: 120 }, { x: 180, y: 150 }, 20);
  endDrag(drag);
  moveDrag(drag, { x: 600, y: 600 });
  assert.equal(drag.rect.x, 100);
  assert.equal(drag.rect.y, 100);
});

test('贴图恢复原图像素大小，不能沿用缩略图大小', () => {
  const source = { x: 120, y: 180, width: 200, height: 120 };
  assert.deepEqual(originalPinRect(source, { width: 1200, height: 630 }), { x: 120, y: 180, width: 1200, height: 630 });
  assert.equal(source.width, 200);
});

test('高 DPI 下原图每个像素仍对应一个物理像素，超屏图片不缩小', () => {
  const result = originalPinRect({ x: 0, y: 0, width: 200, height: 120 }, { width: 3840, height: 2160 }, 1.5);
  assert.equal(result.width * 1.5, 3840);
  assert.equal(result.height * 1.5, 2160);
});

test('未放手时仍保持缩略图尺寸和位置', () => {
  const preview = { x: 200, y: 300, width: 240, height: 126 };
  assert.deepEqual(resolveDropRect(preview, { width: 1200, height: 630 }, { x: 320, y: 363 }, { held: true }), preview);
});

test('桌面放手后原图中心对齐最终鼠标位置', () => {
  const landed = resolveDropRect({ x: 100, y: 120, width: 240, height: 126 }, { width: 1200, height: 630 }, { x: 700, y: 450 });
  assert.deepEqual(landed, { x: 100, y: 135, width: 1200, height: 630 });
});

test('应用接收图片后不生成桌面大贴图', () => {
  assert.equal(resolveDropRect({ x: 100, y: 120, width: 240, height: 126 }, { width: 1200, height: 630 }, { x: 700, y: 450 }, { target: 'application' }), null);
});

test('原图点击不缩小，拖动超过 4px 才以鼠标为中心收成小图', () => {
  const original = { x: 100, y: 100, width: 1200, height: 630 }, start = { x: 600, y: 400 }, size = { width: 240, height: 126 };
  assert.deepEqual(regrabPreviewRect(original, start, { x: 602, y: 401 }, size), original);
  assert.deepEqual(regrabPreviewRect(original, start, { x: 700, y: 450 }, size), { x: 580, y: 387, width: 240, height: 126 });
  assert.equal(original.width, 1200);
});

test('挂回跟随鼠标位置与实际绳弧，进入和退出使用不同范围', () => {
  const rope = [{ x: 24, y: 32 }, { x: 400, y: 74 }, { x: 780, y: 32 }];
  assert.deepEqual(snapToRope({ x: 400, y: 130 }, rope), { x: 400, y: 74 });
  assert.equal(snapToRope({ x: 400, y: 150 }, rope), null);
  assert.deepEqual(snapToRope({ x: 400, y: 150 }, rope, true), { x: 400, y: 74 });
  assert.equal(snapToRope({ x: 400, y: 175 }, rope, true), null);
  assert.equal(snapToRope({ x: 900, y: 32 }, rope), null);
  assert.equal(snapToRope({ x: 400, y: 400 }, rope), null);
});
