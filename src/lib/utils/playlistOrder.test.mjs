import test from 'node:test';
import assert from 'node:assert/strict';
import { shufflePlaylist, smartShufflePlaylist, undoPlaylistShuffle } from './playlistOrder.ts';
import { searchPlaylistTracks } from './playlistSearch.ts';

const track = id => ({ id, source: 'soundcloud', title: `Track ${id}`, artist: 'Artist' });
const playlist = (count = 200) => ({ id: 'playlist', title: 'My music', tracks: Array.from({ length: count }, (_, i) => track(i)) });

test('shuffles all 200 tracks without losing, duplicating or mutating any tracks', () => {
  const original = playlist();
  const snapshot = structuredClone(original);
  Object.freeze(original.tracks);
  const shuffled = shufflePlaylist(original, () => 0.25);
  assert.equal(shuffled.tracks.length, 200);
  assert.deepEqual(new Set(shuffled.tracks), new Set(original.tracks));
  assert.notDeepEqual(shuffled.tracks.slice(36), original.tracks.slice(36));
  assert.deepEqual(original, snapshot);
  assert.deepEqual(undoPlaylistShuffle(shuffled), original);
});

test('repeated shuffles and a storage round-trip retain the first original order', () => {
  const original = playlist();
  let shuffled = original;
  for (let i = 0; i < 5; i++) shuffled = shufflePlaylist(shuffled, () => i / 5);
  assert.deepEqual(undoPlaylistShuffle(JSON.parse(JSON.stringify(shuffled))), original);
  assert.equal('shuffleOriginalOrder' in undoPlaylistShuffle(shuffled), false);
});

test('undo preserves edits, skips removed tracks and keeps newly added tracks', () => {
  const original = playlist(5);
  const shuffled = shufflePlaylist(original, () => 0.25);
  shuffled.title = 'Renamed';
  shuffled.tracks = shuffled.tracks.filter(t => t.id !== 2).map(t => ({ ...t, coverUrl: 'updated' }));
  shuffled.tracks.splice(1, 0, track('new'));
  const restored = undoPlaylistShuffle(shuffled);
  assert.deepEqual(restored.tracks.map(t => t.id), [0, 1, 3, 4, 'new']);
  assert.equal(restored.title, 'Renamed');
  assert.equal(restored.tracks[0].coverUrl, 'updated');
  assert.equal(shuffled.tracks.length, restored.tracks.length);
});

test('same IDs across services, duplicate entries and tracks without IDs survive undo', () => {
  const original = {
    id: 'mixed',
    tracks: [track(1), { ...track(1), source: 'yandex' }, track(1),
      { title: 'Same title', artist: 'First' }, { title: 'Same title', artist: 'Second' },
      { source: 'local', url: 'C:/a.mp3' }, { source: 'local', url: 'C:/b.mp3' }]
  };
  const shuffled = shufflePlaylist(original, () => 0);
  assert.deepEqual(undoPlaylistShuffle(structuredClone(shuffled)), original);
});

test('two different tracks always change order, even when random leaves the array unchanged', () => {
  const original = playlist(2);
  assert.deepEqual(shufflePlaylist(original, () => 0.999).tracks, [...original.tracks].reverse());
});

test('empty and single-track playlists are unchanged; undo never revives deleted tracks', () => {
  for (const count of [0, 1]) {
    const original = playlist(count);
    assert.equal(shufflePlaylist(original), original);
    assert.equal(undoPlaylistShuffle(original), original);
  }
  const emptied = { ...shufflePlaylist(playlist(5)), tracks: [] };
  assert.deepEqual(undoPlaylistShuffle(emptied), { id: 'playlist', title: 'My music', tracks: [] });
});

test('smart shuffle separates artists across all 200 tracks and retains the original undo snapshot', () => {
  const original = playlist();
  original.tracks.forEach((t, i) => { t.artist = i < 80 ? 'A' : i < 140 ? 'B' : i < 180 ? 'C' : 'D'; });
  const shuffled = smartShufflePlaylist(shufflePlaylist(original, () => 0.25), () => 0.6);
  assert.equal(shuffled.tracks.length, 200);
  assert.deepEqual(new Set(shuffled.tracks), new Set(original.tracks));
  assert.ok(shuffled.tracks.every((t, i) => i === 0 || t.artist !== shuffled.tracks[i - 1].artist));
  assert.deepEqual(undoPlaylistShuffle(structuredClone(shuffled)), original);
});

test('an unavoidable majority keeps all tracks with the minimum same-artist neighbours', () => {
  const original = playlist(11);
  original.tracks.forEach((t, i) => { t.artist = i < 8 ? 'A' : i < 10 ? 'B' : 'C'; });
  const shuffled = smartShufflePlaylist(original, () => 0.4);
  const repeats = shuffled.tracks.filter((t, i) => i > 0 && t.artist === shuffled.tracks[i - 1].artist).length;
  assert.equal(repeats, 4);
  assert.deepEqual(new Set(shuffled.tracks), new Set(original.tracks));
});

test('smart shuffle accounts for collaborations and normalized artist names', () => {
  const original = { id: 'collaborations', tracks: Array.from({ length: 20 }, (_, i) => ({
    ...track(i), artists: i < 10 ? ['Первый', 'Второй'] : ['Третий'],
    artist: i < 10 ? 'Первый, Второй' : 'Третий'
  })) };
  const shuffled = smartShufflePlaylist(original, () => 0.4);
  assert.ok(shuffled.tracks.every((t, i) => i === 0 || !t.artists.some(name => shuffled.tracks[i - 1].artists.includes(name))));
  const cosmeticNames = { id: 'normalized', tracks: [
    { ...track(1), artist: '  Ёлка  ' }, { ...track(2), artist: 'ЕЛКА' }, { ...track(3), artist: 'Другой' }
  ] };
  assert.equal(smartShufflePlaylist(cosmeticNames, () => 0.5).tracks[1].artist, 'Другой');
});

test('smart shuffle handles short playlists and a single artist without losing or fixing the order', () => {
  for (const count of [0, 1]) {
    const original = playlist(count);
    assert.equal(smartShufflePlaylist(original), original);
  }
  const original = playlist(2);
  assert.deepEqual(smartShufflePlaylist(original, () => 0.999).tracks, [...original.tracks].reverse());
  const unknown = { ...playlist(5), tracks: playlist(5).tracks.map(({ artist, ...t }) => t) };
  assert.deepEqual(undoPlaylistShuffle(smartShufflePlaylist(unknown)), unknown);
});

test('playlist search finds tracks beyond the first rendered batch and preserves source positions', () => {
  const original = playlist();
  const matches = searchPlaylistTracks(original.tracks, 'track 199');
  assert.deepEqual(matches, [{ track: original.tracks[199], index: 199 }]);
  assert.equal(original.tracks.length, 200);
  assert.deepEqual(searchPlaylistTracks(original.tracks, '   ').map(row => row.track), original.tracks);
});

test('playlist search matches title and all artists regardless of case, spacing and ё', () => {
  const tracks = [{ id: 1, title: 'Тёплый вечер', artist: 'Первый', artists: ['Первый', 'Гость'] },
    { id: 2, title: 'Вечер', artist: 'Другой' }];
  assert.deepEqual(searchPlaylistTracks(tracks, '  гОСТЬ   теплый ').map(row => row.index), [0]);
  assert.equal(searchPlaylistTracks(tracks, 'ничего').length, 0);
});
