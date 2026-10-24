import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { writable, get } from 'svelte/store';

const plain = value => JSON.parse(JSON.stringify(value));
const seed = (id = 'one') => ({ id, title: 'Example Song', artists: ['Example Artist'], durationMs: 180000, externalUrl: `https://music.apple.com/ru/song/example/${id}` });
const collection = (tracks, origin = 'apple-music', id = 'playlist') => ({ id, kind: 'playlist', name: 'Imported', origin, tracks });
const match = { id: 'sc:1', source: 'soundcloud', title: 'Example Song', artist: 'Example Artist', duration: 180000 };

async function setup({ search = async () => [match], flush = async () => {}, hydrate = Promise.resolve() } = {}) {
  const calls = [], events = [];
  const stores = { settings: writable({ yandexToken: '' }), likedTracks: writable([]), playlists: writable([]), playlistsReady: hydrate,
    flushPlaylistStorage: async () => { events.push('flush'); await flush(); events.push('saved'); } };
  const context = vm.createContext({ console, DOMException, AbortController, setTimeout, clearTimeout });
  const modules = new Map();
  const synthetic = (name, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context, identifier: name });
  modules.set('svelte/store', synthetic('svelte/store', { get }));
  modules.set('./stores', synthetic('./stores', stores));
  modules.set('./secretStorage', synthetic('./secretStorage', { whenSecretsReady: async () => {} }));
  modules.set('./api', synthetic('./api', { searchSoundCloud: async (query, limit, strict, signal) => { calls.push({ query, signal }); return search(signal); } }));
  modules.set('./yandex', synthetic('./yandex', { searchYandex: async () => [] }));
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const code = await readFile(new URL(`../src/lib/${name.slice(2)}.ts`, import.meta.url), 'utf8');
    const source = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const module = new vm.SourceTextModule(source, { context, identifier: name });
    modules.set(name, module);
    await module.link(load);
    return module;
  }
  const module = await load('./musicImport');
  await module.evaluate();
  return { ...stores, calls, events, run: (values, signal) => module.namespace.importMusicCollections(values, progress => events.push(progress.phase), signal) };
}

test('done waits for durable storage; reimport keeps intentional occurrences and local additions', async () => {
  let saved;
  const pending = new Promise(resolve => { saved = resolve; });
  const fixture = await setup({ flush: () => pending });
  const run = fixture.run([collection([seed(), seed()])]);
  while (!fixture.events.includes('flush')) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fixture.events.includes('done'), false);
  saved();
  const result = await run;
  assert.equal(result.playlistsImported, 1);
  assert.deepEqual(fixture.events.slice(-2), ['saved', 'done']);
  assert.equal(get(fixture.playlists)[0].tracks.length, 2);
  fixture.playlists.update(values => [{ ...values[0], tracks: [...values[0].tracks, { ...match, id: 'manual' }] }]);
  await fixture.run([collection([seed(), seed()])]);
  assert.deepEqual(plain(get(fixture.playlists)[0].tracks).map(track => track.id), ['sc:1', 'sc:1', 'manual']);
});

test('shared lookup cache never copies the wrong provider import ID or URL', async () => {
  const fixture = await setup();
  await fixture.run([collection([seed('apple-id')]), collection([seed('spotify-id')], 'spotify', 'spotify-playlist')]);
  assert.equal(fixture.calls.length, 1);
  const playlists = get(fixture.playlists);
  assert.equal(playlists[0].tracks[0].appleMusicId, 'apple-id');
  assert.equal(playlists[1].tracks[0].spotifyId, 'spotify-id');
  assert.equal(playlists[1].tracks[0].importSourceUrl.endsWith('spotify-id'), true);
});

test('abort reaches in-flight searches and changes no library state', async () => {
  const fixture = await setup({ search: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })) });
  const controller = new AbortController();
  const run = fixture.run([collection([seed()])], controller.signal);
  while (!fixture.calls.length) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(fixture.calls[0].signal.aborted, true);
  assert.deepEqual(plain(get(fixture.playlists)), []);
  assert.deepEqual(fixture.events.filter(value => ['saving', 'done', 'flush'].includes(value)), []);
});

test('storage failure is surfaced without reporting done', async () => {
  const fixture = await setup({ flush: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(fixture.run([collection([seed()])]), /disk unavailable/);
  assert.equal(fixture.events.includes('done'), false);
});

test('no matches yields a usable missing-track report and no empty playlists', async () => {
  const fixture = await setup({ search: async () => [] });
  const result = await fixture.run([collection([seed('a'), seed('b')])]);
  assert.deepEqual(plain(result.unmatched).map(track => track.id), ['a', 'b']);
  assert.equal(result.playlistsImported, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(plain(get(fixture.playlists)), []);
});

test('import waits for playlist hydration instead of overwriting stored playlists', async () => {
  let hydrate;
  const ready = new Promise(resolve => { hydrate = resolve; });
  const fixture = await setup({ hydrate: ready });
  const run = fixture.run([collection([seed()])]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fixture.calls.length, 0);
  fixture.playlists.set([{ id: 'already-stored', title: 'Old', tracks: [] }]);
  hydrate(); await run;
  assert.equal(get(fixture.playlists).some(playlist => playlist.id === 'already-stored'), true);
});
