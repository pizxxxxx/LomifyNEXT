/**
 * Shared, memory-only Wave session for both music services.
 * Yandex owns its station and receives playback feedback. SoundCloud builds a local
 * stream from fresh taste recommendations and related tracks, then follows completed
 * tracks and excludes repeatedly skipped artists. Generation guards discard old requests.
 */

import { writable, derived, get } from 'svelte/store';
import { settings, queue, currentTrack, isPlaying, notify, dislikedTracks, waveDisplayName, likedTracks, listenStats, searchHistory, playlists } from './stores';
import { isTrackDisliked } from './dislikes';
import { yandexWaveBatch, yandexWaveFeedback } from './yandex';
import { whenSecretsReady, secretsAreReady } from './secretStorage';
import { getFreshWaveTracks } from './freshWave';
import {
  describeWaveFilters,
  hasWaveFilters,
  trackMatchesWaveFilters,
  trackMatchesWaveGenre,
  isNeuroTrack
} from './waveFilters';

/** Играет ли сейчас волна. Плеер смотрит на это, чтобы докладывать порции. */
export const waveActive = writable(false);
export const waveSource = writable<'soundcloud' | 'yandex' | null>(null);
export const waveTasteMode = writable<'fresh' | 'service'>('service');
export interface WaveSeed {
  id: string;
  title: string;
  artist?: string;
  source: 'yandex' | 'soundcloud';
}
export const waveSeed = writable<WaveSeed | null>(null);
export const waveLabel = derived([waveSeed, waveDisplayName], ([$seed, $name]) =>
  $seed ? `Моя волна по треку: ${$seed.title}` : $name
);
let waveRequestGeneration = 0;
let waveProvider: 'yandex' | 'soundcloud' = 'yandex';
let freshPersonal = false;
let localController: AbortController | null = null;
const localWave = () => freshPersonal || waveProvider === 'soundcloud';
let soundCloudSession = '';
let soundCloudAnchor: any = null;
const soundCloudSeen = new Set<string>();
const soundCloudSkippedArtists = new Map<string, number>();
const scKey = (track: any) => `${track?.source}:${track?.id}`;
const scArtist = (track: any) => `${track?.artist || ''}`.toLocaleLowerCase('ru').trim();

/** Текущая станция ротора Яндекс Музыки (user:onyourwave или genre:...). */
let activeStationId = 'user:onyourwave';

function stationForState(state: any): string {
  if (state.waveGenre) {
    const g = `${state.waveGenre}`.toLowerCase();
    const l = `${state.waveLanguage || ''}`.toLowerCase();
    if (l === 'ru') {
      if (g === 'rock') return 'genre:rusrock';
      if (g === 'rap') return 'genre:rusrap';
      if (g === 'pop') return 'genre:ruspop';
      if (g === 'rnb') return 'genre:rusrnb';
    } else if (l === 'en' || l === 'other') {
      if (g === 'rock') return 'genre:foreignrock';
      if (g === 'rap') return 'genre:foreignrap';
      if (g === 'pop') return 'genre:foreignpop';
    }
    return `genre:${g}`;
  }
  return 'user:onyourwave';
}

const NEURO_SEARCH_QUERIES = [
  'нейромузыка',
  'нейрокавер',
  'suno ai',
  'нейросеть',
  'генеративная музыка',
  'ai cover',
  'ии кавер',
  'нейропесня'
];

let neuroQueryIndex = 0;

async function fetchNeuroTracksFromYandex(rawToken: string, count = 10): Promise<any[]> {
  try {
    const api = await import('./yandex');
    const q1 = NEURO_SEARCH_QUERIES[neuroQueryIndex % NEURO_SEARCH_QUERIES.length];
    neuroQueryIndex++;
    const q2 = NEURO_SEARCH_QUERIES[neuroQueryIndex % NEURO_SEARCH_QUERIES.length];
    neuroQueryIndex++;

    const [r1, r2] = await Promise.all([
      api.searchYandex(rawToken, q1, 30).catch(() => []),
      api.searchYandex(rawToken, q2, 30).catch(() => [])
    ]);

    const combined = [...r1, ...r2];
    const currentDisliked = get(dislikedTracks);
    const valid = combined
      .filter((t: any) => t && t.id && !isTrackDisliked(currentDisliked, t) && isNeuroTrack(t))
      .sort(() => Math.random() - 0.5);

    return valid.slice(0, count);
  } catch (e) {
    console.warn('[волна] поиск нейротреков завершился с ошибкой', e);
    return [];
  }
}

