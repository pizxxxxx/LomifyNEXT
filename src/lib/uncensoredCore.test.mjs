import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('./uncensoredCore.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
const { rankUncensored, uncensoredQueries, allowServiceTwin } = exports;
import { buildTrackUrn } from './utils/trackUrn.ts';

const song = { title: 'чувство', artist: 'whylovly', duration: 120000 };
const candidate = (id, title, artist = 'whylovly', extra = {}) => ({ ...song, id, title, artist, source: 'soundcloud', audioUrl: '', coverUrl: '', ...extra });
test('explicit editions lead, while clean, remixes, wrong artists and unrelated titles are excluded', () => {
  const rows = rankUncensored(song, [candidate(1, 'чувство'), candidate(2, 'чувство (uncensored)'), candidate(3, 'чувство (clean)'), candidate(4, 'чувство remix'), candidate(5, 'чувство (explicit)', 'Other'), candidate(6, 'другая песня (explicit)'), candidate(7, 'чувство (explicit)', 'whylovly', { duration: 300000 }), candidate(8, 'чувство (explicit)', 'whylovly', { isBanned: true })]);
  assert.deepEqual(Array.from(rows, row => row.track.id), [2, 1]);
  assert.equal(rows[0].marked, true); assert.equal(rows[1].marked, false);
});
test('original artist in a reupload title or publisher metadata remains eligible, duplicates are removed', () => {
  assert.equal(rankUncensored(song, [candidate(1, 'whylovly - чувство без цензуры', 'Uploader'), candidate(1, 'whylovly - чувство без цензуры', 'Uploader')]).length, 1);
  assert.equal(rankUncensored(song, [candidate(2, 'чувство (explicit)', 'Uploader', { originalArtist: 'whylovly' })]).length, 1);
});
test('search queries remove clean edition suffixes and include the artist', () => {
  assert.deepEqual(Array.from(uncensoredQueries({ ...song, title: 'чувство (clean)' })), ['whylovly чувство uncensored', 'whylovly чувство без цензуры', 'whylovly чувство']);
});
test('explicit SC selection bypasses Yandex twins and isolates a previously cached twin', () => {
  const ordinary = candidate(1, 'чувство'), chosen = { ...ordinary, playbackSource: 'soundcloud' };
  assert.equal(allowServiceTwin(ordinary, true), true); assert.equal(allowServiceTwin(chosen, true), false);
  assert.equal(allowServiceTwin(ordinary, false), false);
  assert.notEqual(buildTrackUrn(ordinary), buildTrackUrn(chosen));
  assert.equal(buildTrackUrn(chosen).split(':').at(-1), '1');
});

test('actual audio resolution keeps an explicit SC edition on SC, including stream failure', async () => {
  const apiSource = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('api.ts', apiSource, ts.ScriptTarget.Latest, true);
  const body = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getAudioUrl').getText(ast);
  for (const failed of [false, true]) {
    let twins = 0;
    const globals = { exports: {}, allowServiceTwin, whenSecretsReady: async () => {}, settings: { searchSource: 'yandex', yandexToken: 'fake-test-token', crossPlatformSync: true }, get: value => value, console: { warn() {} }, notify() {},
      findYandexTwin: async () => { twins++; return '999'; }, getYandexStreamUrl: async () => 'https://yandex.test/stream',
      getSoundCloudClientId: async () => 'public', rankStreamUrls: () => ({ ranked: ['https://api.soundcloud.test/stream'], dropped: 0 }), isPreviewUrl: () => false,
      safeFetch: async () => ({ ok: !failed, status: failed ? 503 : 200, json: async () => ({ url: 'https://sc.test/stream' }) }) };
    vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, globals);
    const request = globals.exports.getAudioUrl({ ...candidate(1, 'чувство'), playbackSource: 'soundcloud' });
    if (failed) await assert.rejects(request); else assert.equal(await request, 'https://sc.test/stream');
    assert.equal(twins, 0);
  }
});
