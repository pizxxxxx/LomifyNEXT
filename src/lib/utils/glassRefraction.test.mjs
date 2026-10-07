import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefractionProfile, lensVector, roundedDistance } from './glassRefraction.ts';
test('flat interior and exterior leave the background unmoved', () => {
  assert.deepEqual(lensVector(400, 32, 800, 64, 24), [0, 0]);
  assert.deepEqual(lensVector(-3, 32, 800, 64, 24), [0, 0]);
  assert(roundedDistance(0, 0, 800, 64, 24) > 0);
});
test('bevels refract in opposite directions with diagonal corner normals', () => {
  const left = lensVector(8, 32, 800, 64, 24), right = lensVector(792, 32, 800, 64, 24);
  assert(left[0] > 0 && right[0] < 0);
  assert(Math.abs(left[0] + right[0]) < 1e-6);
  assert(Math.abs(left[1]) < 1e-6 && Math.abs(right[1]) < 1e-6);
  const corner = lensVector(13, 13, 800, 64, 24);
  assert(corner[0] > 0 && corner[1] > 0);
  assert(Math.hypot(...corner) <= 1);
});
test('optical profile vanishes without a refractive boundary and settles to a flat interior', () => {
  assert.equal(createRefractionProfile(16, 24, 1).maximum, 0);
  const glass = createRefractionProfile();
  assert.equal(glass.samples[0], 0);
  assert.equal(glass.samples.at(-1), 0);
  assert(glass.maximum > 0 && glass.maximum < 24);
  assert(glass.samples.every(value => Number.isFinite(value) && value >= 0));
  const thin = createRefractionProfile(16, 12);
  assert(thin.maximum < glass.maximum);
});
test('bezel samples stay finite and normalized at responsive player sizes', () => {
  for (const [width, height, radius] of [[280, 64, 18], [1500, 67, 18], [24, 24, 12]]) {
    for (let y = 0; y <= height; y += 2) for (let x = 0; x <= width; x += 3) {
      const vector = lensVector(x, y, width, height, radius);
      assert(vector.every(Number.isFinite));
      assert(Math.hypot(...vector) <= 1.000001);
    }
  }
});
