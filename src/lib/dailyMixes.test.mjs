import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from './dailyMixesCore.ts';

const request = { day: '2026-10-05', now: new Date(2026, 9, 5, 12).getTime(), source: 'soundcloud', account: 'listener', likes: [{ id: '1', source: 'soundcloud', title: 'Song', artist: 'Artist' }], history: {}, playlists: [], disliked: [], recommendations: [], recommendationsDay: '', releases: [], releasesDay: '' };
function adapter(storage, failWrite = false) {
  const exports = {};
  const context = vm.createContext({ exports, require: (name) => { assert.equal(name, './dailyMixesCore'); return core; }, localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { if (failWrite) throw new Error('quota'); storage.set(key, value); }
  } });
  const source = fs.readFileSync(new URL('./dailyMixes.ts', import.meta.url), 'utf8');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return exports.updateDailyMixes;
}

test('storage adapter persists the daily snapshot and restores it in a new process', () => {
  const storage = new Map();
  const first = adapter(storage)(request);
  assert.ok(storage.has('lomifynext_daily_mixes'));
  const restored = adapter(storage)({ ...request, likes: [] });
  assert.equal(JSON.stringify(restored.mixes), JSON.stringify(first.mixes));
});

test('corrupt browser cache and failed writes preserve a usable in-memory selection', () => {
  const storage = new Map([['lomifynext_daily_mixes', '{broken']]);
  const update = adapter(storage, true);
  const result = update(request);
  assert.equal(result.mixes[0].tracks[0].id, '1');
  assert.equal(update({ ...request, likes: [] }).mixes[0].tracks[0].id, '1');
  assert.equal(storage.get('lomifynext_daily_mixes'), '{broken');
});

test('browser cache retains only four account contexts', () => {
  const storage = new Map();
  const update = adapter(storage);
  for (let account = 0; account < 10; account++) update({ ...request, account: String(account) });
  assert.equal(JSON.parse(storage.get('lomifynext_daily_mixes')).length, 4);
});
