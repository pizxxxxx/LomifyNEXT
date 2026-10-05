import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { writable, derived, get } from 'svelte/store';

const source = ts.transpileModule(await readFile(new URL('../src/lib/wave.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const track = id => ({ id: `${id}`, title: `Track ${id}`, artist: 'Artist', source: 'yandex' });
const batch = ids => ({ batchId: `batch-${ids[0]}`, tracks: ids.map(track) });

const scTrack = (id, artist = `Artist ${id % 5}`) => ({ ...track(id), artist, source: 'soundcloud', duration: 180000 });
const scBatch = ids => ids.map(id => scTrack(id));

async function setup(responses = [], soundcloud = [], fresh = []) {
  const requests = [], feedback = [], notices = [];
  const stores = {
    settings: writable({ searchSource: 'yandex', yandexToken: 'test-session' }),
    queue: writable([]), currentTrack: writable(null), isPlaying: writable(false),
    dislikedTracks: writable([]), waveDisplayName: writable('Моя тусня'),
    likedTracks: writable([]), listenStats: writable({ history: {} }), searchHistory: writable([]), playlists: writable([]),
    notify: message => notices.push(message)
  };
  const modules = {
    'svelte/store': { writable, derived, get }, './stores': stores,
    './dislikes': { isTrackDisliked: () => false },
    './secretStorage': { whenSecretsReady: async () => {}, secretsAreReady: () => true },
    './freshWave': { getFreshWaveTracks: async (source, seen, skipped, anchor) => {
      requests.push({ fresh: source, seen: new Set(seen), skipped: new Map(skipped), anchor });
      const response = fresh.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : response || [];
    } },
    './yandex': {
      yandexWaveBatch: async (token, tail, station) => {
        requests.push({ tail, station });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response() : response || batch([]);
      },
      yandexWaveFeedback: (token, event, opts) => feedback.push({ event, ...opts })
    },
    './waveFilters': {
      describeWaveFilters: () => '', hasWaveFilters: () => false,
      trackMatchesWaveFilters: () => true, trackMatchesWaveGenre: () => true, isNeuroTrack: () => false
    },
    './api': {
      fetchRelatedTracks: async id => {
        requests.push({ related: id });
        const response = soundcloud.shift();
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response() : response || [];
      },
      getTrendingTracks: async (likes, stats, history, playlists, options) => {
        requests.push({ personal: true, likes, options });
        const response = soundcloud.shift();
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response() : response || [];
      }
    }
  };
  const context = vm.createContext({ console: { error() {}, warn() {} }, Map, Set, DOMException, AbortController, setTimeout, clearTimeout });
  const synthetic = name => {
    const exports = modules[name];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  };
  const module = new vm.SourceTextModule(source, { context, importModuleDynamically: async name => {
    const imported = synthetic(name);
    await imported.link(() => {});
    await imported.evaluate();
    return imported;
  } });
  await module.link(synthetic);
  await module.evaluate();
  return { wave: module.namespace, stores, requests, feedback, notices };
}

test('track station, continuation and feedback retain the selected seed', async () => {
  const { wave, stores, requests, feedback } = await setup([batch([1, 2, 3]), batch([4, 5, 6])]);
  assert.equal(await wave.startWave(track(99)), true);
  assert.equal(get(wave.waveLabel), 'Моя волна по треку: Track 99');
  assert.equal(get(stores.currentTrack).waveStation, 'track:99');
  wave.waveTrackDone(get(stores.currentTrack), 90, 'finished');
  await wave.waveRefill();
  await new Promise(setImmediate);
  assert.deepEqual(requests, [{ tail: undefined, station: 'track:99' }, { tail: '3', station: 'track:99' }, { tail: '6', station: 'track:99' }]);
  assert.equal(feedback.find(f => f.event === 'trackFinished').station, 'track:99');
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['2', '3', '4', '5', '6']);
});

test('fresh personal wave uses the selected provider without sending local batches to Rotor', async () => {
  for (const source of ['yandex', 'soundcloud']) {
    const tracks = [1, 2, 3].map(id => ({ ...track(id), source }));
    const { wave, stores, requests, feedback } = await setup([], [], [tracks]);
    stores.settings.update(state => ({ ...state, searchSource: source, waveFreshTaste: true }));
    assert.equal(await wave.startWave(), true);
    assert.equal(get(wave.waveTasteMode), 'fresh');
    assert.equal(get(wave.waveSource), source);
    assert.equal(get(wave.waveSeed), null);
    assert.equal(get(stores.currentTrack).waveStation, `fresh:${source}`);
    wave.waveTrackDone(get(stores.currentTrack), 90, 'finished');
    assert.equal(requests[0].fresh, source);
    assert.equal(feedback.length, 0);
  }
});

test('fresh continuation carries session exclusions and finished-track context', async () => {
  const { wave, stores, requests } = await setup([], [], [[track(1), track(2), track(3)], [track(4), track(5)]]);
  stores.settings.update(state => ({ ...state, waveFreshTaste: true }));
  await wave.startWave();
  const playing = get(stores.currentTrack);
  wave.waveTrackDone(playing, 100, 'finished');
  await wave.waveRefill(); await new Promise(setImmediate);
  const request = requests.at(-1);
  assert.equal(request.anchor.id, playing.id);
  assert.equal(request.seen.size, 3);
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['2', '3', '4', '5']);
});

test('fresh wave rejects missing Yandex authentication and stale account responses', async () => {
  let finish;
  const { wave, stores } = await setup([], [], [() => new Promise(resolve => { finish = resolve; })]);
  stores.settings.set({ searchSource: 'yandex', waveFreshTaste: true });
  assert.equal(await wave.startWave(), false);
  stores.settings.update(state => ({ ...state, yandexToken: 'first' }));
  const pending = wave.startWave();
  stores.settings.update(state => ({ ...state, yandexToken: 'second' }));
  finish([track(1)]);
  assert.equal(await pending, false);
  assert.equal(get(stores.currentTrack), null);
});

test('cancelled fresh launches leave manually selected playback untouched', async () => {
  let finish;
  const { wave, stores } = await setup([], [], [() => new Promise(resolve => { finish = resolve; })]);
  stores.settings.update(state => ({ ...state, waveFreshTaste: true }));
  const controller = new AbortController();
  const pending = wave.startWave(null, { signal: controller.signal });
  stores.currentTrack.set(track(42)); controller.abort();
  assert.equal(await pending, false);
  finish([track(1)]);
  assert.equal(get(stores.currentTrack).id, '42');
});

test('returning to personal wave clears the seed and uses the personal station', async () => {
  const { wave, requests } = await setup([batch([1, 2]), batch([4, 5])]);
  await wave.startWave(track(99));
  await wave.startWave();
  assert.equal(get(wave.waveSeed), null);
  assert.equal(requests.at(-1).station, 'user:onyourwave');
});

test('failed track station keeps current playback and never silently substitutes personal wave', async () => {
  const { wave, stores, requests, notices } = await setup([new Error('station unavailable')]);
  stores.currentTrack.set(track(42)); stores.queue.set([track(43)]);
  assert.equal(await wave.startWave(track(99)), false);
  assert.equal(get(stores.currentTrack).id, '42');
  assert.equal(get(stores.queue)[0].id, '43');
  assert.equal(requests.length, 1);
  assert.match(notices[0], /Track 99/);
});

test('an old station response cannot replace a newer station or manual playback', async () => {
  let finish;
  const { wave, stores } = await setup([() => new Promise(resolve => { finish = resolve; }), batch([4, 5])]);
  const old = wave.startWave(track(99));
  await wave.startWave(track(100));
  finish(batch([1, 2]));
  assert.equal(await old, false);
  assert.equal(get(wave.waveSeed).id, '100');
  assert.equal(get(stores.currentTrack).id, '4');
  wave.stopWave();
  assert.equal(get(wave.waveSeed), null);
});

test('manual playback and account changes cancel pending or active station ownership', async () => {
  let finish;
  const { wave, stores, feedback } = await setup([() => new Promise(resolve => { finish = resolve; }), batch([4, 5])]);
  const pending = wave.startWave(track(99));
  stores.currentTrack.set(track(42));
  finish(batch([1, 2]));
  assert.equal(await pending, false);
  assert.equal(get(stores.currentTrack).id, '42');
  assert.equal(get(wave.waveActive), false);
  await wave.startWave(track(100));
  stores.settings.update(state => ({ ...state, yandexToken: 'another-account' }));
  assert.equal(get(wave.waveActive), false);
  assert.equal(get(wave.waveSeed), null);
  const sent = feedback.length;
  wave.waveTrackDone(get(stores.currentTrack), 90, 'finished');
  assert.equal(feedback.length, sent);
});

test('SoundCloud track wave works without a Yandex account and keeps its seed', async () => {
  const { wave, stores, feedback, requests } = await setup([], [scBatch([1, 2, 3, 1])]);
  stores.settings.set({ searchSource: 'soundcloud' });
  assert.equal(await wave.startWave(scTrack(99)), true);
  assert.equal(get(wave.waveSource), 'soundcloud');
  assert.equal(get(wave.waveSeed).id, '99');
  assert.equal(get(stores.currentTrack).waveStation, 'soundcloud');
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['2', '3']);
  assert.deepEqual(requests, [{ related: '99' }]);
  assert.equal(feedback.length, 0);
  stores.settings.update(state => ({ ...state, yandexToken: 'other-account' }));
  assert.equal(get(wave.waveActive), true);
});

