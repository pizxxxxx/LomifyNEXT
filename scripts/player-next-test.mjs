import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { writable, get } from 'svelte/store';

// Execute the real component handlers, without audio/network or Svelte's deferred flush.
const component = await readFile(new URL('../src/lib/components/Player.svelte', import.meta.url), 'utf8');
const script = component.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
const tree = ts.createSourceFile('Player.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(['handleTrackEnded', 'playNext']);
const statements = tree.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.has(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === 'pendingTrackAdvance'));
assert(statements.length >= 2, 'the playback handlers must be extracted');
const source = ts.transpileModule(statements.map(node => node.getText(tree)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const track = id => ({ id: String(id), source: 'yandex', waveBatchId: 'test-batch' });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function setup(refill = async () => {}, related = async () => []) {
  const stores = { currentTrack: writable(track(1)), queue: writable([track(2), track(3)]),
    trackHistory: writable([]), isPlaying: writable(true), dislikedTracks: writable([]) };
  const feedback = [];
  const globals = { ...stores, get, loadGeneration: 1, currentTime: 0.1, repeatMode: 0,
    preparedNext: null, isShuffle: false, $waveActive: true, $settings: { waveContinuation: false },
    $likedTracks: [], $listenStats: {}, $playlists: [],
    isTrackDisliked: () => false, waveRefill: refill,
    waveTrackDone: (item, seconds, outcome) => feedback.push({ id: item.id, outcome }),
    invoke: async () => {}, notify() {}, console: { warn() {} } };
  Object.defineProperty(globals, '$currentTrack', { get: () => get(stores.currentTrack) });
  Object.defineProperty(globals, '$isPlaying', { get: () => get(stores.isPlaying), set: value => stores.isPlaying.set(value) });
  const context = vm.createContext(globals);
  const module = new vm.SourceTextModule(source + '\nexport { handleTrackEnded, playNext };', {
    context,
    importModuleDynamically: async name => {
      assert.equal(name, '$lib/api');
      const api = new vm.SyntheticModule(['getRelatedTracks'], function () {
        this.setExport('getRelatedTracks', related);
      }, { context });
      await api.link(() => {});
      await api.evaluate();
      return api;
    }
  });
  await module.link(() => { throw new Error('Unexpected import'); });
  await module.evaluate();
  return { handler: module.namespace.handleTrackEnded, stores, feedback, globals };
}

test('rapid next and audio-ended events advance one track while awaiting the same refill', async () => {
  const refill = deferred();
  const { handler, stores, feedback } = await setup(() => refill.promise);
  const first = handler('skip');
  await handler('skip');
  await handler('finished');
  assert.deepEqual(feedback, [{ id: '1', outcome: 'skip' }]);
  refill.resolve();
  await first;
  assert.equal(get(stores.currentTrack).id, '2');
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['3']);
  assert.deepEqual(Array.from(get(stores.trackHistory), t => t.id), ['1']);
});

test('manual playback invalidates a waiting advance before loadGeneration updates', async () => {
  const refill = deferred();
  const { handler, stores, globals } = await setup(() => refill.promise);
  const first = handler('skip');
  const manual = track(99);
  stores.currentTrack.set(manual);
  refill.resolve();
  await first;
  assert.equal(globals.loadGeneration, 1);
  assert.equal(get(stores.currentTrack), manual);
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['2', '3']);
  assert.equal(get(stores.trackHistory).length, 0);
});

test('an older completion cannot release the newer track advance guard', async () => {
  const firstRefill = deferred(), secondRefill = deferred();
  let calls = 0;
  const { handler, stores, feedback } = await setup(() => ++calls === 1 ? firstRefill.promise : secondRefill.promise);
  const first = handler('skip');
  stores.currentTrack.set(track(2));
  stores.queue.set([track(3), track(4)]);
  const second = handler('skip');
  firstRefill.resolve();
  await first;
  await handler('skip');
  assert.equal(calls, 2);
  assert.deepEqual(feedback.map(item => item.id), ['1', '2']);
  secondRefill.resolve();
  await second;
  assert.equal(get(stores.currentTrack).id, '3');
});

test('a new next click advances normally after the previous selection commits', async () => {
  const { handler, stores, feedback } = await setup();
  await handler('skip');
  await handler('skip');
  assert.equal(get(stores.currentTrack).id, '3');
  assert.deepEqual(feedback.map(item => item.id), ['1', '2']);
  assert.deepEqual(Array.from(get(stores.trackHistory), t => t.id), ['1', '2']);
});

test('ordinary autoplay also shares a pending advance and preserves manual playback', async () => {
  const related = deferred();
  let calls = 0;
  const { handler, stores, globals } = await setup(undefined, () => { calls++; return related.promise; });
  globals.$waveActive = false;
  globals.$settings.waveContinuation = true;
  stores.queue.set([]);
  const first = handler('skip');
  await new Promise(setImmediate);
  await handler('finished');
  assert.equal(calls, 1);
  const manual = track(99);
  stores.currentTrack.set(manual);
  related.resolve([track(2)]);
  await first;
  assert.equal(get(stores.currentTrack), manual);
});

test('an autoplay request failure releases the guard for a later retry', async () => {
  let calls = 0;
  const { handler, stores, globals } = await setup(undefined, async () => {
    if (++calls === 1) throw new Error('offline');
    return [track(2)];
  });
  globals.$waveActive = false;
  globals.$settings.waveContinuation = true;
  stores.queue.set([]);
  await handler('finished');
  assert.equal(get(stores.isPlaying), false);
  await handler('skip');
  assert.equal(calls, 2);
  assert.equal(get(stores.currentTrack).id, '2');
});
