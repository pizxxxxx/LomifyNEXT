import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { writable, readable, derived, get } from 'svelte/store';

async function setup({ failWrite = false, lastfm = false } = {}) {
  const original = JSON.stringify({ searchSource: 'yandex', yandexToken: 'fake-old-yandex', volume: 0.6 });
  const storage = new Map([['lomifynext_settings', original]]);
  if (lastfm) storage.set('lomifynext_lastfm_session', JSON.stringify({ apiKey: 'public', username: 'listener', sharedSecret: 'fake-lastfm-secret', sessionKey: 'fake-lastfm-session' }));
  const vault = new Map();
  const calls = [];
  const network = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  window.localStorage = localStorage;
  window.__TAURI_INTERNALS__ = {};
  const context = vm.createContext({ window, document, localStorage, Event, CustomEvent, navigator: { hardwareConcurrency: 8 }, console: { error() {}, warn() {} }, setTimeout: () => 1, clearTimeout() {} });
  const modules = new Map();
  const synthetic = (name, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context, identifier: name });
  modules.set('svelte/store', synthetic('svelte/store', { writable, readable, derived, get }));
  modules.set('md5', synthetic('md5', { default: () => 'fake-hash' }));
  modules.set('@tauri-apps/plugin-http', synthetic('@tauri-apps/plugin-http', {
    fetch: async (url, init) => { network.push({ url, init }); return { ok: true, status: 200, text: async () => '{"result":{"safe":true}}' }; }
  }));
  modules.set('$lib/playlistStorage', synthetic('$lib/playlistStorage', { dedupePlaylists: (value) => value, loadPlaylistSnapshot: async () => [], savePlaylistSnapshot: async () => {} }));
  modules.set('@tauri-apps/api/core', synthetic('@tauri-apps/api/core', {
    isTauri: () => true,
    invoke: async (command, args = {}) => {
      calls.push({ command, key: args.key });
      if (command === 'secret_migrate_legacy') return gate;
      if (command === 'secret_save') { if (failWrite) throw new Error('storage refused'); vault.set(args.key, args.value); return; }
      if (command === 'secret_get') { if (args.key.startsWith('lastfm_')) throw new Error('private read forbidden'); return vault.get(args.key) || null; }
      if (command === 'secret_exists') return vault.has(args.key);
      if (command === 'secret_delete') { vault.delete(args.key); return; }
    }
  }));
  async function module(name) {
    if (modules.has(name)) return modules.get(name);
    const file = name.replace(/^\.\//, '');
    const source = await readFile(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const loaded = new vm.SourceTextModule(output, { context, identifier: name });
    modules.set(name, loaded);
    await loaded.link(module);
    return loaded;
  }
  const stores = await module('./stores');
  await stores.evaluate();
  const secrets = (await module('./secretStorage')).namespace;
  stores.namespace.initStore();
  return { stores: stores.namespace, secrets, storage, vault, calls, original, release, network, module };
}

test('startup is single-flight and publishes Yandex credentials before waiting requests resume', async () => {
  const f = await setup();
  const ready = f.secrets.whenSecretsReady();
  assert.equal(ready, f.secrets.whenSecretsReady());
  assert.equal(get(f.stores.settings).yandexToken, '');
  assert.equal(f.storage.get('lomifynext_settings'), f.original);
  let requestedToken = null;
  const request = ready.then(() => { requestedToken = get(f.stores.settings).yandexToken; });
  assert.equal(requestedToken, null);
  f.release();
  await request;
  assert.equal(requestedToken, 'fake-old-yandex');
  assert.ok(!f.storage.get('lomifynext_settings').includes('fake-old-yandex'));
  f.stores.settings.update((value) => ({ ...value, volume: 0.8 }));
  assert.ok(!f.storage.get('lomifynext_settings').includes('yandexToken'));
  assert.equal(f.calls.filter((call) => call.command === 'secret_migrate_legacy').length, 1);
});

test('failed startup migration preserves the token when ordinary settings change', async () => {
  const f = await setup({ failWrite: true });
  f.release();
  await f.secrets.whenSecretsReady();
  assert.equal(get(f.stores.settings).yandexToken, 'fake-old-yandex');
  f.stores.settings.update((value) => ({ ...value, volume: 0.8 }));
  assert.equal(f.storage.get('lomifynext_settings'), f.original);
  assert.ok(f.secrets.secretStartupErrors().length > 0);
});

test('Last.fm migration checks native presence and never returns its secret values to frontend', async () => {
  const f = await setup({ lastfm: true });
  f.release();
  await f.secrets.whenSecretsReady();
  assert.equal(f.secrets.hasSecret('lastfm_session_key'), true);
  assert.equal(f.secrets.cachedSecret('lastfm_shared_secret'), '');
  assert.ok(!f.calls.some((call) => call.command === 'secret_get' && call.key.startsWith('lastfm_')));
  assert.deepEqual(JSON.parse(f.storage.get('lomifynext_lastfm_session')), { apiKey: 'public', username: 'listener' });
  await f.secrets.deleteSecrets(['lastfm_shared_secret', 'lastfm_session_key']);
  assert.equal(f.secrets.hasSecret('lastfm_session_key'), false);
  assert.ok(!f.vault.has('lastfm_shared_secret'));
});

test('the Yandex request transport sends no request before credentials finish loading', async () => {
  const f = await setup();
  const yandex = await f.module('./yandex');
  await yandex.evaluate();
  const request = yandex.namespace.ymJson('https://api.music.yandex.net/account/status', 'fake-manual-yandex');
  await new Promise(setImmediate);
  assert.equal(f.network.length, 0);
  f.release();
  assert.equal((await request).safe, true);
  assert.equal(f.network.length, 1);
});