test('personal SoundCloud wave gathers updated likes on every launch', async () => {
  const { wave, stores, requests } = await setup([], [scBatch([1, 2, 3]), scBatch([4, 5, 6])]);
  stores.settings.set({ searchSource: 'soundcloud' });
  stores.likedTracks.set([scTrack(90)]);
  await wave.startWave();
  stores.likedTracks.set([scTrack(91)]);
  await wave.startWave();
  assert.deepEqual(requests.map(r => r.likes[0].id), ['90', '91']);
  assert.ok(requests.every(r => r.options.source === 'soundcloud'));
  assert.equal(get(wave.waveSeed), null);
  assert.equal(get(stores.currentTrack).id, '4');
});

test('personal wave uses SoundCloud when the selected Yandex account is disconnected', async () => {
  const { wave, stores } = await setup([], [scBatch([1, 2, 3])]);
  stores.settings.set({ searchSource: 'yandex', yandexToken: '' });
  assert.equal(await wave.startWave(), true);
  assert.equal(get(wave.waveSource), 'soundcloud');
});

test('SoundCloud continuation follows a finished track and deduplicates the session', async () => {
  const { wave, stores, requests, feedback } = await setup([], [scBatch([1, 2, 3]), scBatch([1, 4, 5, 6])]);
  stores.settings.set({ searchSource: 'soundcloud' });
  await wave.startWave(scTrack(99));
  wave.waveTrackDone(get(stores.currentTrack), 90, 'finished');
  stores.queue.set([]);
  await wave.waveRefill();
  assert.deepEqual(requests, [{ related: '99' }, { related: '1' }]);
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['4', '5', '6']);
  assert.equal(feedback.length, 0);
});

