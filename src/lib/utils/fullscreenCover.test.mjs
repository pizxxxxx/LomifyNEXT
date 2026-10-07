import test from 'node:test';
import assert from 'node:assert/strict';
import { fullscreenCoverCandidates, loadFullscreenCover } from './fullscreenCover.ts';
test('Yandex upgrades the thumbnail and retains its query', () => {
  const source='https://avatars.yandex.net/get-music-content/5/album/400x400?x=1';
  assert.deepEqual(fullscreenCoverCandidates(source),[source.replace('400x400','1000x1000'),source]);
});
test('SoundCloud tries both original extensions before its existing artwork', () => {
  const source='https://i1.sndcdn.com/artworks-abc-t500x500.jpg';
  assert.deepEqual(fullscreenCoverCandidates(source),[source.replace('t500x500','original'),source.replace('t500x500.jpg','original.png'),source]);
});
test('offline, custom, and unknown artwork is never rewritten', () => {
  for (const url of ['http://127.0.0.1:51/downloaded-cover/token','data:image/png;base64,foo','https://example.com/sndcdn.com-t500x500.jpg']) assert.deepEqual(fullscreenCoverCandidates(url),[url]);
});
test('a missing original falls back to the existing cover', async () => {
  const previous = globalThis.Image;
  globalThis.Image=class {set src(value){ if(value) queueMicrotask(()=>this.onerror?.()); }};
  try { const source='https://i1.sndcdn.com/artworks-abc-t500x500.jpg'; assert.equal(await loadFullscreenCover(source),source); }
  finally { globalThis.Image=previous; }
});
