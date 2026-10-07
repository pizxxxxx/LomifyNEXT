import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual API function bodies with network dependencies replaced by spies.
const source = fs.readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
const names = ['getTrendingTracks', 'getNewReleases', 'yandexNewReleases'];
const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
function api(searchSource, token, fail = false) {
  const calls = { soundcloud: 0, yandex: 0 };
  const settings = { searchSource, yandexToken: token };
  const fake = source => [{ id: '123', title: 'Fresh', artist: 'Artist', source, duration: 120000 }];
  const soundcloud = async () => { calls.soundcloud++; return fake('soundcloud'); };
  const yandex = async () => { calls.yandex++; if (fail) throw new Error('network'); return fake('yandex'); };
  const taste = { artists: new Map([['artist', 1]]), genres: new Map(), displayNames: new Map(), strength: 12 };
  const globals = { exports: {}, console: { warn() {}, error() {} }, settings, dislikedTracks: [], get: value => value,
    whenSecretsReady: async () => {}, buildTasteProfile: () => taste, chooseTasteSeeds: () => ['1'], topKeys: map => [...map.keys()], normKey: value => String(value || '').toLowerCase(), pickRandom: values => values.slice(0, 1),
    getCachedLastFmTasteArtists: () => [], getCachedLastFmDiscoveryArtists: () => [], getCachedLastFmKnownTracks: () => [], CURATED_ARTIST_POOL: ['Artist'], COLD_START_GENRES: ['Genre'],
    getYandexSimilar: yandex, searchYandex: yandex, fetchRelatedTracks: soundcloud, searchSoundCloud: soundcloud,
    getSoundCloudClientId: async () => { calls.soundcloud++; return 'public'; }, getArtistUserId: async () => '1', safeFetch: async () => ({ ok: true, json: async () => ({ collection: [] }) }),
    yandexArtistProfile: async () => { calls.yandex++; if (fail) throw new Error('network'); return { id: '1', isExactMatch: true }; }, yandexArtistAlbums: async () => [{ albumId: '1', releaseDate: new Date().toISOString() }], yandexAlbumTracks: yandex,
    NEW_RELEASE_WINDOW_MS: 60 * 86400000
  };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, globals);
  return { ...globals.exports, calls };
}
for (const token of ['', 'fake-test-token']) test(`Yandex recommendations never call SoundCloud when ${token ? 'the network fails' : 'no account is connected'}`, async () => {
  const service = api('yandex', token, true);
  assert.equal((await service.getTrendingTracks()).length, 0);
  assert.equal(service.calls.soundcloud, 0);
});
for (const token of ['', 'fake-test-token']) test(`Yandex releases never call SoundCloud when ${token ? 'the network fails' : 'no account is connected'}`, async () => {
  const service = api('yandex', token, true);
  assert.equal((await service.getNewReleases([{ artist: 'Artist' }])).length, 0);
  assert.equal(service.calls.soundcloud, 0);
});
test('successful recommendations and releases use their selected provider', async () => {
  const yandex = api('yandex', 'fake-test-token');
  const recommendations = await yandex.getTrendingTracks(), releases = await yandex.getNewReleases([{ artist: 'Artist' }]);
  assert.ok(recommendations.length > 0 && recommendations.every(track => track.source === 'yandex'));
  assert.ok(releases.length > 0 && releases.every(track => track.source === 'yandex'));
  assert.equal(yandex.calls.soundcloud, 0); assert.ok(yandex.calls.yandex > 0);
  const soundcloud = api('soundcloud', '');
  assert.ok((await soundcloud.getTrendingTracks()).every(track => track.source === 'soundcloud'));
  assert.equal(soundcloud.calls.yandex, 0); assert.ok(soundcloud.calls.soundcloud > 0);
});
