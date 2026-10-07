import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTasteProfile, chooseTasteSeeds } from './tasteProfile.ts';

const now = Date.now(), DAY = 86400000;
const sc = (id, artist, extra = {}) => ({ id, artist, title: `Track ${id}`, source: 'soundcloud', ...extra });

test('recent plays beat old repeat counts without deleting older likes', () => {
  const likes = [sc(1, 'New taste', { likedAt: now }), sc(2, 'Old taste', { likedAt: now - 365 * DAY })];
  const taste = buildTasteProfile(likes, { history: {
    recent: sc(3, 'New taste', { count: 2, lastPlayedAt: now }),
    old: sc(4, 'Old taste', { count: 300, lastPlayedAt: now - 365 * DAY })
  } }, [], [], [], now);
  assert.ok(taste.artists.get('new taste') > taste.artists.get('old taste') * 2);
  assert.equal(taste.seeds.length, 4);
  assert.equal(likes.length, 2);
});

test('seeds include the entire library and anchor recent listening beyond the first sixty', () => {
  const likes = Array.from({ length: 200 }, (_, i) => sc(i + 1, `Artist ${i}`));
  const taste = buildTasteProfile(likes, { history: { last: sc(199, 'Artist 198', { count: 1, lastPlayedAt: now }) } });
  assert.equal(taste.seeds.length, 200);
  const selected = chooseTasteSeeds(taste, 'soundcloud', 5, () => 0.5);
  assert.equal(selected[0], 199);
  assert.equal(new Set(selected).size, 5);
  assert.equal(chooseTasteSeeds(taste, 'yandex', 5).length, 0);
});

test('a huge playlist cannot outweigh explicit current likes', () => {
  const taste = buildTasteProfile([sc(1, 'Current')], null, [{ tracks: Array.from({ length: 500 }, (_, i) => sc(i + 2, 'Old playlist')) }]);
  assert.equal(taste.artists.get('old playlist'), 3);
  assert.ok(taste.artists.get('current') > taste.artists.get('old playlist'));
});

test('legacy libraries retain all seeds and sample multiple artists', () => {
  const taste = buildTasteProfile([sc(1, 'A'), sc(2, 'A'), sc(3, 'B'), sc(4, 'C')]);
  assert.equal(taste.seeds.length, 4);
  assert.deepEqual(chooseTasteSeeds(taste, 'soundcloud', 3, () => 0.5), [1, 3, 4]);
});
