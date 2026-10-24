import test from 'node:test';
import assert from 'node:assert/strict';
import { appleMusicCollectionsFromPlist, parseAppleMusicPlaylistPage, parseAppleMusicPlaylistUrl } from './appleMusicImportCore.ts';
import { bestImportMatch, normalizeImportText } from './musicImportMatching.ts';

const seed = { title: 'Example Song', artists: ['Example Artist'], durationMs: 180000 };
const candidate = (title = seed.title, duration = 180000, artist = 'Example Artist') => ({ id: 'sc:1', source: 'soundcloud', title, artist, duration });
const url = 'https://music.apple.com/ru/playlist/example/pl.test123';
function page({ count = 2, metadata = true, identity = 'pl.test123', duplicate = false } = {}) {
  const songs = [1, duplicate ? 1 : 2].map(id => ({ '@type': 'MusicRecording', name: `Song ${id}`, url: `https://music.apple.com/ru/song/example/${id}`, duration: 'PT3M0S' }));
  const schema = { '@type': 'MusicPlaylist', name: 'My Apple playlist', numTracks: count, track: songs, url };
  const server = { userTokenHash: 'MUST-NOT-BE-SAVED', data: [{ intent: { contentDescriptor: { identifiers: { storeAdamID: identity } } }, data: { sections: [{ items: metadata ? [1, 2].map(id => ({
    title: `Song ${id}`, duration: 180000, subtitleLinks: [{ title: 'Artist A' }, { title: 'Artist B' }], contentDescriptor: { kind: 'song', identifiers: { storeAdamID: String(id) } }, secret: 'NOT-METADATA'
  })) : [] }] } }] };
  return `<script type="application/ld+json">${JSON.stringify(schema)}</script><script type="application/json" id=serialized-server-data>${JSON.stringify(server)}</script>`;
}

test('matching keeps original recordings and rejects altered editions and gross duration mismatches', () => {
  assert.equal(bestImportMatch(seed, [candidate()]).title, seed.title);
  for (const edition of ['Remix', 'Live', 'Acoustic', 'Sped Up', 'Slowed', 'Instrumental', 'Karaoke', 'Cover', 'AI', 'Clean', 'Explicit', 'Radio Edit', 'Extended']) {
    assert.equal(bestImportMatch(seed, [candidate(`${seed.title} (${edition})`)]), null, edition);
  }
  assert.equal(bestImportMatch(seed, [candidate(seed.title, 60000)]), null);
  assert.equal(bestImportMatch(seed, [candidate(seed.title, 180000, 'Unrelated Person')]), null);
  assert.equal(bestImportMatch(seed, [candidate(seed.title, 180000, 'Example Artist AI Cover')]), null);
});

test('explicitly requested editions remain eligible; live in a song name is not enough to accept a live recording', () => {
  const remix = { ...seed, title: 'Example Song (Remix)' };
  assert.equal(bestImportMatch(remix, [candidate(), candidate(remix.title)]).title, remix.title);
  const liveName = { ...seed, title: 'Live Forever' };
  assert.equal(bestImportMatch(liveName, [candidate('Live Forever (Live)')]), null);
  assert.ok(bestImportMatch(liveName, [candidate('Live Forever')]));
  assert.equal(normalizeImportText('Beyoncé 한국어 Ёлка'), 'beyonce 한국어 елка');
});

test('missing duration only permits an exact title and strong artist match', () => {
  assert.ok(bestImportMatch({ ...seed, durationMs: 0 }, [candidate()]));
  assert.equal(bestImportMatch({ ...seed, durationMs: 0 }, [candidate('Example Song Official Audio')]), null);
});

test('playlist links are restricted to public HTTPS Apple playlist pages and strip tracking data', () => {
  assert.deepEqual(parseAppleMusicPlaylistUrl(`${url}?l=ru&anything=private#ignored`), { url, id: 'pl.test123' });
  for (const value of ['http://music.apple.com/ru/playlist/pl.test', 'https://music.apple.com.evil.test/ru/playlist/pl.test', 'https://user@music.apple.com/ru/playlist/pl.test', 'https://music.apple.com:444/ru/playlist/pl.test', 'https://music.apple.com/ru/album/title/123', 'https://music.apple.com/ru/playlist/../../foo']) {
    assert.throws(() => parseAppleMusicPlaylistUrl(value), value);
  }
});

test('public playlist metadata retains collaborators, order and occurrences without page/account data', () => {
  const collection = parseAppleMusicPlaylistPage(page({ duplicate: true }), url);
  assert.equal(collection.origin, 'apple-music');
  assert.deepEqual(collection.tracks.map(track => track.id), ['1', '1']);
  assert.deepEqual(collection.tracks[0].artists, ['Artist A', 'Artist B']);
  assert.equal(collection.tracks[0].durationMs, 180000);
  assert.equal(JSON.stringify(collection).includes('MUST-NOT-BE-SAVED'), false);
  assert.equal(JSON.stringify(collection).includes('NOT-METADATA'), false);
});

test('partial, malformed, wrong-playlist and artistless public responses cannot become successful imports', () => {
  for (const html of [page({ count: 100 }), page({ metadata: false }), page({ identity: 'pl.different' }), '<script type="application/ld+json">invalid</script>']) {
    assert.throws(() => parseAppleMusicPlaylistPage(html, url));
  }
});

const plist = () => ({ Tracks: {
  '1': { 'Track ID': 1, Name: 'Song A', Artist: 'Artist A', 'Total Time': 180000, Loved: true, Location: 'file:///private/folder/song.m4a' },
  '2': { 'Track ID': 2, Name: 'Song B', Artist: 'Artist B', 'Total Time': 240000 },
  '3': { 'Track ID': 3, Name: 'Untitled', Location: 'private' }
}, Playlists: [{ Name: 'Playlist A', 'Playlist Persistent ID': 'AAAA', 'Playlist Items': [{ 'Track ID': 2 }, { 'Track ID': 1 }, { 'Track ID': 2 }, { 'Track ID': 3 }] }] });

test('XML metadata mapping keeps order/repeats, reports unreadable rows and never imports local paths', () => {
  const collections = appleMusicCollectionsFromPlist(plist(), 'Library.xml');
  assert.deepEqual(collections[0].tracks.map(track => track.title), ['Song B', 'Song A', 'Song B']);
  assert.equal(collections[0].sourceSkipped, 1);
  assert.equal(collections[1].kind, 'liked');
  assert.equal(collections[1].tracks.length, 1);
  assert.equal(JSON.stringify(collections).includes('private'), false);
  assert.equal(appleMusicCollectionsFromPlist(plist(), 'Library.xml')[0].id, collections[0].id);
});

test('empty exported playlists cannot accidentally import the whole library', () => {
  const value = plist();
  value.Tracks['1'].Loved = false;
  value.Playlists[0]['Playlist Items'] = [];
  assert.throws(() => appleMusicCollectionsFromPlist(value, 'Empty.xml'));
  delete value.Playlists;
  assert.equal(appleMusicCollectionsFromPlist(value, 'Library.xml')[0].tracks.length, 2);
});
