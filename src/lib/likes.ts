/**
 * Лайки: одна точка правды и сверка с источниками.
 *
 * До этого модуля «Любимое» было списком, который умел только расти. Отметка ставилась в
 * четырёх местах четырьмя копиями одного и того же кода (плеер, поиск, библиотека, архивная
 * станция), никуда не отправлялась, а в аккаунт Яндекса и в профиль SoundCloud человек ходил
 * вручную через две кнопки в настройках — и обе делали ровно одно: добавляли то, чего здесь
 * нет. Из этого следовали три вещи, каждая из которых выглядела как баг:
 *
 *   1. Лайк, поставленный в приложении на треке Яндекса, в аккаунте не появлялся. То есть в
 *      веб-плеере его не было, и на другом устройстве тоже.
 *   2. Лайк, снятый в аккаунте, здесь оставался навсегда — списки расходились тем сильнее,
 *      чем дольше приложением пользовались.
 *   3. Про пункты 1 и 2 надо было знать и нажимать кнопку.
 *
 * Теперь состояние сводится при каждом запуске (см. `+layout.svelte`), а отметка проходит
 * через `setTrackLiked` и уезжает в Яндекс.
 *
 * ── Почему сверка трёхсторонняя ──────────────────────────────────────────────────────────
 * Наивное «взять список с сервера и сделать локальный таким же» стирает лайки: у человека
 * есть отметки, которых на сервере нет и быть не может — треки другого источника, локальные
 * файлы, да и просто ещё не отправленные. Наивное «добавить то, чего нет» не замечает
 * снятых. Поэтому кроме серверного и локального списка хранится третий — снимок того, что
 * на сервере лежало в прошлый раз (`seen`). Он и отвечает на вопрос, которого без него
 * задать нельзя: трека нет на сервере, потому что лайк сняли, или потому что его там никогда
 * не было?
 *
 *   есть на сервере, нет здесь          → добавить (лайк поставили в вебе)
 *   нет на сервере, здесь есть, был в снимке → убрать (лайк сняли в вебе)
 *   нет на сервере, здесь есть, в снимке не было → не трогать (наш лайк, сервер его не знает)
 *
 * ── Чего этот модуль осознанно не делает ─────────────────────────────────────────────────
 * Не отправляет отметки в SoundCloud. Не «пока не отправляет» — отправить их нечем:
 * приложение работает с SoundCloud по анонимному `client_id`, выковырянному из скриптов
 * сайта (см. `getSoundCloudClientId`), а лайк требует OAuth-токен аккаунта, которого у
 * приложения нет. Поэтому снятые здесь SoundCloud-лайки помнятся локально (`scRemoved`) —
 * иначе следующая же сверка возвращала бы их обратно, и снять лайк было бы невозможно.
 */

import { get } from 'svelte/store';
import { likedTracks, settings, notify } from './stores';
import { withCount } from './utils/plural';

type SourceKey = 'yandex' | 'soundcloud';

const STATE_KEY = 'lomifynext_likes_sync';

interface SyncState {
  /**
   * Что лежало в лайках источника при последней ПОЛНОЙ сверке. `null` — сверки ещё не было,
   * и это единственное состояние, в котором зеркало ничего не удаляет: без снимка «нет на
   * сервере» неотличимо от «сервер об этом никогда не знал».
   */
  seen: Record<SourceKey, string[] | null>;
  /** SoundCloud: снятое здесь. Отправить это в профиль нечем, поэтому помним сами. */
  scRemoved: string[];
  /** Яндекс: отметки, ещё не доехавшие до аккаунта (не было сети, отказало API). */
  ymQueue: { add: string[]; remove: string[] };
}

function emptyState(): SyncState {
  return {
    seen: { yandex: null, soundcloud: null },
    scRemoved: [],
    ymQueue: { add: [], remove: [] },
  };
}

