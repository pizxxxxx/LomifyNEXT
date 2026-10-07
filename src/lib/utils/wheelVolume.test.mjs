import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeAfterWheel } from './wheelVolume.ts';
test('wheel volume has gentle symmetric mouse and trackpad steps', () => {
  assert.equal(volumeAfterWheel(.5, -100, 0), .52);
  assert.equal(volumeAfterWheel(.5, 100, 0), .48);
  assert(Math.abs(volumeAfterWheel(.5, 3, 1) - .476) < 1e-9);
  assert(volumeAfterWheel(.5, 4, 0) > .499);
});
test('wheel volume clamps large deltas and endpoints', () => {
  assert.equal(volumeAfterWheel(.5, 1000, 0), .47);
  assert.equal(volumeAfterWheel(.99, -120, 0), 1);
  assert.equal(volumeAfterWheel(.01, 120, 0), 0);
  assert.equal(volumeAfterWheel(.5, NaN, 0), .5);
});
