import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { writable, get } from 'svelte/store';
const flush = () => new Promise(resolve => setImmediate(resolve));
async function setup(existing = false) {
  const storage = new Map(), intervals = [], calls = [], controls = {};
  const local = { settings: {}, stats: { listenSeconds: 12345, tracksPlayed: 8, history: {} }, likes: [{ id: 'local-song' }], dislikes: [], playlists: [{ id: 'local-list', tracks: [] }], achievements: { hour: 1 } };
  let head = existing ? { revision: 'previous', updateTime: 'old' } : null;
  class Conflict extends Error {}
  class Api {
    async signIn() { if (controls.login) await controls.login; return { uid: 'owner', email: 'owner@example.test', idToken: 'private', refreshToken: 'private', expiresAt: Date.now() + 3600000 }; }
    async head() { return head; }
    async upload(session, backup, previous) {
      calls.push({ kind: 'upload', backup: structuredClone(backup) });
      if (controls.upload) await controls.upload;
      if (previous?.revision !== head?.revision) throw new Conflict('changed');
      return head = { revision: `next-${calls.length}`, updateTime: `time-${calls.length}` };
    }
    async download() { calls.push({ kind: 'download' }); return { data: structuredClone(local) }; }
  }
  const stores = Object.fromEntries(['listenStats','likedTracks','dislikedTracks','playlists','settings','equalizerBands','equalizerProfiles','activeEqualizerPreset','globalVolume','searchHistory'].map(name => [name, writable({})]));
  const context = vm.createContext({ console, Date, structuredClone, setInterval: fn => { intervals.push(fn); return 1; }, clearInterval() {}, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key,value) => storage.set(key,value), removeItem: key => storage.delete(key) } });
  const modules = new Map();
  const stub = (name, values) => modules.set(name, new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context }));
  stub('svelte/store', { writable, get }); stub('@tauri-apps/api/core', { isTauri: () => false, invoke: async () => false });
  stub('./cloudApi', { CloudApi: Api, CloudConflict: Conflict }); stub('./cloudConfig', { CLOUD_CONFIG: { apiKey: 'public', projectId: 'test' }, GOOGLE_DESKTOP_CLIENT_ID: '' });
  stub('./lomiBackup', { captureLomiBackup: async () => ({ data: structuredClone(local) }), saveLomiBackup: async () => true, restoreLomiBackup: async backup => calls.push({ kind: 'restore', backup }), backupRestoreInProgress: () => false });
  stub('./db', { getTracks: async () => [] }); stub('./secretStorage', { getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => {}, whenSecretsReady: async () => {} });
  stub('./stores', stores); stub('./achievements', { achievementUnlocks: writable({}) });
  const source = await readFile(new URL('../src/lib/cloudProfile.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const module = new vm.SourceTextModule(code, { context }); await module.link(name => modules.get(name)); await module.evaluate();
  const runtime = module.namespace, cleanup = runtime.startCloudProfile(); await flush();
  return { runtime, stores, calls, controls, local, intervals, cleanup, replaceHead: value => { head = value; } };
}
test('empty account automatically receives existing PC data and turns on autosave after login', async () => {
  const app = await setup(); await app.runtime.cloudSignIn('owner@example.test', 'password');
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].backup.data.stats.listenSeconds, 12345);
  assert.equal(app.calls[0].backup.data.likes[0].id, 'local-song');
  assert.equal(get(app.runtime.cloudProfile).auto, true); assert.equal(get(app.runtime.cloudProfile).accepted, true); app.cleanup();
});
test('account with existing cloud data cannot overwrite either side at login or when autosave is toggled', async () => {
  const app = await setup(true); await app.runtime.cloudSignIn('owner@example.test', 'password');
  assert.equal(app.calls.length, 0); app.runtime.cloudSetAuto(true); assert.equal(get(app.runtime.cloudProfile).auto, false);
  await app.runtime.cloudUpload(); assert.equal(app.calls.length, 0);
  await app.runtime.cloudUpload(true); assert.equal(app.calls.length, 1); assert.equal(get(app.runtime.cloudProfile).auto, true); app.cleanup();
});
test('dirty changes arriving while upload is in flight remain eligible for the next autosave', async () => {
  const app = await setup(); let finishUpload;
  app.controls.upload = new Promise(resolve => finishUpload = resolve);
  const login = app.runtime.cloudSignIn('owner@example.test', 'password'); await flush();
  app.stores.listenStats.set({ listenSeconds: 12346 }); finishUpload(); await login;
  app.controls.upload = null; app.intervals[0](); await flush();
  assert.equal(app.calls.length, 2); app.cleanup();
});
test('skipping first-run login ignores a late authorization response without uploading PC data', async () => {
  const app = await setup(); let finishLogin;
  app.controls.login = new Promise(resolve => finishLogin = resolve);
  const pending = app.runtime.cloudSignIn('owner@example.test', 'password'); await flush();
  app.runtime.cancelPendingCloudSignIn(); finishLogin(); await pending;
  assert.equal(get(app.runtime.cloudProfile).email, ''); assert.equal(get(app.runtime.cloudProfile).busy, false); assert.equal(app.calls.length, 0); app.cleanup();
});
test('remote conflict pauses autosave instead of silently replacing the newer profile', async () => {
  const app = await setup(); await app.runtime.cloudSignIn('owner@example.test', 'password');
  app.replaceHead({ revision: 'another-device', updateTime: 'newer' }); app.stores.likedTracks.set([{ id: 'new-like' }]);
  app.intervals[0](); await flush();
  assert.equal(get(app.runtime.cloudProfile).conflict, true); assert.equal(get(app.runtime.cloudProfile).auto, false); app.cleanup();
});
