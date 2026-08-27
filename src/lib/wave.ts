/**
 * «Моя волна» — бесконечный персональный поток Яндекс Музыки.
 *
 * Отличие от кнопки, которая была на главной раньше: та собирала лежащее в тренде SoundCloud
 * один раз и складывала в очередь — то есть обычный плейлист, который кончается и ни на что не
 * реагирует. Волна ведёт себя как в приложении Яндекса: очередь не кончается (порция
 * докладывается заранее, ещё до того как играющее закончится), а пропуски и дослушивания
 * уходят обратно на станцию, и следующая порция собирается уже с их учётом.
 *
 * Почему это отдельный модуль, а не код в плеере или в шапке главной. Состояние сеанса —
 * идентификатор порции, хвост для продолжения, признак «волна играет» — нужно сразу троим:
 * кнопке (запустить), плееру (доложить порцию и отметить исход трека) и любому месту, которое
 * захочет показать, что играет волна. Держать его в компоненте нельзя: шапка главной
 * размонтируется, стоит уйти с главной, и вместе с ней исчез бы сеанс.
 *
 * Состояние живёт только в памяти и намеренно не переживает перезапуск: порция и её `batchId`
 * — это открытый сеанс на стороне станции, и восстанавливать его из localStorage значило бы
 * присылать отметки в порцию, о которой станция уже забыла.
 */

import { writable, get } from 'svelte/store';
import { settings, queue, currentTrack, isPlaying, notify } from './stores';
import { yandexWaveBatch, yandexWaveFeedback } from './yandex';
import {
  describeWaveFilters,
  hasWaveFilters,
  trackMatchesWaveFilters
} from './waveFilters';

/** Играет ли сейчас волна. Плеер смотрит на это, чтобы докладывать порции. */
export const waveActive = writable(false);

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

/** Доступна ли волна: она персональная, и без аккаунта Яндекса её просто нет. */
export function waveAvailable(state = get(settings)): boolean {
  return state.searchSource === 'yandex' && Boolean(state.yandexToken);
}

/**
 * Метка происхождения. По ней плеер отличает трек волны от всего остального — и по её
 * отсутствию понимает, что человек включил что-то своё и волну надо остановить.
 * Идентификатор порции хранится в самом треке, а не рядом: отметку о треке надо присылать
 * именно в его порцию, а к моменту отметки текущая порция может быть уже следующей.
 */
function mark(track: any, sourceBatchId = batchId): any {
  return { ...track, waveBatchId: sourceBatchId };
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
}

/**
 * Фильтры применяются после ответа Rotor: SoundCloud не сообщает надёжно наличие текста,
 * а Яндекс присылает и жанр альбома, и `lyricsInfo` прямо в объекте трека. Несколько порций
 * просматриваются только при активном фильтре; обычная волна остаётся одним запросом.
 */
async function filteredWaveBatch(
  rawToken: string,
  prevTrackId: string | number | null | undefined,
  targetCount: number
): Promise<FilteredWaveBatch> {
  const filterState = get(settings);
  const filtered = hasWaveFilters(filterState);
  const tracks: any[] = [];
  const seen = new Set<string>();
  let latestBatchId = '';
  let cursor = `${prevTrackId ?? ''}`.trim();

  const scanBatches = filtered || sessionOccurrences.size > 0 ? FILTER_SCAN_BATCHES : 1;
  for (let attempt = 0; attempt < scanBatches; attempt++) {
    const batch = await yandexWaveBatch(rawToken, cursor || undefined);
    latestBatchId = batch.batchId || latestBatchId;
    if (batch.tracks.length === 0) break;

    const nextCursor = `${batch.tracks[batch.tracks.length - 1]?.id ?? ''}`.trim();
    for (const track of batch.tracks) {
      const id = `${track?.id ?? ''}`;
      if (
        !id ||
        seen.has(id) ||
        occurrenceCount(track) >= MAX_TRACK_OCCURRENCES ||
        !trackMatchesWaveFilters(track, filterState)
      ) continue;
      seen.add(id);
      tracks.push(mark(track, batch.batchId || latestBatchId));
    }

    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    if (tracks.length >= targetCount) break;
  }

  return { batchId: latestBatchId, tailId: cursor, tracks };
}

/**
 * Начать волну. `true` — играет; `false` — не получилось, причина уже показана человеку.
 *
 * Повторный запуск во время игры — это осознанный жест «собери заново»: станция отдаёт новую
 * порцию с учётом всего, что человек успел пропустить и дослушать.
 */
export async function startWave(): Promise<boolean> {
  const t = token();
  if (!t) {
    notify('Волна работает от аккаунта Яндекс Музыки — вставьте токен в настройках', 'error');
    return false;
  }

  // «Собрать заново» во время активной волны продолжает тот же сеанс и сохраняет лимит
  // повторов. Новый запуск после остановки начинает чистую историю.
  if (!get(waveActive)) sessionOccurrences.clear();

  let batch: FilteredWaveBatch;
  try {
    batch = await filteredWaveBatch(t, null, FILTER_TARGET_TRACKS);
  } catch (e) {
    console.error('[волна] станция не ответила', e);
    const reason = e instanceof Error ? e.message.trim() : '';
    notify(reason || 'Волна не собралась: Яндекс Музыка не ответила', 'error');
    return false;
  }

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
  const tracks = batch.tracks;
  rememberOccurrences(tracks);
  tailId = batch.tailId || `${tracks[tracks.length - 1].id}`;
  startedId = '';
  filterMissNotified = false;

  // Отметка о запуске станции — до первого трека, как это делают клиенты Яндекса.
  yandexWaveFeedback(t, 'radioStarted', { batchId: tracks[0].waveBatchId || batchId });

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
  if (!get(waveActive)) return;
  waveActive.set(false);
  batchId = '';
  tailId = '';
  startedId = '';
  pendingBatch = null;
  filterMissNotified = false;
  sessionOccurrences.clear();
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

    const id = `${track.id}`;
    if (id === startedId) return; // повторный запуск того же трека: станции это не новость
    startedId = id;
    yandexWaveFeedback(token(), 'trackStarted', { batchId: track.waveBatchId, trackId: track.id });
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
  yandexWaveFeedback(token(), outcome === 'skip' ? 'skip' : 'trackFinished', {
    batchId: track.waveBatchId,
    trackId: track.id,
    playedSeconds,
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

  pendingBatch = (async () => {
    try {
      const batch = await filteredWaveBatch(token(), tailId, FILTER_TARGET_TRACKS);
      // Пока шёл запрос, волну могли остановить — тогда порция уже никому не нужна.
      if (!get(waveActive)) return;
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
      pendingBatch = null;
    }
  })();

  return pendingBatch;
}