/** Порция, из которой приехали треки, лежащие сейчас в очереди. */
let batchId = '';

/** Последний трек, отданный волной: по нему запрашивается продолжение. */
let tailId = '';

/** Идёт запрос порции. Нужен, чтобы два подряд «очередь кончается» не дали два запроса. */
let pendingBatch: Promise<void> | null = null;

/** Трек, о начале которого станции уже сказали. Защита от повторной отметки. */
let startedId = '';

/**
 * Порог докладки: при таком остатке очереди запрашивается следующая порция.
 *
 * Два, а не ноль: запрос к станции идёт секунду-две, и делать его в момент, когда очередь уже
 * пуста, означает паузу между треками. Пока играет предпоследний, порция приезжает незаметно.
 */
const REFILL_AT = 2;

/** При активном фильтре просматриваем несколько порций, пока не наберётся очередь. */
const FILTER_SCAN_BATCHES = 18;
const FILTER_TARGET_TRACKS = 10;
const MAX_TRACK_OCCURRENCES = 2;

/** Сколько раз трек уже попадал в очередь текущего сеанса волны. */
const sessionOccurrences = new Map<string, number>();

/** Не повторяем одно и то же предупреждение при каждом запросе продолжения. */
let filterMissNotified = false;

function token(): string {
  return get(settings).yandexToken || '';
}

// Feedback and continuation belong to the account that opened the station.
// Never reuse its batch under a newly connected account.
let waveAccount = token();
settings.subscribe(state => {
  const account = state.yandexToken || '';
  if (account !== waveAccount && get(waveActive) && waveProvider === 'yandex') stopWave();
  waveAccount = account;
});

/** Доступна ли серверная станция Яндекса для выбранного источника. */
export function waveAvailable(state = get(settings)): boolean {
  return state.searchSource === 'yandex' && Boolean(state.yandexToken);
}

/**
 * Метка происхождения. По ней плеер отличает трек волны от всего остального — и по её
 * отсутствию понимает, что человек включил что-то своё и волну надо остановить.
 * Идентификатор порции хранится в самом треке, а не рядом: отметку о треке надо присылать
 * именно в его порцию, а к моменту отметки текущая порция может быть уже следующей.
 */
function mark(track: any, sourceBatchId = batchId, station = activeStationId): any {
  return { ...track, waveBatchId: sourceBatchId, waveStation: station };
}

function soundCloudBatch(tracks: any[], seen: ReadonlySet<string>, skipped: ReadonlyMap<string, number>): any[] {
  const state = get(settings), blocked = get(dislikedTracks);
  const unique = new Set<string>(), artists = new Map<string, number>();
  const eligible = tracks.filter(track => track?.id && track.source === 'soundcloud' && !track.isBanned
    && !isTrackDisliked(blocked, track) && !seen.has(scKey(track))
    && trackMatchesWaveGenre(track, state)
    && (state.waveAllowNeuro !== false || !isNeuroTrack(track))
    && (state.waveAllowNeuro !== 'only' || isNeuroTrack(track))
    && (skipped.get(scArtist(track)) || 0) < 2);
  const output: any[] = [];
  for (const allowAdjacent of [false, true]) for (const track of eligible) {
    const identity = scKey(track), artist = scArtist(track);
    if (output.length >= 20) break;
    if (unique.has(identity) || (artists.get(artist) || 0) >= 4
      || (!allowAdjacent && scArtist(output.at(-1)) === artist)) continue;
    output.push(track); unique.add(identity); artists.set(artist, (artists.get(artist) || 0) + 1);
  }
  return output;
}

async function requestSoundCloudBatch(seed: WaveSeed | null, anchor: any, seen = soundCloudSeen, skipped = soundCloudSkippedArtists): Promise<any[]> {
  const api = await import('./api');
  const relatedTo = anchor?.source === 'soundcloud' ? anchor.id : seed?.id;
  const related = relatedTo ? await api.fetchRelatedTracks(relatedTo, 60) : [];
  let tracks = soundCloudBatch(related, seen, skipped);
  if (tracks.length < 10 && !seed) {
    const personal = await api.getTrendingTracks(get(likedTracks), get(listenStats), get(searchHistory), get(playlists), { source: 'soundcloud' });
    tracks = soundCloudBatch([...related, ...personal], seen, skipped);
  }
  return tracks;
}

