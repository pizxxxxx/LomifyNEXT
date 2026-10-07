import test from 'node:test';
import assert from 'node:assert/strict';
import { glassPaletteFromPixels, DEFAULT_GLASS_PALETTE } from './glassPalette.ts';
import { rgbToHsl } from './coverAccent.ts';
const pixels = (...colours) => new Uint8ClampedArray(colours.flatMap(c => Array.from({ length: 40 }, () => [...c, 255]).flat()));
const rgb = hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const luminance = hex => {
  const c = Object.values(rgb(hex)).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
};
test('red artwork produces a pastel peach accent with AA button contrast', () => {
  const palette = glassPaletteFromPixels(pixels([195, 20, 30], [100, 9, 18]));
  const [h, s, l] = rgbToHsl(rgb(palette.accent));
  assert.ok(h < .09 || h > .9);
  assert.ok(s <= .54 && l >= .7 && l <= .82);
  assert.ok((luminance(palette.accent) + .05) / (luminance('#161218') + .05) >= 4.5);
});
test('all accent hues remain readable for dark button text', () => {
  for (const c of [[240, 220, 80], [10, 140, 250], [60, 220, 80], [180, 20, 240]]) {
    const palette = glassPaletteFromPixels(pixels(c));
    assert.ok((luminance(palette.accent) + .05) / (luminance('#161218') + .05) >= 4.5);
  }
});
test('white, grey and transparent sleeves use the neutral fallback', () => {
  assert.deepEqual(glassPaletteFromPixels(pixels([255, 255, 255], [95, 95, 95])), DEFAULT_GLASS_PALETTE);
  assert.deepEqual(glassPaletteFromPixels(new Uint8ClampedArray([255, 0, 0, 0])), DEFAULT_GLASS_PALETTE);
});
test('secondary dominant hue colours the shade independently', () => {
  const palette = glassPaletteFromPixels(pixels([200, 20, 30], [40, 120, 240]));
  assert.notEqual(rgbToHsl(rgb(palette.glow))[0].toFixed(1), rgbToHsl(rgb(palette.shade))[0].toFixed(1));
});
