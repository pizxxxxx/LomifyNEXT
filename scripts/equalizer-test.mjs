import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { writable, readable, derived, get } from 'svelte/store';

const KEY = 'lomifynext_equalizer';
const plain = value => JSON.parse(JSON.stringify(value));
const flat = () => Array(10).fill(0);
const custom = () => [1.2, -2.7, 3.4, -4.1, 5, -6, 7.8, -8, 9.9, -10.5];

async function setup(storage = new Map(), options = {}) {
  const writes = [], warnings = [], native = [];
  const faults = { read: false, write: false, ...options };
  const localStorage = {
    getItem(key) { if (faults.read && key === KEY) throw new Error('read unavailable'); return storage.get(key) ?? null; },
    setItem(key, value) { if (faults.write && key === KEY) throw new Error('quota exceeded'); storage.set(key, value); writes.push({ key, value }); },
    removeItem(key) { storage.delete(key); }
  };
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const context = vm.createContext({
    window, document, localStorage, navigator: { hardwareConcurrency: 8 }, crypto: { randomUUID },
    console: { error: (...args) => warnings.push(args), warn: (...args) => warnings.push(args) },
    setTimeout: () => 1, clearTimeout() {}
  });
  const modules = new Map();
  const synthetic = (name, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context, identifier: name });
  modules.set('svelte/store', synthetic('svelte/store', { writable, readable, derived, get }));
  modules.set('./logRedaction', synthetic('./logRedaction', { redactText: value => value }));
  modules.set('./secretStorage', synthetic('./secretStorage', {
    cachedSecret: () => '', publicSettings: value => value, secretStartupErrors: () => [],
    settingsSecretsRemoved: () => true, whenSecretsReady: () => new Promise(() => {}), SECRETS_READY_EVENT: 'secrets-ready'
  }));
  modules.set('$lib/playlistStorage', synthetic('$lib/playlistStorage', {
    dedupePlaylists: value => value, loadPlaylistSnapshot: async () => [], savePlaylistSnapshot: async () => {}
  }));
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const text = await readFile(new URL(`../src/lib/${name.replace(/^\.\//, '')}.ts`, import.meta.url), 'utf8');
    const source = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const module = new vm.SourceTextModule(source, { context, identifier: name });
    modules.set(name, module);
    await module.link(load);
    return module;
  }
  const module = await load('./stores');
  await module.evaluate();
  const stores = module.namespace;
  // Observe the actual Player EQ reactive statement. This covers restoration
  // driving the native command even when Equalizer.svelte is never mounted.
  const player = await readFile(new URL('../src/lib/components/Player.svelte', import.meta.url), 'utf8');
  const script = player.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const ast = ts.createSourceFile('Player.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const effect = ast.statements.find(node => ts.isLabeledStatement(node) && node.label.text === '$' && node.getText(ast).includes("invoke('audio_set_eq'"));
  assert.ok(effect, 'Player must still apply shared EQ gains to the native engine');
  const apply = vm.runInContext(`(function($equalizerBands, invoke) { ${effect.statement.getText(ast)} })`, context);
  stores.equalizerBands.subscribe(bands => apply(bands, async (command, args) => native.push({ command, args: plain(args) })));
  stores.initStore();
  return { stores, storage, writes, faults, native, warnings, eq: modules.get('./equalizer').namespace };
}

test('all built-in presets restore both their gains and label after a fresh app start', async () => {
  const first = await setup();
  for (const preset of first.eq.EQUALIZER_PRESETS) {
    first.stores.equalizerBands.set([...preset.gains]);
    first.stores.activeEqualizerPreset.set(preset.id);
    const restarted = await setup(new Map(first.storage));
    assert.deepEqual(plain(get(restarted.stores.equalizerBands)), plain(preset.gains));
    assert.equal(get(restarted.stores.activeEqualizerPreset), preset.id);
    assert.deepEqual(restarted.native.at(-1), { command: 'audio_set_eq', args: { enabled: true, gains: plain(preset.gains) } });
    assert.deepEqual(JSON.parse(restarted.writes.find(write => write.key === KEY).value).bands, plain(preset.gains), 'hydration must precede the first persistence write');
  }
});

