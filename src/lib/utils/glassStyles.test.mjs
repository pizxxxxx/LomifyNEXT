import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optimize } from '@tailwindcss/node';

test('production CSS retains Chromium backdrop filters for every player quality', () => {
  const source = readFileSync(new URL('../../design-liquid-glass.css', import.meta.url), 'utf8');
  const compiled = optimize(source, { minify: true }).code;
  const rules = [...compiled.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector, declarations]) => selector.includes('.lg-player:before') && declarations.includes('backdrop-filter'));
  assert.equal(rules.length, 3, 'normal, high and off styles must reach the production bundle');
  for (const [, selector, declarations] of rules) {
    assert.match(declarations, /(?:^|;)backdrop-filter:/, `Chromium ignores a WebKit-only declaration: ${selector}`);
  }
  assert.match(rules.find(([ , selector]) => selector.includes('data-glass-quality=off'))[2], /(?:^|;)backdrop-filter:none/);
  assert.doesNotMatch(rules.find(([, selector]) => !selector.includes('data-glass-quality='))[2], /--lg-refraction|url\(/, 'ordinary quality must not run the SVG displacement pass');
  assert.match(rules.find(([, selector]) => selector.includes('data-glass-quality=high'))[2], /--lg-refraction/, 'high quality retains real refraction');
});

test('production Wave tuning retains the single optical layer instead of a nested blur', () => {
  const source = readFileSync(new URL('../../design-liquid-glass.css', import.meta.url), 'utf8');
  const compiled = optimize(source, { minify: true }).code;
  const root = [...compiled.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selector, declarations]) => selector.includes('.wave-tune-pop') && declarations.includes('backdrop-filter'));
  assert(root, 'Wave tuning must override the legacy component blur');
  assert.match(root[2], /(?:^|;)backdrop-filter:none/, 'Chromium must disable the root blur while the optical pseudo-element refracts');
});