test('two artist skips remove that artist from current and future SoundCloud batches', async () => {
  const first = [scTrack(1, 'Old'), scTrack(2, 'New'), scTrack(3, 'Old'), scTrack(4, 'Old')];
  const { wave, stores } = await setup([], [first, [scTrack(5, 'Old'), scTrack(6, 'New')]]);
  stores.settings.set({ searchSource: 'soundcloud' });
  await wave.startWave(scTrack(99));
  wave.waveTrackDone(get(stores.currentTrack), 2, 'skip');
  wave.waveTrackDone({ ...scTrack(3, 'Old'), waveBatchId: get(stores.currentTrack).waveBatchId }, 2, 'skip');
  assert.ok(get(stores.queue).every(t => t.artist !== 'Old'));
  stores.queue.set([]);
  await wave.waveRefill();
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['6']);
});

test('SoundCloud delayed starts and refills cannot overwrite manual playback', async () => {
  let finish;
  const deferred = () => new Promise(resolve => { finish = resolve; });
  const { wave, stores } = await setup([], [deferred, scBatch([4, 5, 6]), deferred]);
  stores.settings.set({ searchSource: 'soundcloud' });
  const launch = wave.startWave(scTrack(99));
  await new Promise(setImmediate);
  stores.currentTrack.set(scTrack(42));
  finish(scBatch([1, 2, 3]));
  assert.equal(await launch, false);
  assert.equal(get(stores.currentTrack).id, '42');
  await wave.startWave(scTrack(100));
  stores.queue.set([]);
  const refill = wave.waveRefill();
  await new Promise(setImmediate);
  stores.currentTrack.set(scTrack(43));
  finish(scBatch([7, 8, 9]));
  await refill;
  assert.equal(get(stores.currentTrack).id, '43');
  assert.equal(get(wave.waveActive), false);
  assert.equal(get(stores.queue).length, 0);
});

test('SoundCloud simultaneous refills share one request and failed launch keeps playback', async () => {
  let finish;
  const { wave, stores, requests } = await setup([], [scBatch([1, 2, 3]), () => new Promise(resolve => { finish = resolve; }), new Error('offline')]);
  stores.settings.set({ searchSource: 'soundcloud' });
  await wave.startWave(scTrack(99));
  stores.queue.set([]);
  const first = wave.waveRefill(), second = wave.waveRefill();
  await new Promise(setImmediate);
  finish(scBatch([4, 5, 6]));
  await Promise.all([first, second]);
  assert.equal(requests.length, 2);
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['4', '5', '6']);
  assert.equal(await wave.startWave(scTrack(100)), false);
  assert.equal(get(wave.waveSeed).id, '99');
  assert.equal(get(stores.currentTrack).id, '1');
  assert.deepEqual(Array.from(get(stores.queue), t => t.id), ['4', '5', '6']);
});