test('manual fractional gains save immediately and reset survives restart without deleting profiles', async () => {
  const first = await setup();
  first.stores.equalizerBands.set(custom());
  first.stores.activeEqualizerPreset.set('custom');
  const saved = first.stores.saveEqualizerProfile('  Мои   наушники  ');
  assert.equal(saved.ok, true);
  const restarted = await setup(new Map(first.storage));
  assert.deepEqual(plain(get(restarted.stores.equalizerBands)), custom());
  assert.equal(get(restarted.stores.equalizerProfiles)[0].name, 'Мои наушники');
  restarted.stores.equalizerBands.set(flat());
  restarted.stores.activeEqualizerPreset.set('flat');
  const reset = await setup(new Map(restarted.storage));
  assert.deepEqual(plain(get(reset.stores.equalizerBands)), flat());
  assert.equal(get(reset.stores.activeEqualizerPreset), 'flat');
  assert.equal(get(reset.stores.equalizerProfiles).length, 1);
});

test('profiles retain independent copies; editing selected sound requires an explicit profile update', async () => {
  const first = await setup();
  first.stores.equalizerBands.set(custom());
  const saved = first.stores.saveEqualizerProfile('Наушники');
  const id = saved.profile.id;
  first.stores.equalizerBands.update(bands => { bands[0] = 8.3; return bands; });
  assert.equal(get(first.stores.equalizerProfiles)[0].gains[0], 1.2);
  const restarted = await setup(new Map(first.storage));
  assert.equal(get(restarted.stores.activeEqualizerPreset), `profile:${id}`);
  assert.equal(get(restarted.stores.equalizerBands)[0], 8.3);
  assert.equal(get(restarted.stores.equalizerProfiles)[0].gains[0], 1.2);
  assert.equal(restarted.stores.updateEqualizerProfile(id), true);
  assert.equal(get(restarted.stores.equalizerProfiles)[0].gains[0], 8.3);
  const updated = await setup(new Map(restarted.storage));
  updated.stores.equalizerBands.set(flat());
  updated.stores.applyEqualizerProfile(id);
  assert.equal(get(updated.stores.equalizerBands)[0], 8.3);
  updated.stores.equalizerBands.update(bands => { bands[1] = 12; return bands; });
  assert.equal(get(updated.stores.equalizerProfiles)[0].gains[1], -2.7);
});

test('profile names reject empty/duplicate entries without overwriting existing sound', async () => {
  const f = await setup();
  assert.equal(f.stores.saveEqualizerProfile('   ').ok, false);
  const original = f.stores.saveEqualizerProfile('Мои наушники');
  f.stores.equalizerBands.set(custom());
  assert.equal(f.stores.saveEqualizerProfile('  МОИ   НАУШНИКИ  ').ok, false);
  assert.equal(get(f.stores.equalizerProfiles).length, 1);
  assert.deepEqual(plain(get(f.stores.equalizerProfiles)[0].gains), flat());
  assert.deepEqual(plain(get(f.stores.equalizerBands)), custom());
  assert.equal(f.stores.applyEqualizerProfile('missing'), false);
  assert.equal(f.stores.updateEqualizerProfile('missing'), false);
  assert.equal(get(f.stores.equalizerProfiles)[0].id, original.profile.id);
});

