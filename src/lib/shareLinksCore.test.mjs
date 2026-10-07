import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from './dailyMixesCore.ts';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('./shareLinksCore.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: () => core, URL, btoa, atob, TextEncoder, TextDecoder, Uint8Array });
const { trackShareLink, mixShareLink, parseShareLink, toDeepLink, platformTrackLink } = exports;

const track = { id: '123', source: 'yandex', title: 'Песня', artist: 'Автор', audioUrl: 'private-stream', token: 'fake-secret', coverUrl: 'https://example.test/private?token=fake' };
const selection = { id: 'private-account', source: 'yandex', account: 'private-account', mix: { kind: 'discover', title: 'Открытия', day: '2026-10-05', tracks: [track] } };
test('a track link preserves service identity and Cyrillic without exporting credentials', () => {
  const link = trackShareLink(track);
  assert.ok(link.startsWith('https://pizxxxxx.github.io/LomifyNEXT/share/#track?'));
  const result = parseShareLink(link);
  assert.equal(result.source, 'yandex'); assert.equal(result.mix.tracks[0].id, '123');
  assert.equal(result.mix.title, 'Песня'); assert.equal(result.sharedTrack, true);
  assert.ok(!link.includes('fake')); assert.ok(!link.includes('private')); assert.equal(result.mix.tracks[0].audioUrl, '');
});
test('the browser bridge keeps native link compatibility and rejects external redirects', () => {
  const native = toDeepLink(trackShareLink(track));
  assert.ok(native.startsWith('lomifynext://track?'));
  assert.equal(parseShareLink(native).mix.tracks[0].id, '123');
  assert.equal(toDeepLink('https://evil.test/#track?v=1&source=yandex&id=123'), null);
  assert.equal(toDeepLink('https://pizxxxxx.github.io/LomifyNEXT/share/#javascript:alert(1)'), null);
  assert.equal(platformTrackLink(track), 'https://music.yandex.ru/track/123');
  assert.ok(platformTrackLink({ ...track, source: 'soundcloud' }).startsWith('https://soundcloud.com/search/sounds?q='));
});
test('a shared mix preserves the actual dated track list for another account', () => {
  const link = mixShareLink(selection), result = parseShareLink(link);
  assert.equal(result.mix.day, '2026-10-05'); assert.equal(result.shared, true);
  assert.equal(result.mix.tracks[0].title, 'Песня'); assert.equal(result.account, 'shared');
  assert.ok(!link.includes('private-account')); assert.equal(result.mix.tracks[0].coverUrl, '');
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
});
test('untrusted links reject arbitrary hosts, IDs, URLs, versions and oversized input', () => {
  for (const link of ['https://example.test', 'lomifynext://track?v=2&source=yandex&id=123', 'lomifynext://track?v=1&source=yandex&id=../secrets', 'lomifynext://track?v=1&source=local&id=123', 'lomifynext://mix?v=1&data=garbage', 'lomifynext://user:password@track?v=1&source=yandex&id=123', 'lomifynext://unknown', 'x'.repeat(16001)]) assert.equal(parseShareLink(link), null);
  assert.throws(() => trackShareLink({ ...track, source: 'Локальный' }));
});
test('thirty-track links are bounded and decoded into metadata only', () => {
  const tracks = Array.from({ length: 30 }, (_, i) => ({ ...track, id: String(i + 1), title: 'Песня'.repeat(60), artist: 'Автор'.repeat(60) }));
  const link = mixShareLink({ ...selection, mix: { ...selection.mix, tracks } });
  assert.ok(link.length <= 16000); assert.equal(parseShareLink(link).mix.tracks.length, 30);
});
