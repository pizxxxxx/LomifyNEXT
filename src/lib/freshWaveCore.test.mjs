import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreshWavePlan, assembleFreshWave, waveTrackKey } from './freshWaveCore.ts';
const day = 86400000, now = Date.UTC(2026, 9, 5);
const song = (id, extra = {}) => ({ id: String(id), artist: `Artist ${id}`, title: `Song ${id}`, source: 'yandex', ...extra });
const input = extra => ({ source: 'yandex', now, likes: [], history: {}, disliked: [], ...extra });
const constant = () => .5;

test('fresh likes and qualified plays outweigh a large old library without dating imports today', () => {
  const old = Array.from({ length: 1000 }, (_, id) => song(id, { likedAt: now - 90 * day }));
  const fresh = song('new', { likedAt: now - 6 * day });
  const played = song('played', { lastPlayedAt: now - 13 * day, count: 2 });
  const plan = createFreshWavePlan(input({ likes: [fresh, ...old, song('undated')], history: { played } }), constant);
  assert.deepEqual(new Set(plan.recent.map(t => t.id)), new Set(['new', 'played']));
  assert.equal(plan.exploration, .1);
  assert.ok(plan.stable.every(t => !['new', 'played'].includes(t.id)));
});

test('absence of recent activity extends to 28 days and then broadens exploration', () => {
  const warm = createFreshWavePlan(input({ likes: [song(1, { likedAt: now - 20 * day })] }), constant);
  assert.equal(warm.windowDays, 28); assert.equal(warm.exploration, .2);
  const stale = createFreshWavePlan(input({ likes: [song(2, { likedAt: now - 90 * day }), song(3)] }), constant);
  assert.equal(stale.exploration, .3); assert.equal(stale.windowDays, 0);
  assert.deepEqual(stale.recent.map(t => t.id), ['2']);
  const imported = createFreshWavePlan(input({ likes: [song(3)] }), constant);
  assert.equal(imported.recent.length, 0); assert.equal(imported.stable[0].id, '3');
});

test('a rich catalog meets 70/20/10 and adapts discovery to lack of activity', () => {
  const pool = prefix => Array.from({ length: 40 }, (_, id) => song(`${prefix}${id}`, { group: prefix }));
  const pools = { recent: pool('r'), stable: pool('s'), discover: pool('d') };
  for (const [exploration, expected] of [[.1, [14, 4, 2]], [.2, [12, 4, 4]], [.3, [10, 4, 6]]]) {
    const result = assembleFreshWave(pools, input(), exploration, undefined, undefined, 20, constant);
    assert.deepEqual(['r', 's', 'd'].map(kind => result.filter(t => t.group === kind).length), expected);
  }
});

test('selection excludes likes, dislikes, seen tracks, blocked artists and other providers', () => {
  const tracks = [song(1), song(2), song(3), song(4), song(5), song(6, { source: 'soundcloud' }), song(7, { isBanned: true }), song(8, { isLocal: true }), song(9, { isUnavailable: true }), song(10, { artist: 'Artist 1', title: 'Song 1' })];
  const result = assembleFreshWave({ recent: tracks, stable: tracks, discover: tracks }, input({ likes: [song(1)], disliked: [song(2)] }), .1, new Set([waveTrackKey(song(3))]), new Map([['artist 4', 2]]));
  assert.deepEqual(result.map(t => t.id), ['5']);
});

test('thin pools fill missing shares, deduplicate songs and limit artist repetition', () => {
  const tracks = Array.from({ length: 30 }, (_, id) => song(id, { artist: `Artist ${id % 3}` }));
  const result = assembleFreshWave({ recent: tracks, stable: [], discover: [] }, input(), .1);
  assert.equal(result.length, 9);
  assert.equal(new Set(result.map(waveTrackKey)).size, result.length);
  assert.ok(result.every((track, index) => !index || track.artist !== result[index - 1].artist));
});
