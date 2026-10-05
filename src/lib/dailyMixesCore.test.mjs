import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyMixes, dailyReleaseArtists, localMixDay, mixTrackIdentity } from './dailyMixesCore.ts';

const now = new Date(2026, 9, 5, 12).getTime();
const day = localMixDay(now);
const track = (id, overrides = {}) => ({ id: String(id), title: `Song ${id}`, artist: `Artist ${id % 7}`, source: 'soundcloud', coverUrl: 'https://example.test/cover.jpg', likedAt: now, ...overrides });
const input = (overrides = {}) => ({ day, now, source: 'soundcloud', account: 'listener', likes: [], history: {}, playlists: [], disliked: [], recommendations: [], recommendationsDay: day, releases: [], releasesDay: day, ...overrides });
const mix = (snapshot, kind) => snapshot.mixes.find(item => item.kind === kind);
const ids = (snapshot, kind) => mix(snapshot, kind).tracks.map(mixTrackIdentity);

test('daily selection stays stable after restart and changes on the next local day', () => {
  const request = input({ likes: Array.from({ length: 120 }, (_, id) => track(id)) });
  const first = buildDailyMixes(request);
  assert.equal(mix(first, 'favorites').tracks.length, 30);
  const restarted = buildDailyMixes({ ...request, likes: [...request.likes].reverse(), now: now + 60_000 }, JSON.parse(JSON.stringify(first)));
  assert.deepEqual(ids(restarted, 'favorites'), ids(first, 'favorites'));
  const next = buildDailyMixes({ ...request, day: localMixDay(now + 86_400_000), now: now + 86_400_000 }, first);
  assert.notDeepEqual(ids(next, 'favorites'), ids(first, 'favorites'));
});

test('local day uses the device calendar and rolls over at local midnight', () => {
  assert.equal(localMixDay(new Date(2026, 9, 5, 0, 0, 0).getTime()), '2026-10-05');
  assert.equal(localMixDay(new Date(2026, 9, 4, 23, 59, 59).getTime()), '2026-10-04');
});

test('discoveries exclude familiar, disliked, duplicate and wrong-provider tracks', () => {
  const a = track(1), b = track(2), c = track(3), d = track(4), fresh = track(5);
  const snapshot = buildDailyMixes(input({ likes: [a], history: { b }, playlists: [{ tracks: [c] }], disliked: [d], recommendations: [{ ...a, title: 'Renamed by service' }, b, c, d, fresh, { ...fresh, id: 'duplicate' }, track(6, { source: 'yandex' }), track(7, { isLocal: true })] }));
  assert.deepEqual(ids(snapshot, 'discover'), ['soundcloud:5']);
});

test('playing and saving today\'s discovery does not reshuffle or empty its card', () => {
  const request = input({ recommendations: [track(1), track(2), track(3)] });
  const first = buildDailyMixes(request);
  const tracks = mix(first, 'discover').tracks;
  const afterListening = buildDailyMixes({ ...request, history: { played: { ...tracks[0], lastPlayedAt: now, count: 1 } }, playlists: [{ id: 'daily_saved', tracks }] }, first);
  assert.deepEqual(ids(afterListening, 'discover'), ids(first, 'discover'));
});

test('dislikes immediately remove tracks even from a frozen same-day selection', () => {
  const request = input({ likes: [track(1), track(2)] });
  const first = buildDailyMixes(request);
  assert.deepEqual(ids(buildDailyMixes({ ...request, disliked: [track(1)] }, first), 'favorites'), ['soundcloud:2']);
});

test('offline refresh preserves older network mixes and their actual date', () => {
  const first = buildDailyMixes(input({ recommendations: [track(1)], releases: [track(2, { releaseDate: '2026-10-01' })] }));
  const tomorrow = input({ day: '2026-10-06', now: now + 86_400_000, recommendationsDay: day, releasesDay: day });
  const offline = buildDailyMixes(tomorrow, first, true);
  assert.equal(mix(offline, 'discover').day, day);
  assert.equal(mix(offline, 'releases').day, day);
  assert.deepEqual(ids(offline, 'discover'), ['soundcloud:1']);
  const online = buildDailyMixes({ ...tomorrow, recommendations: [track(9)], recommendationsDay: tomorrow.day }, offline);
  assert.equal(mix(online, 'discover').day, tomorrow.day);
  assert.deepEqual(ids(online, 'discover'), ['soundcloud:9']);
});

test('a new account or provider cannot reuse another account\'s cached tracks', () => {
  const first = buildDailyMixes(input({ likes: [track(1)] }));
  const switched = buildDailyMixes(input({ account: 'someone-else' }), first);
  assert.equal(mix(switched, 'favorites').tracks.length, 0);
  assert.notEqual(switched.context, first.context);
  assert.equal(mix(buildDailyMixes(input({ source: 'yandex' }), first), 'favorites').tracks.length, 0);
});

test('repeat uses recent history, hydrates old metadata and ignores ancient plays', () => {
  const recent = track(1), ancient = track(2);
  const history = {
    recent: { title: recent.title, artist: recent.artist, count: 3, lastPlayedAt: now },
    ancient: { ...ancient, count: 10000, lastPlayedAt: now - 180 * 86_400_000 }
  };
  const snapshot = buildDailyMixes(input({ likes: [recent, ancient], history }));
  assert.deepEqual(ids(snapshot, 'repeat'), ['soundcloud:1']);
});

test('release selection rejects missing, ancient and distant future dates', () => {
  const snapshot = buildDailyMixes(input({ releases: [track(1, { releaseDate: '2026-10-01' }), track(2, { releaseDate: '2020-01-01' }), track(3), track(4, { releaseDate: '2028-01-01' })] }));
  assert.deepEqual(ids(snapshot, 'releases'), ['soundcloud:1']);
});

test('mix snapshots whitelist metadata and never persist signed playback URLs', () => {
  const snapshot = buildDailyMixes(input({ likes: [track(1, { audioUrl: 'https://example.test/audio?token=fake', transcodings: ['private-stream'], accessToken: 'fake-secret', cookie: 'fake-cookie', coverUrl: 'https://example.test/cover?token=fake&client_id=public' })] }));
  const result = mix(snapshot, 'favorites').tracks[0];
  assert.equal(result.audioUrl, '');
  assert.equal(new URL(result.coverUrl).searchParams.get('client_id'), 'public');
  assert.equal(new URL(result.coverUrl).searchParams.has('token'), false);
  assert.ok(!JSON.stringify(snapshot).includes('fake'));
  assert.ok(!('transcodings' in result));
});

test('corrupt cached track arrays are rebuilt rather than crashing the home page', () => {
  const request = input({ likes: [track(1)] });
  const first = buildDailyMixes(request);
  first.mixes[0].tracks = { broken: true };
  first.mixes.push(null);
  assert.deepEqual(ids(buildDailyMixes(request, first), 'favorites'), ['soundcloud:1']);
});

test('new-release artists follow recent listening instead of a large ancient play count', () => {
  const names = dailyReleaseArtists([], {
    fresh: track(1, { artist: 'Recent artist', count: 10, lastPlayedAt: now }),
    ancient: track(2, { artist: 'Ancient artist', count: 100000, lastPlayedAt: now - 365 * 86_400_000 }),
    other: track(3, { artist: 'Wrong provider', source: 'yandex', count: 1000, lastPlayedAt: now })
  }, 'soundcloud', now);
  assert.equal(names[0], 'Recent artist');
  assert.ok(!names.includes('Wrong provider'));
});