test('deleting a selected profile preserves current sound and supports undo plus restart', async () => {
  const f = await setup();
  f.stores.equalizerBands.set(custom());
  const first = f.stores.saveEqualizerProfile('Наушники').profile;
  f.stores.equalizerBands.set(flat());
  const second = f.stores.saveEqualizerProfile('Колонки').profile;
  f.stores.applyEqualizerProfile(first.id);
  const removed = f.stores.deleteEqualizerProfile(first.id);
  assert.deepEqual(plain(get(f.stores.equalizerBands)), custom());
  assert.equal(get(f.stores.activeEqualizerPreset), 'custom');
  const deleted = await setup(new Map(f.storage));
  assert.deepEqual(plain(get(deleted.stores.equalizerProfiles)).map(p => p.id), [second.id]);
  assert.equal(deleted.stores.restoreEqualizerProfile(removed), true);
  assert.equal(deleted.stores.restoreEqualizerProfile(removed), false);
  const restored = await setup(new Map(deleted.storage));
  assert.equal(get(restored.stores.equalizerProfiles).length, 2);
  assert.equal(restored.stores.applyEqualizerProfile(first.id), true);
  assert.deepEqual(restored.native.at(-1).args.gains, custom());
});

test('older snapshots and damaged values cannot feed invalid gains into audio or lose valid profiles', async () => {
  const f = await setup();
  const bass = f.eq.EQUALIZER_PRESETS.find(preset => preset.id === 'bass');
  const old = await setup(new Map([[KEY, JSON.stringify({ bands: bass.gains, preset: 'bass' })]]));
  assert.equal(get(old.stores.activeEqualizerPreset), 'bass');
  assert.deepEqual(plain(get(old.stores.equalizerProfiles)), []);
  for (const raw of ['not json', 'null', '42', '{"bands":[1,2]}']) {
    const broken = await setup(new Map([[KEY, raw]]));
    assert.deepEqual(plain(get(broken.stores.equalizerBands)), flat());
  }
  const snapshot = f.eq.normalizeEqualizerState({
    bands: [99, -99, NaN, Infinity, null, '8', 3.5, 0, 0, 0], preset: 'bass',
    profiles: [{ id: 'valid', name: 'Профиль', gains: custom() }, { id: 'valid', name: 'Дубль', gains: flat() }, { id: 'bad', name: '', gains: flat() }]
  });
  assert.deepEqual(plain(snapshot.bands), [12, -12, 0, 0, 0, 0, 3.5, 0, 0, 0]);
  assert.equal(snapshot.preset, 'custom');
  assert.equal(snapshot.profiles.length, 1);
  const badCurrent = f.eq.normalizeEqualizerState({ bands: [], profiles: snapshot.profiles });
  assert.equal(badCurrent.profiles.length, 1);
});

test('read/write failures keep playback usable, report once, and later edits retry persistence', async () => {
  const f = await setup(new Map(), { read: true, write: true });
  assert.equal(get(f.stores.equalizerSaveError), true);
  f.stores.equalizerBands.set(custom());
  f.stores.activeEqualizerPreset.set('custom');
  assert.equal(get(f.stores.notifications).filter(item => item.type === 'error').length, 1);
  assert.deepEqual(f.native.at(-1).args.gains, custom());
  f.faults.write = false;
  f.stores.equalizerBands.update(bands => { bands[9] = 2.1; return bands; });
  assert.equal(get(f.stores.equalizerSaveError), false);
  const restarted = await setup(new Map(f.storage));
  assert.equal(get(restarted.stores.equalizerBands)[9], 2.1);
});

test('startup initialization runs once and unrelated settings do not reset EQ', async () => {
  const f = await setup();
  f.stores.equalizerBands.set(custom());
  f.stores.activeEqualizerPreset.set('custom');
  const before = f.writes.filter(write => write.key === KEY).length;
  f.stores.initStore();
  f.stores.settings.update(value => ({ ...value, theme: 'ocean' }));
  assert.equal(f.writes.filter(write => write.key === KEY).length, before);
  assert.deepEqual(plain(get(f.stores.equalizerBands)), custom());
  f.stores.equalizerBands.set(flat());
  assert.equal(f.writes.filter(write => write.key === KEY).length, before + 1);
});