function loadState(): SyncState {
  if (typeof localStorage === 'undefined') return emptyState();
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    const base = emptyState();
    return {
      seen: {
        yandex: Array.isArray(parsed?.seen?.yandex) ? parsed.seen.yandex : base.seen.yandex,
        soundcloud: Array.isArray(parsed?.seen?.soundcloud)
          ? parsed.seen.soundcloud
          : base.seen.soundcloud,
      },
      scRemoved: Array.isArray(parsed?.scRemoved) ? parsed.scRemoved : [],
      ymQueue: {
        add: Array.isArray(parsed?.ymQueue?.add) ? parsed.ymQueue.add : [],
        remove: Array.isArray(parsed?.ymQueue?.remove) ? parsed.ymQueue.remove : [],
      },
    };
  } catch (e) {
    // Испорченный снимок — это «сверки не было»: хуже потерять историю сверок, чем принять
    // мусор за состояние сервера и по нему что-то удалить.
    console.warn('[likes] снимок сверки не читается, начинаю заново', e);
    return emptyState();
  }
}

function saveState(state: SyncState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[likes] снимок сверки не сохранился', e);
  }
}

/** Идентификатор трека у источника. `null` — синхронизировать нечего (локальный файл). */
function trackId(track: any): string | null {
  const id = `${track?.id ?? ''}`.trim();
  return id ? id : null;
}

/**
 * Тот же трек или нет.
 *
 * Сравнение по названию и артисту, а не по id, — то же, что делает интерфейс во всех местах,
 * где рисуется сердечко. Это не мелочь: одна песня приезжает из Яндекса и из SoundCloud с
 * разными id, и если считать её двумя разными треками, в «Любимом» окажутся два одинаковых
 * ряда, оба с закрашенным сердечком, а щелчок по одному будет гасить второй.
 */
function sameTrack(a: any, b: any): boolean {
  return a?.title === b?.title && a?.artist === b?.artist;
}

/** Лежит ли трек в «Любимом». Ровно та проверка, по которой интерфейс красит сердечко. */
export function isTrackLiked(list: any[], track: any): boolean {
  if (!track) return false;
  return list.some((t) => sameTrack(t, track));
}

/**
 * Поставить или снять отметку. Единственный способ изменить лайк — иначе отметка не уедет в
 * аккаунт, а снятая вернётся при следующей сверке.
 */
export function setTrackLiked(track: any, liked: boolean): void {
  if (!track) return;
  const list = get(likedTracks);
  const matches = list.filter((t) => sameTrack(t, track));

  if (liked) {
    if (matches.length > 0) return;
    likedTracks.set([track, ...list]);
    rememberIntent(track, true);
    return;
  }

  if (matches.length === 0) return;
  likedTracks.set(list.filter((t) => !sameTrack(t, track)));
  // Снимаем отметку у каждой записи, которая ушла из списка, а не у того объекта, что
  // передали: одна и та же песня могла попасть в «Любимое» и из Яндекса, и из SoundCloud, а
  // «снять лайк» относится к обеим — иначе один из источников вернёт её на следующей сверке.
  for (const match of matches) rememberIntent(match, false);
}

/** Переключить отметку. Возвращает новое состояние — по нему вызывающий пишет уведомление. */
export function toggleTrackLike(track: any): boolean {
  const liked = !isTrackLiked(get(likedTracks), track);
  setTrackLiked(track, liked);
  return liked;
}

/** Запомнить намерение и, если источник умеет принимать отметки, отправить его. */
function rememberIntent(track: any, liked: boolean): void {
  const id = trackId(track);
  if (!id) return;

  const state = loadState();

  if (track.source === 'yandex') {
    // Противоположная отметка по тому же треку из очереди уходит: последнее слово за
    // человеком, а не за порядком отправки.
    state.ymQueue.add = state.ymQueue.add.filter((x) => x !== id);
    state.ymQueue.remove = state.ymQueue.remove.filter((x) => x !== id);
    (liked ? state.ymQueue.add : state.ymQueue.remove).push(id);
    saveState(state);
    // Не ждём: интерфейс уже показал результат, а отправка — дело фоновое. Не получилось
    // сейчас — отметка осталась в очереди и уедет при следующей сверке.
    void flushYandexQueue();
    return;
  }

  if (track.source === 'soundcloud') {
    const without = state.scRemoved.filter((x) => x !== id);
    state.scRemoved = liked ? without : [...without, id];
    saveState(state);
  }
}

