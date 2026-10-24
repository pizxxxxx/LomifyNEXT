import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { writable, readable, derived, get } from 'svelte/store';
const plain = value => JSON.parse(JSON.stringify(value));
const song = (id, extra = {}) => ({ id, title: id, artist: 'Артист', coverUrl: '', audioUrl: '', source: 'yandex', ...extra });
async function setup() {
  const storage = new Map(), faults = { storage: '', local: false, playlists: false }, timers = new Set();
  let diskTracks = [song('original-local', { audioUrl: 'C:\\Music\\old.flac', isLocal: true, deviceOnlyMetadata: 'keep' })];
  let diskPlaylists = [{ id: 'original-list', title: 'Старый', accountOnlyMetadata: 'keep', tracks: [song('old')] }];
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { if (faults.storage === key) { faults.storage = ''; throw new Error('quota'); } storage.set(key, value); },
    removeItem: key => storage.delete(key)
  };
  const window = new EventTarget(), document = new EventTarget(); document.visibilityState = 'visible';
  const context = vm.createContext({ window, document, localStorage, TextEncoder, URL, Date, Event, console,
    navigator: { hardwareConcurrency: 8 }, setTimeout: () => { const id = {}; timers.add(id); return id; }, clearTimeout: id => timers.delete(id) });
  const modules = new Map();
  function stub(name, values) { modules.set(name, new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context, identifier: name })); }
  stub('svelte/store', { writable, readable, derived, get });
  stub('@tauri-apps/api/core', { isTauri: () => false, invoke: async () => {} });
  stub('./secretStorage', { cachedSecret: () => '', publicSettings: value => { const { yandexToken, ...rest } = value; return rest; }, secretStartupErrors: () => [], settingsSecretsRemoved: () => true, whenSecretsReady: async () => {}, SECRETS_READY_EVENT: 'secrets-ready' });
  stub('$lib/playlistStorage', { dedupePlaylists: value => value, loadPlaylistSnapshot: async () => diskPlaylists, savePlaylistSnapshot: async value => {
    if (faults.playlists && value.some(list => list.id === 'new-list')) { faults.playlists = false; throw new Error('playlist disk unavailable'); }
    diskPlaylists = value;
  } });
  stub('./db', { getTracks: async () => diskTracks, replaceTracks: async value => { if (faults.local) { faults.local = false; throw new Error('local disk unavailable'); } diskTracks = value; } });
  stub('./likes', { settleLikesSync: async () => {} }); stub('./playlistSync', { settlePlaylistSync: async () => {} });
  const pending = new Map();
  async function construct(name) {
    if (modules.has(name)) return modules.get(name);
    const source = await readFile(new URL(`../src/lib/${name.replace(/^\.\//, '')}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: name, importModuleDynamically: async specifier => { const result = await load(specifier); if (result.status === 'unlinked') await result.link(load); if (result.status === 'linked') await result.evaluate(); return result; } });
    modules.set(name, module); return module;
  }
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    if (!pending.has(name)) pending.set(name, construct(name));
    return pending.get(name);
  }
  const root = await load('./lomiBackup'); await root.link(load); await root.evaluate();
  const stores = modules.get('./stores').namespace, badges = modules.get('./achievements').namespace;
  stores.initStore(); await stores.playlistsReady; await Promise.resolve();
  stores.likedTracks.set([song('old-like', { accountOnlyMetadata: 'keep' })]);
  stores.listenStats.set({ listenSeconds: 7200, tracksPlayed: 1, history: { old: { ...song('old'), count: 1, extraMetadata: 'keep' } } });
  badges.achievementUnlocks.set({ hour: 1 });
  storage.set('lomifynext_achievements', JSON.stringify({ hour: 1 }));
  await stores.flushPlaylistStorage(); stores.flushListenStats();
  const input = modules.get('./lomiBackupCore').namespace.createLomiBackup({
    settings: { design: 'liquid-glass', glassMaterial: 'matte', mattePalette: 'black-red' },
    stats: { listenSeconds: 36000, tracksPlayed: 9, history: {} }, likes: [song('new-like')], dislikes: [],
    playlists: [{ id: 'new-list', title: 'Новый', tracks: [song('new')] }], localTracks: [song('new-local', { isLocal: true, audioUrl: 'C:\\Music\\new.flac' })],
    equalizer: { bands: Array(10).fill(1), preset: 'custom', profiles: [] }, searchHistory: ['Новый'], achievements: { hour: 1, 'ten-hours': 2 }, volume: .2
  }, '9.6.3');
  return { runtime: root.namespace, stores, badges, input, storage, faults, disk: () => ({ tracks: plain(diskTracks), playlists: plain(diskPlaylists) }) };
}
test('restore publishes and persists all library parts and pauses remote synchronization', async () => {
  const app = await setup(); await app.runtime.restoreLomiBackup(app.input);
  assert.equal(get(app.stores.likedTracks)[0].id, 'new-like'); assert.equal(get(app.stores.listenStats).listenSeconds, 36000);
  assert.equal(get(app.stores.settings).glassMaterial, 'matte'); assert.equal(get(app.stores.settings).syncPlatformsLikes, false);
  assert.equal(app.disk().tracks[0].id, 'new-local'); assert.equal(app.disk().playlists[0].id, 'new-list');
  assert.equal(JSON.parse(app.storage.get('lomifynext_stats')).listenSeconds, 36000); assert.equal(app.runtime.backupRestoreInProgress(), false);
});
for (const boundary of ['storage', 'local', 'playlists']) test(`restore rolls back exact original objects after ${boundary} failure`, async () => {
  const app = await setup(), beforeDisk = app.disk(), beforeLikes = get(app.stores.likedTracks), beforeStats = get(app.stores.listenStats), beforeSettings = get(app.stores.settings);
  if (boundary === 'storage') app.faults.storage = 'lomifynext_stats'; else app.faults[boundary] = true;
  await assert.rejects(app.runtime.restoreLomiBackup(app.input));
  assert.equal(get(app.stores.likedTracks), beforeLikes); assert.equal(get(app.stores.listenStats), beforeStats);
  assert.equal(get(app.stores.settings).syncPlatformsLikes, beforeSettings.syncPlatformsLikes);
  assert.deepEqual(app.disk(), beforeDisk); assert.equal(app.runtime.backupRestoreInProgress(), false);
  assert.equal(JSON.parse(app.storage.get('lomifynext_stats')).listenSeconds, 7200);
});
test('invalid backup cannot pause sync, change stores or write IndexedDB', async () => {
  const app = await setup(), before = app.disk(), settings = get(app.stores.settings);
  await assert.rejects(app.runtime.restoreLomiBackup({ ...app.input, version: 999 }));
  assert.equal(get(app.stores.settings), settings); assert.deepEqual(app.disk(), before);
});
test('achievement startup silently credits existing stats and keeps awarded timestamps after later changes', async () => {
  const app = await setup(), cleanup = app.badges.startAchievements();
  await Promise.resolve();
  assert.equal(get(app.badges.achievementUnlocks).hour, 1);
  app.stores.listenStats.update(value => ({ ...value, listenSeconds: 36000 }));
  assert.ok(get(app.badges.achievementUnlocks)['ten-hours']);
  app.stores.listenStats.update(value => ({ ...value, listenSeconds: 0 }));
  assert.ok(get(app.badges.achievementUnlocks)['ten-hours']); cleanup();
});