function markSoundCloudBatch(tracks: any[]): any[] {
  return tracks.map(track => {
    soundCloudSeen.add(scKey(track));
    return { ...track, waveBatchId: soundCloudSession, waveStation: freshPersonal ? `fresh:${waveProvider}` : 'soundcloud' };
  });
}

async function startLocalWave(seedTrack: any, options: { signal?: AbortSignal }, fresh = false, source: 'soundcloud' | 'yandex' = 'soundcloud'): Promise<boolean> {
  const generation = ++waveRequestGeneration;
  localController?.abort();
  const controller = new AbortController();
  localController = controller;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const initial = get(currentTrack);
  const account = token();
  pendingBatch = null;
  const cancelled = () => controller.signal.aborted || generation !== waveRequestGeneration || get(currentTrack) !== initial || (source === 'yandex' && token() !== account);
  const seed: WaveSeed | null = seedTrack ? {
    id: `${seedTrack.id ?? ''}`, title: seedTrack.title, artist: seedTrack.artist, source: 'soundcloud'
  } : null;
  if (seed && !/^\d+$/.test(seed.id)) { notify('Для волны выберите трек SoundCloud.', 'error'); return false; }
  let tracks: any[];
  const timeout = setTimeout(abort, 25000);
  try { tracks = fresh
    ? await abortable(getFreshWaveTracks(source, new Set(), new Map(), undefined, controller.signal), controller.signal)
    : await abortable(requestSoundCloudBatch(seed, seed, new Set(), new Map()), controller.signal); }
  catch (error) {
    if (generation === waveRequestGeneration && !options.signal?.aborted && get(currentTrack) === initial) notify('Не удалось собрать волну. Проверьте соединение и повторите.', 'error');
    return false;
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
  if (cancelled()) return false;
  if (!tracks.length) { notify('Для волны не нашлось подходящих треков. Попробуйте другой трек или ослабьте фильтры.', 'info'); return false; }
  waveProvider = source;
  freshPersonal = fresh;
  waveTasteMode.set(fresh ? 'fresh' : 'service');
  waveSource.set(source);
  soundCloudSession = `${fresh ? 'fresh' : 'soundcloud'}:${generation}`;
  soundCloudSeen.clear(); soundCloudSkippedArtists.clear();
  soundCloudAnchor = seed;
  waveSeed.set(seed);
  sessionOccurrences.clear();
  startedId = '';
  tracks = markSoundCloudBatch(tracks);
  queue.set(tracks.slice(1));
  watchCurrentTrack();
  waveActive.set(true);
  currentTrack.set(tracks[0]);
  isPlaying.set(true);
  return true;
}

function abortable<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function occurrenceCount(track: any): number {
  return sessionOccurrences.get(`${track?.id ?? ''}`) ?? 0;
}

function rememberOccurrences(tracks: any[]): void {
  for (const track of tracks) {
    const id = `${track?.id ?? ''}`;
    if (id) sessionOccurrences.set(id, (sessionOccurrences.get(id) ?? 0) + 1);
  }
}

interface FilteredWaveBatch {
  batchId: string;
  tailId: string;
  tracks: any[];
  station: string;
}

/**
 * Фильтры применяются после ответа Rotor: SoundCloud не сообщает надёжно наличие текста,
 * а Яндекс присылает и жанр альбома, и `lyricsInfo` прямо в объекте трека. Несколько порций
 * просматриваются только при активном фильтре; обычная волна остаётся одним запросом.
 */
async function filteredWaveBatch(
  rawToken: string,
  prevTrackId: string | number | null | undefined,
  targetCount: number,
  seed: WaveSeed | null,
  cancelled = () => false,
  occurrences: ReadonlyMap<string, number> = sessionOccurrences,
  signal?: AbortSignal
): Promise<FilteredWaveBatch> {
  const filterState = get(settings);
  const filtered = hasWaveFilters(filterState);
  const currentDisliked = get(dislikedTracks);
  const hasDislikes = currentDisliked.length > 0;
  const tracks: any[] = [];
  const seen = new Set<string>();
  let latestBatchId = '';
  let cursor = `${prevTrackId ?? ''}`.trim();

  let targetStation = seed ? `track:${seed.id}` : stationForState(filterState);

  const scanBatches = filtered || occurrences.size > 0 || hasDislikes ? FILTER_SCAN_BATCHES : 1;
  for (let attempt = 0; attempt < scanBatches; attempt++) {
    if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
    let batch: any;
    try {
      batch = await yandexWaveBatch(rawToken, cursor || undefined, targetStation, signal);
    } catch (e) {
      if (cancelled()) throw e;
      if (!seed && targetStation !== 'user:onyourwave') {
        // Fallback к обычной волне если специфическая станция не ответила
        batch = await yandexWaveBatch(rawToken, cursor || undefined, 'user:onyourwave', signal);
        targetStation = 'user:onyourwave';
      } else {
        throw e;
      }
    }
    latestBatchId = batch.batchId || latestBatchId;
    if (batch.tracks.length === 0) break;

    const nextCursor = `${batch.tracks[batch.tracks.length - 1]?.id ?? ''}`.trim();
    for (const track of batch.tracks) {
      const id = `${track?.id ?? ''}`;
      if (
        !id ||
        seen.has(id) ||
        (occurrences.get(id) ?? 0) >= MAX_TRACK_OCCURRENCES ||
        isTrackDisliked(currentDisliked, track) ||
        !trackMatchesWaveFilters(track, filterState)
      ) continue;
      seen.add(id);
      tracks.push(mark(track, batch.batchId || latestBatchId, targetStation));
    }

    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    if (tracks.length >= targetCount) break;
  }

  // Если выбран режим "только нейро" и из ротора не набралось достаточно треков,
  // дополняем проверенными нейротреками напрямую из каталога Яндекса
  if (!seed && filterState.waveAllowNeuro === 'only' && tracks.length < targetCount) {
    const needed = targetCount - tracks.length + 5;
    const neuroTracks = await fetchNeuroTracksFromYandex(rawToken, needed);
    for (const track of neuroTracks) {
      const id = `${track?.id ?? ''}`;
      if (!id || seen.has(id) || occurrenceCount(track) >= MAX_TRACK_OCCURRENCES) continue;
      seen.add(id);
      tracks.push(mark(track, latestBatchId || 'neuro-batch', 'neuro-search'));
      if (tracks.length >= targetCount) break;
    }
  }

  return { batchId: latestBatchId, tailId: cursor, tracks, station: targetStation };
}

/**
 * Начать волну. `true` — играет; `false` — не получилось, причина уже показана человеку.
 *
 * Повторный запуск во время игры — это осознанный жест «собери заново»: станция отдаёт новую
 * порцию с учётом всего, что человек успел пропустить и дослушать.
 */
export async function startWave(
  seedTrack?: { id?: string | number; title: string; artist?: string; source: string } | null,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  if (!secretsAreReady()) {
    const generation = ++waveRequestGeneration;
    const initial = get(currentTrack);
    await whenSecretsReady();
    if (generation !== waveRequestGeneration || options.signal?.aborted || get(currentTrack) !== initial) return false;
  }
  if (!seedTrack && get(settings).waveFreshTaste === true) {
    const source = get(settings).searchSource === 'yandex' ? 'yandex' : 'soundcloud';
    if (source === 'yandex' && !token()) { notify('Подключите Яндекс Музыку в настройках сервисов.', 'error'); return false; }
    return startLocalWave(null, options, true, source);
  }
  if (seedTrack?.source === 'soundcloud' || (!seedTrack && !waveAvailable())) {
    return startLocalWave(seedTrack, options);
  }
  const requestGeneration = ++waveRequestGeneration;
  pendingBatch = null;
  const t = token();
  const initialTrack = get(currentTrack);
  const cancelled = () => options.signal?.aborted === true || requestGeneration !== waveRequestGeneration || token() !== t || get(currentTrack) !== initialTrack;
  if (!t) {
    notify('Подключите Яндекс Музыку в разделе «Настройки» - «Сервисы», затем включите волну снова.', 'error');
    return false;
  }

  const seed: WaveSeed | null = seedTrack ? {
    id: `${seedTrack.id ?? ''}`.split(':')[0], title: seedTrack.title, artist: seedTrack.artist, source: 'yandex'
  } : null;
  if (seedTrack && (seedTrack.source !== 'yandex' || !/^\d+$/.test(seed!.id))) {
    notify('Для волны по треку выберите трек Яндекс Музыки.', 'error');
    return false;
  }

  // «Собрать заново» во время активной волны продолжает тот же сеанс и сохраняет лимит
  // повторов. Новый запуск после остановки начинает чистую историю.
  const sameStation = waveProvider === 'yandex' && get(waveSeed)?.id === seed?.id;
  const occurrences = get(waveActive) && sameStation ? sessionOccurrences : new Map<string, number>();

  let batch: FilteredWaveBatch;
  try {
    batch = await filteredWaveBatch(t, null, FILTER_TARGET_TRACKS, seed, cancelled, occurrences, options.signal);
  } catch (e) {
    if (cancelled()) return false;
    console.error('[волна] станция не ответила', e);
    const reason = e instanceof Error ? e.message.trim() : '';
    notify(seed ? `Не удалось включить волну по треку «${seed.title}». ${reason || 'Яндекс Музыка не ответила. Попробуйте снова.'}` : reason || 'Волна не собралась: Яндекс Музыка не ответила', 'error');
    return false;
  }

  // A manual selection can happen while Yandex is preparing the first batch.
  // An old response must never replace the queue the listener just chose.
  if (cancelled()) return false;

  if (batch.tracks.length === 0) {
    const filter = describeWaveFilters(get(settings));
    notify(
      filter
        ? `По фильтру «${filter}» треков не нашлось — попробуйте ослабить условия`
        : 'Волна не собралась: станция не отдала ни одного трека',
      'error'
    );
    return false;
  }

  batchId = batch.batchId;
  waveProvider = 'yandex';
  localController?.abort();
  freshPersonal = false;
  waveTasteMode.set('service');
  waveSource.set('yandex');
  soundCloudSeen.clear(); soundCloudSkippedArtists.clear(); soundCloudAnchor = null;
  if (occurrences !== sessionOccurrences) sessionOccurrences.clear();
  activeStationId = batch.station;
  waveSeed.set(seed);
  pendingBatch = null;
  const tracks = batch.tracks;
  rememberOccurrences(tracks);
  tailId = batch.tailId || `${tracks[tracks.length - 1].id}`;
  startedId = '';
  filterMissNotified = false;

  // Отметка о запуске станции — до первого трека, как это делают клиенты Яндекса.
  yandexWaveFeedback(t, 'radioStarted', { batchId: tracks[0].waveBatchId || batchId, station: tracks[0].waveStation || activeStationId });

  // Очередь ставим раньше трека: реакция плеера на `currentTrack` синхронная, и к моменту,
  // когда он начнёт грузить первый трек, остальная порция должна уже лежать на месте.
  queue.set(tracks.slice(1));
  // Наблюдатель — до подъёма флага, и это важно: `subscribe` вызывает обработчик сразу, с
  // тем, что играет прямо сейчас. При поднятом флаге он увидел бы трек без метки волны
  // (человек ведь что-то слушал до нажатия) и тут же погасил бы только что начатую волну.
  watchCurrentTrack();
  waveActive.set(true);
  currentTrack.set(tracks[0]);
  isPlaying.set(true);
  return true;
}

/** Остановить волну. Играющий трек не трогаем — останавливается только докладка порций. */
export function stopWave(): void {
  waveRequestGeneration++;
  localController?.abort(); localController = null;
  freshPersonal = false;
  waveTasteMode.set('service');
  waveActive.set(false);
  waveSeed.set(null);
  waveSource.set(null);
  batchId = '';
  tailId = '';
  startedId = '';
  pendingBatch = null;
  filterMissNotified = false;
  activeStationId = 'user:onyourwave';
  sessionOccurrences.clear();
  soundCloudSeen.clear(); soundCloudSkippedArtists.clear(); soundCloudAnchor = null; soundCloudSession = '';
  waveProvider = 'yandex';
}

/**
 * Следит за тем, что играет: отмечает начало трека волны и гасит волну, когда человек включил
 * что-то своё (из поиска, лайков, плейлиста — у такого трека метки волны нет).
 *
 * Подписка ставится один раз и не снимается. Снимать её изнутри собственного обработчика —
 * лишний риск на ровном месте (`stopWave` вызывается как раз оттуда), а стоит она одного
 * сравнения на переключение трека; когда волна выключена, обработчик выходит первой строкой.
 */
let watching = false;
function watchCurrentTrack(): void {
  if (watching) return;
  watching = true;

  currentTrack.subscribe((track) => {
    if (!get(waveActive)) return;

    if (!track?.waveBatchId) {
      // Ничего не играет — это пауза между треками внутри волны, а не уход из неё.
      if (track) stopWave();
      return;
    }

    if (localWave() && track.waveBatchId !== soundCloudSession) {
      stopWave();
      return;
    }
    const id = `${track.id}`;
    if (id === startedId) return; // повторный запуск того же трека: станции это не новость
    startedId = id;
    if (localWave()) {
      return;
    }
    yandexWaveFeedback(token(), 'trackStarted', {
      batchId: track.waveBatchId,
      trackId: track.id,
      station: track.waveStation || activeStationId
    });
  });
}

/**
 * Отметить, чем закончился трек волны.
 *
 * `dropped` — трек не сыграл по нашей вине (не дали ссылку на поток, оборвалась сеть). Такое
 * не отмечается вовсе: `skip` для станции — это «не нравится», и записывать в нелюбимое трек,
 * который человек даже не услышал, значит портить ему волну молча.
 */
export function waveTrackDone(
  track: any,
  playedSeconds: number,
  outcome: 'finished' | 'skip' | 'dropped'
): void {
  if (!get(waveActive) || !track?.waveBatchId || outcome === 'dropped') return;
  if (localWave()) {
    if (track.waveBatchId !== soundCloudSession) return;
    if (outcome === 'skip') {
      const artist = scArtist(track);
      soundCloudSkippedArtists.set(artist, (soundCloudSkippedArtists.get(artist) || 0) + 1);
      queue.update(list => list.filter(item => (soundCloudSkippedArtists.get(scArtist(item)) || 0) < 2));
    } else if (playedSeconds >= Math.min(40, (Number(track.duration) || 80000) / 2000)) {
      soundCloudAnchor = track;
    }
    return;
  }
  yandexWaveFeedback(token(), outcome === 'skip' ? 'skip' : 'trackFinished', {
    batchId: track.waveBatchId,
    trackId: track.id,
    playedSeconds,
    station: track.waveStation || activeStationId
  });
}

/**
 * Долить очередь, если она подходит к концу.
 *
 * Ждём ответа только когда очередь пуста — иначе плееру нечего включать следующим. Во всех
 * остальных случаях запрос уходит в фоне: пауза между треками ради запаса, который и так
 * приедет, никому не нужна.
 */
export async function waveRefill(): Promise<void> {
  if (!get(waveActive)) return;
  const left = get(queue).length;
  if (left > REFILL_AT) return;

  const job = fetchBatch();
  if (left === 0) await job;
}

async function fetchBatch(): Promise<void> {
  if (pendingBatch) return pendingBatch;
  const requestGeneration = waveRequestGeneration;

  pendingBatch = (async () => {
    try {
      const rawToken = token();
      const cancelled = () => !get(waveActive) || requestGeneration !== waveRequestGeneration || (waveProvider === 'yandex' && rawToken !== token());
      if (localWave()) {
        const controller = new AbortController();
        localController = controller;
        const timeout = setTimeout(() => controller.abort(), 25000);
        let tracks: any[];
        try { tracks = await abortable(freshPersonal
          ? getFreshWaveTracks(waveProvider, soundCloudSeen, soundCloudSkippedArtists, soundCloudAnchor, controller.signal)
          : requestSoundCloudBatch(get(waveSeed), soundCloudAnchor), controller.signal); }
        finally { clearTimeout(timeout); }
        if (!cancelled()) queue.update(list => [...list, ...markSoundCloudBatch(tracks)]);
        return;
      }
      const batch = await filteredWaveBatch(rawToken, tailId, FILTER_TARGET_TRACKS, get(waveSeed), cancelled);
      // Пока шёл запрос, волну могли остановить — тогда порция уже никому не нужна.
      if (cancelled()) return;
      if (batch.batchId) batchId = batch.batchId;
      // Хвост двигаем и при пустом результате фильтра, иначе следующий запрос принёс бы
      // те же неподходящие порции по кругу.
      if (batch.tailId) tailId = batch.tailId;

      // Станция изредка присылает трек, который уже лежит в очереди или играет прямо сейчас.
      // Повтор через минуту выглядит как сбой плеера, поэтому такие отбрасываем.
      const known = new Set(get(queue).map((t: any) => `${t.id}`));
      const playing = get(currentTrack);
      if (playing?.id) known.add(`${playing.id}`);

      const fresh = batch.tracks.filter((t: any) => !known.has(`${t.id}`));
      if (fresh.length > 0) {
        filterMissNotified = false;
        rememberOccurrences(fresh);
        queue.update((q) => [...q, ...fresh]);
      } else if (hasWaveFilters(get(settings)) && !filterMissNotified) {
        filterMissNotified = true;
        notify('По текущим фильтрам пока не нашлось продолжения для волны', 'info');
      }
    } catch (e) {
      // Порция не пришла — волна не рвётся: плеер доиграет очередь и попросит ещё раз.
      console.warn('[волна] порция не пришла', e);
    } finally {
      if (requestGeneration === waveRequestGeneration) pendingBatch = null;
    }
  })();

  return pendingBatch;
}