/** Что удалось отправить в аккаунт за один разбор очереди. */
interface FlushResult {
  add: string[];
  remove: string[];
}

let flushing: Promise<FlushResult> | null = null;

/**
 * Разобрать очередь отметок Яндекса.
 *
 * Один разбор за раз: очередь живёт в localStorage, и два одновременных прохода отправили бы
 * одни и те же отметки дважды, а потом затёрли друг другу состояние.
 */
export function flushYandexQueue(): Promise<FlushResult> {
  if (flushing) return flushing;
  flushing = runFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush(): Promise<FlushResult> {
  const done: FlushResult = { add: [], remove: [] };
  const token = get(settings).yandexToken;
  if (!token) return done;

  const queue = loadState().ymQueue;
  if (queue.add.length === 0 && queue.remove.length === 0) return done;

  const { yandexSetLikes } = await import('./yandex');

  for (const liked of [true, false]) {
    const ids = liked ? queue.add : queue.remove;
    if (ids.length === 0) continue;
    try {
      await yandexSetLikes(token, ids, liked);
    } catch (e) {
      // Отметка остаётся в очереди — попробуем при следующем запуске. Молча: это фон, а
      // человек своё действие уже видел выполненным, и он в нём не ошибся.
      console.warn('[likes] Яндекс не принял отметки', { liked, count: ids.length }, e);
      continue;
    }

    // Состояние перечитываем: пока шёл запрос, человек мог отметить что-то ещё, и запись
    // «того, что было в начале» потеряла бы его действие.
    const state = loadState();
    const key = liked ? 'add' : 'remove';
    state.ymQueue[key] = state.ymQueue[key].filter((id) => !ids.includes(id));
    // Снимок обязан узнать об отправленном сразу. Иначе следующая сверка увидит свежий лайк
    // как «поставленный только здесь» и отправит его повторно, а свежее снятие — как
    // «появившийся на сервере» и вернёт отметку обратно.
    const seen = state.seen.yandex;
    if (seen) {
      state.seen.yandex = liked
        ? [...new Set([...seen, ...ids])]
        : seen.filter((id) => !ids.includes(id));
    }
    saveState(state);

    (liked ? done.add : done.remove).push(...ids);
  }

  return done;
}

/** Источник, с которым сверяемся. */
interface Side {
  source: SourceKey;
  /** Название для человека — уходит в текст уведомления об отказе. */
  label: string;
  read(): Promise<{ tracks: any[]; complete: boolean }>;
  /**
   * Идентификаторы, по которым серверному ответу сейчас нельзя верить: отметки, отправленные
   * только что или ещё стоящие в очереди. Реплика API отвечает не мгновенно, и трек, лайк
   * которому поставили секунду назад, в ответе может ещё не значиться — принять это за
   * «лайк сняли» значит стереть отметку сразу после того, как человек её поставил.
   */
  inFlight: Set<string>;
}

export interface LikesSyncResult {
  added: number;
  removed: number;
  /** Была ли хоть одна привязка, с которой есть что сверять. */
  ran: boolean;
  /** Источники, которые не ответили вовсе. */
  failed: string[];
  /** Источники, ответившие не полностью: по ним зеркало на этот раз ничего не удаляло. */
  partial: string[];
}

let syncing: { promise: Promise<LikesSyncResult>; silent: boolean } | null = null;

/**
 * Свести «Любимое» с лайками привязанных аккаунтов.
 *
 * `silent` — режим автоматического запуска: об отказах пишем в консоль, а не человеку. При
 * старте приложения он ещё ничего не просил, и уведомление про отвалившийся SoundCloud было
 * бы жалобой на погоду. Изменения показываем всегда — они как раз то, чего от сверки ждут.
 */
export function syncLikes(opts: { silent?: boolean; only?: SourceKey } = {}): Promise<LikesSyncResult> {
  const silent = opts.silent === true;

  // Сверка при запуске уже идёт, а человек нажал кнопку в настройках — отдаём тот же проход,
  // а не второй поверх него: они читают и пишут одни и те же списки.
  if (syncing) {
    const running = syncing;
    if (silent || !running.silent) return running.promise;
    // Тот проход тихий, а этот — по нажатию, и нажатие обязано получить ответ. Изменения он
    // покажет и сам (о них говорят в любом режиме), поэтому добираем только пустой исход:
    // без этого кнопка отработала бы молча и выглядела бы сломанной.
    return running.promise.then((r) => {
      if (r.added === 0 && r.removed === 0) report(r, false);
      return r;
    });
  }

  const promise = runSync(opts).finally(() => {
    syncing = null;
  });
  syncing = { promise, silent };
  return promise;
}

async function runSync(opts: { silent?: boolean; only?: SourceKey }): Promise<LikesSyncResult> {
  const result: LikesSyncResult = { added: 0, removed: 0, ran: false, failed: [], partial: [] };
  const config = get(settings);
  const wanted = (source: SourceKey) => !opts.only || opts.only === source;

  const sides: Side[] = [];

  if (wanted('yandex') && config.yandexToken) {
    const token = config.yandexToken;
    // Сначала отдаём аккаунту то, что человек отметил здесь, и только потом читаем: иначе
    // прочитанное состояние заведомо старше локального, и сверка приняла бы наши же
    // неотправленные отметки за чужие изменения.
    const sent = await flushYandexQueue();
    const queue = loadState().ymQueue;
    sides.push({
      source: 'yandex',
      label: 'Яндекс Музыка',
      read: async () => {
        const { getYandexLikes } = await import('./yandex');
        return getYandexLikes(token);
      },
      inFlight: new Set([...sent.add, ...sent.remove, ...queue.add, ...queue.remove]),
    });
  }

  if (wanted('soundcloud') && config.scUser?.id) {
    const userId = config.scUser.id;
    sides.push({
      source: 'soundcloud',
      label: 'SoundCloud',
      read: async () => {
        const { getUserLikes } = await import('./api');
        return getUserLikes(userId);
      },
      // Отправлять отметки в SoundCloud нечем, поэтому в полёте у него ничего быть не может.
      inFlight: new Set<string>(),
    });
  }

  if (sides.length === 0) return result;
  result.ran = true;

  // По одному источнику за раз: они независимы, но каждый читает и пишет `likedTracks` и
  // снимок, а параллельный проход дал бы гонку за одни и те же списки.
  for (const side of sides) {
    try {
      await mergeSide(side, result);
    } catch (e) {
      console.warn(`[likes] ${side.label}: сверка не прошла`, e);
      result.failed.push(side.label);
      if (!opts.silent) {
        const message = e instanceof Error ? e.message : '';
        notify(message ? `${side.label}: ${message}` : `${side.label} не ответила`, 'error');
      }
    }
  }

  report(result, opts.silent === true);
  return result;
}

async function mergeSide(side: Side, result: LikesSyncResult): Promise<void> {
  const { tracks, complete } = await side.read();

  const remote = new Map<string, any>();
  for (const track of tracks) {
    const id = trackId(track);
    if (id) remote.set(id, track);
  }

  const state = loadState();
  const seen = state.seen[side.source];
  const seenSet = new Set(seen ?? []);

  /*
   * Удалять можно только по полному ответу и только имея снимок.
   *
   * Цена ошибки здесь несимметрична, и это решает вопрос. Лишний трек в «Любимом» человек
   * убирает одним щелчком; стёртые двести лайков не вернуть ничем — ни в приложении, ни на
   * стороне источника, потому что там они и не менялись. Поэтому оборванный ответ (сеть
   * отвалилась на середине, API ответил лимитом на третьем чанке) в зеркало не идёт вовсе:
   * от «человек снял двести лайков» он неотличим.
   */
  const mayRemove = complete && seen !== null;
  if (!complete) result.partial.push(side.label);

  const local = get(likedTracks);
  const localIds = new Set<string>();
  for (const track of local) {
    if (track?.source !== side.source) continue;
    const id = trackId(track);
    if (id) localIds.add(id);
  }

  const gone = new Set<string>();
  if (mayRemove) {
    for (const id of localIds) {
      if (seenSet.has(id) && !remote.has(id) && !side.inFlight.has(id)) gone.add(id);
    }
  }

  const scRemoved = new Set(state.scRemoved);
  const incoming = [...remote.entries()]
    .filter(([id]) => !localIds.has(id))
    .filter(([id]) => !side.inFlight.has(id))
    // Снятое здесь не возвращаем. Для SoundCloud это единственная причина, по которой снять
    // лайк вообще возможно: отправить снятие в профиль нечем, и без этой памяти сверка
    // возвращала бы трек обратно каждый запуск.
    .filter(([id]) => !(side.source === 'soundcloud' && scRemoved.has(id)))
    .map(([, track]) => track);

  let added = 0;
  let removed = 0;
  if (gone.size > 0 || incoming.length > 0) {
    likedTracks.update((list) => {
      let next = list;
      if (gone.size > 0) {
        next = next.filter((track) => {
          if (track?.source !== side.source) return true;
          const id = trackId(track);
          return !(id && gone.has(id));
        });
        removed = list.length - next.length;
      }
      // Дубли по названию и артисту не заводим: см. `sameTrack` — интерфейс считает такие
      // записи одним треком, и второй ряд выглядел бы сбоем отрисовки.
      const fresh = incoming.filter((track) => !next.some((existing) => sameTrack(existing, track)));
      added = fresh.length;
      // Новое сверху — так же, как делал ручной импорт: свежий лайк из веба человек ищет в
      // начале списка, а не в конце.
      return fresh.length > 0 ? [...fresh, ...next] : next;
    });
  }

  result.added += added;
  result.removed += removed;

  // Снимок обновляем только по полному ответу: записать в него огрызок значит забыть часть
  // серверных отметок, и снятие любой из них потом уже не отследить.
  if (!complete) return;

  // Состояние перечитываем — пока шло чтение, человек мог отметить что-то ещё, и его
  // действие уже попало в очередь и в `scRemoved`.
  const fresh = loadState();
  fresh.seen[side.source] = [...remote.keys()];
  if (side.source === 'soundcloud') {
    // Помнить снятое нужно, пока оно лежит в лайках профиля. Исчезло оттуда — память о нём
    // больше ни на что не влияет, и держать её значит копить список без конца.
    fresh.scRemoved = fresh.scRemoved.filter((id) => remote.has(id));
  }
  saveState(fresh);
}

/** Итог сверки человеку. Молчим, когда ничего не изменилось: это самый частый исход. */
function report(result: LikesSyncResult, silent: boolean): void {
  const { added, removed } = result;

  if (added > 0 && removed > 0) {
    notify(`Лайки обновлены: +${added}, −${removed}`, 'success');
    return;
  }
  if (added > 0) {
    notify(`Подтянул ${withCount(added, 'новый лайк', 'новых лайка', 'новых лайков')}`, 'success');
    return;
  }
  if (removed > 0) {
    notify(
      `Убрал ${withCount(removed, 'лайк', 'лайка', 'лайков')} — ${
        removed === 1 ? 'его' : 'их'
      } сняли в источнике`,
      'info'
    );
    return;
  }

  if (silent) return;
  if (result.failed.length > 0) return; // про отказ уже сказали
  if (result.partial.length > 0) {
    notify(`${result.partial.join(', ')}: список пришёл не целиком, сверю в следующий раз`, 'info');
    return;
  }
  notify(result.ran ? 'Лайки уже сходятся' : 'Аккаунты не привязаны — сверять нечего', 'info');
}
