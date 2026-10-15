import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const old = readFileSync(new URL('../clothesline-a-2026-10-12/preview.mjs', import.meta.url), 'utf8');
const wind = old.match(/function fly\([\s\S]*?duration:\s*(\d+)/);
const snapBack = /detached\s*=.*?;\s*cancelDrag\(\);/.test(old);
console.log('旧稿大风时长:', +wind[1], 'ms; 接受拖拽前归位:', snapBack);
assert.ok(+wind[1] >= 800 && !snapBack, '大风漂移至少800ms，取下不得先归位（旧稿预期为红）');
