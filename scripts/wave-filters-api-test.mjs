import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as station from '../src/lib/waveStationCore.ts';
import * as filters from '../src/lib/waveFilters.ts';

const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
async function load(file, modules) {
  const context = vm.createContext({ console, window: { __TAURI_INTERNALS__: {} }, Map, Set, Date, URLSearchParams, DOMException, AbortController, setTimeout, clearTimeout, TextEncoder, Uint8Array });
  const module = new vm.SourceTextModule(transpile(await readFile(new URL(file, import.meta.url), 'utf8')), { context });
  await module.link(name => new vm.SyntheticModule(Object.keys(modules[name]), function() { for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value); }, { context }));
  await module.evaluate(); return module.namespace;
}
test('Yandex filter preparation resolves catalogue aliases and posts JSON preserving mood and diversity', async () => {
  const calls = [];
  const info = { station: { restrictions2: { language: { possibleValues: ['any','russian','not-russian','without-words'].map(value => ({ value })) } } }, settings2: { language: 'any', moodEnergy: 'calm', diversity: 'discover' } };
  const api = await load('../src/lib/yandex.ts', {
    '@tauri-apps/plugin-http': { fetch: async (url, init) => { calls.push({ url, init }); const result = url.endsWith('/list') ? [{ station: { id: { type: 'genre', tag: 'electronics' } } }] : url.endsWith('/info') ? [info] : 'ok'; return { ok: true, status: 200, text: async () => JSON.stringify({ result }) }; } },
    './secretStorage': { whenSecretsReady: async () => {} },
    './logRedaction': { redactText: value => value, rememberSecret() {} },
    'md5': { default: () => '' }, './waveStationCore': station
  });
  const signal = new AbortController().signal;
  const result = await api.prepareYandexWaveFilters('test-only-account', { waveGenre: 'electronic', waveContent: 'instrumental' }, undefined, signal);
  assert.equal(result.station, 'genre:electronics'); assert.equal(result.serverLanguage, 'without-words');
  const post = calls.at(-1); assert(post.url.endsWith('genre%3Aelectronics/settings3'));
  assert.equal(post.init.method, 'POST'); assert.equal(post.init.headers['Content-Type'], 'application/json'); assert.equal(post.init.signal, signal);
  assert.deepEqual(JSON.parse(post.init.body), { language: 'without-words', moodEnergy: 'calm', diversity: 'discover', type: 'rotor' });
  info.settings2.language = 'without-words';
  await api.prepareYandexWaveFilters('test-only-account', { waveGenre: 'electronic', waveContent: 'instrumental' });
  assert.equal(calls.filter(call => call.url.endsWith('/list')).length, 1); assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
});
test('metadata enrichment has a three-request concurrency limit, shared budget and account-scoped cache', async () => {
  let running = 0, peak = 0, requests = 0;
  const metadata = await load('../src/lib/waveMetadata.ts', {
    './waveFilters': filters,
    './yandex': { getYandexLyrics: async () => { running++; requests++; peak = Math.max(peak, running); await new Promise(setImmediate); running--; return '[00:00.00] I want you with me and my love tonight'; } }
  });
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), source: 'yandex', title: 'Название', artist: 'Имя' }));
  const result = await metadata.enrichWaveCandidates('account-a', tracks, { waveLanguage: 'en' }, {}, { remaining: 5 });
  assert.equal(requests, 5); assert.equal(peak, 3); assert.equal(result.filter(track => track.lyricsLanguage === 'en').length, 5);
  await metadata.enrichWaveCandidates('account-a', tracks.slice(0, 5), { waveLanguage: 'en' }, {}, { remaining: 5 }); assert.equal(requests, 5);
  await metadata.enrichWaveCandidates('account-b', tracks.slice(0, 2), { waveLanguage: 'en' }, {}, { remaining: 2 }); assert.equal(requests, 7);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(metadata.enrichWaveCandidates('account-b', tracks, { waveLanguage: 'en' }, {}, { remaining: 2 }, controller.signal), { name: 'AbortError' });
});
