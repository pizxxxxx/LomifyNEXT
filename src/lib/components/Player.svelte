<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Volume2, SkipBack, SkipForward, Shuffle, Repeat, Mic2, Radio, Heart, Share2, Download, Check, Trash2, Loader2 } from 'lucide-svelte';
  import { MorphIcon } from 'morphicons/svelte';
  import {
    Maximize2 as Maximize2Data,
    Minimize2 as Minimize2Data,
    Pause as PauseData,
    Play as PlayData
  } from 'lucide';
  import { currentTrack, isPlaying, progress, duration as durationStore, currentView, previousView, settings, equalizerBands, listenStats, queue, likedTracks, trackHistory, notify, playlists, globalVolume, lyricsStatus } from '$lib/stores';
  import { buildTrackUrn } from '$lib/utils/trackUrn';
  import { getAudioUrl, getTrackInfo, getLyrics } from '$lib/api';
  import { waveActive, waveRefill, waveTrackDone, stopWave } from '$lib/wave';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { get } from 'svelte/store';
  import ArtistTag from './ArtistTag.svelte';
  import PlaylistMenu from './PlaylistMenu.svelte';
  import { dragValue } from '$lib/actions/dragValue';
  import { isTrackLiked, toggleTrackLike } from '$lib/likes';
  import { beginLastFmTrack, tickLastFmTrack } from '$lib/lastfm';
  import { coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';

  $: isLiked = isTrackLiked($likedTracks, $currentTrack);
  let currentTime = 0;
  let duration = 0;
  let currentTrackListenTime = 0;
  let currentTrackCounted = false;
  $: currentDisplayCover = coverUrlForTrack($currentTrack, $downloadedCoverCache);

  /**
   * Поделиться. Ссылка есть не только у SoundCloud: трек Яндекса приезжает с готовым
   * `permalinkUrl` вида `music.yandex.ru/album/…/track/…` (см. `mapYandexTrack` в lib/yandex.ts),
   * и прежняя проверка «источник обязан быть soundcloud» отказывала при наличии ссылки в самом
   * объекте трека. Теперь решает не название сервиса, а факт: есть чем поделиться или нет.
   * Настоящие «нечем» — только локальные файлы: у файла на диске адреса в сети не бывает.
   */
  async function handleShare() {
    if (!$currentTrack) return;

    const isLocal = Boolean($currentTrack.isLocal) || $currentTrack.source === 'Локальный';
    if (isLocal) {
       notify('Это локальный файл, поэтому у него нет ссылки для отправки.', 'info');
       return;
    }

    let url = $currentTrack.permalinkUrl;

    // Догрузка постоянной ссылки — только у SoundCloud: у Яндекса адрес выводится из id
    // трека и альбома, и отдельного запроса за ним не существует.
    if (!url && $currentTrack.source === 'soundcloud' && $currentTrack.id) {
       const info = await getTrackInfo($currentTrack.id);
       if (info && info.permalink_url) {
           url = info.permalink_url;
           // save it back to current track
           $currentTrack.permalinkUrl = url;
       }
    }

    // Ссылки нет вовсе — отдаём поиск по тому сервису, откуда трек: искать трек Яндекса
    // на SoundCloud бессмысленно, там его чаще всего нет.
    if (!url) {
       const q = encodeURIComponent(`${$currentTrack.artist} ${$currentTrack.title}`);
       url =
         $currentTrack.source === 'yandex'
           ? `https://music.yandex.ru/search?text=${q}`
           : `https://soundcloud.com/search?q=${q}`;
    }

    const text = `${url}\ni use Lomify btw`;
    try {
       await navigator.clipboard.writeText(text);
       notify('Ссылка скопирована.', 'success');
    } catch (e) {
       console.error(e);
       notify('Не удалось скопировать ссылку. Попробуй ещё раз.', 'error');
    }
  }
  let repeatMode = 0; // 0: off, 1: all, 2: one
  let statInterval: any;

  // `listen()` resolves asynchronously. The previous code assigned each unlisten fn to
  // its own `let` inside an async onMount, so a component destroyed before those
  // promises settled left every listener attached forever (onDestroy saw `undefined`)
  // — one permanent leak per event, per mount. Registering through `trackListener`
  // tears down a late-resolving subscription immediately instead.
  let unlisteners: UnlistenFn[] = [];
  let destroyed = false;
  async function trackListener(pending: Promise<UnlistenFn>) {
    try {
      const unlisten = await pending;
      if (destroyed) unlisten();
      else unlisteners.push(unlisten);
    } catch (e) {
      console.error('listen() failed', e);
    }
  }

  /**
   * Номер текущей загрузки. Раньше здесь лежала строка `source-title-artist`
   * (`currentTargetId`), и на ней держались две несовместимые обязанности: гонки между
   * загрузками и «этот трек уже играет, ничего не делаем». Вторая ломала первую.
   *
   * Отсюда и брался баг «из лайков ничего не запускается». Сценарий: клик по треку в
   * «Любимом» → ссылку получить не удалось (403 от Яндекса, обрыв, пустой токен) → плеер
   * показал уведомление и ушёл в `playNext()`, но `currentTargetId` остался равен этому
   * треку. Повторный клик по той же строке давал ту же строку идентификатора, условие
   * `trackId !== currentTargetId` не выполнялось — и клик не делал НИЧЕГО. Ни звука, ни
   * уведомления, ни спиннера. С главной всё игралось, потому что там лента и очередь
   * подсовывали следующий трек с другим идентификатором.
   *
   * Тот же тупик получался у любого «включить заново»: пауза в конце трека, возврат к уже
   * выбранному треку из другого раздела, повторный клик после ошибки сети.
   *
   * Поэтому теперь: КАЖДЫЙ `currentTrack.set(...)` — это запрос на воспроизведение, и он
   * всегда обслуживается. Реактивный блок ниже зависит ровно от одной величины —
   * `$currentTrack`, — а `writable.set` для объекта уведомляет подписчиков всегда, даже
   * если положили тот же объект. Значит блок срабатывает столько раз, сколько было
   * кликов, и лишних прогонов не будет. Гонки при этом никуда не делись — их и разводит
   * счётчик: у каждой загрузки свой номер, и она молча выходит, как только номер сменился.
   */
  let loadGeneration = 0;
  let loadingGeneration: number | null = null;
  let isShuffle = false;

  /**
   * Вход и выход из полноэкранного режима из плеера. Раньше это был инлайн-обработчик на
   * обложке, а название трека рядом носило `hover:underline cursor-pointer` вообще без
   * обработчика — подчёркивалось при наведении и не делало ничего. Одна функция на оба
   * элемента: подчёркивание снова означает, что клик куда-то ведёт.
   */
  function toggleFullscreenView() {
    if ($currentView !== 'fullscreen') {
      $previousView = $currentView;
      $currentView = 'fullscreen';
    } else {
      $currentView = $previousView;
    }
  }

  function toggleLike() {
    if (!$currentTrack) return;
    // Через `$lib/likes`, а не правкой стора: отметка должна уехать в аккаунт Яндекса, а
    // снятая — не вернуться при следующей сверке.
    const liked = toggleTrackLike($currentTrack);
    notify(liked ? 'Трек добавлен в любимые.' : 'Трек убран из любимых.', liked ? 'success' : 'info');
  }

  // Работа с плейлистами уехала в `PlaylistMenu`: там она одна на все места, где есть кнопка
  // «в плейлист», и там же исправлено обновление стора без правки массива на месте.

  let isDownloaded = false;
  let isDownloading = false;
  let isRemovingDownload = false;

  async function checkIsDownloaded() {
    if (!$currentTrack) return;
    try {
      const urn = buildUrn($currentTrack);
      isDownloaded = await invoke('track_is_cached', { urn });
    } catch (e) {
      isDownloaded = false;
    }
  }

  $: if ($currentTrack) {
     checkIsDownloaded();
  }

  async function handleDownload() {
    if (!$currentTrack || isDownloaded || isDownloading) return;
    isDownloading = true;
    notify('Скачиваю трек…', 'info');
    try {
       const url = await getAudioUrl($currentTrack);
       if (!url) throw new Error("No URL");
       const urn = buildUrn($currentTrack);
       const request = {
         urn,
         coverUrl: $currentTrack.coverUrl || null,
         url,
         urls: [url],
         hq: false,
         durationMs: $currentTrack.duration ? $currentTrack.duration : null
       };
       await invoke('track_ensure_cached', { request });
       isDownloaded = true;
       window.dispatchEvent(new CustomEvent('trackCacheChanged', { detail: { urn, cached: true } }));
       notify('Готово — трек сохранён на компьютере.', 'success');
    } catch (e) {
       console.error(e);
       notify('Не удалось скачать трек. Проверь подключение: возможно, источник удалил запись.', 'error');
    } finally {
       isDownloading = false;
    }
  }

  async function handleRemoveDownload() {
    if (!$currentTrack || !isDownloaded || isRemovingDownload) return;
    const track = $currentTrack;
    const urn = buildUrn(track);
    isRemovingDownload = true;
    try {
      const removed = await invoke<boolean>('track_remove_cached', { urn });
      const stillCached = await invoke<boolean>('track_is_cached', { urn });
      if (!removed && stillCached) throw new Error('cache file is still in use');
      isDownloaded = false;
      window.dispatchEvent(new CustomEvent('trackCacheChanged', { detail: { urn, cached: false } }));
      notify(`Трек «${track.title}» удалён с компьютера.`, 'info');
    } catch (e) {
      console.error('Could not remove cached track', e);
      notify('Не удалось удалить файл. Возможно, трек сейчас используется.', 'error');
    } finally {
      isRemovingDownload = false;
    }
  }

  /**
   * Чем закончился трек — это не одно и то же «дальше».
   *
   * `finished` — доиграл сам, `skip` — переключили руками (кнопка, медиаклавиша, трей),
   * `dropped` — не сыграл вообще (не дали ссылку на поток, оборвалась сеть). Различие нужно
   * «Моей волне»: `skip` станция понимает как «не нравится» и следующую порцию собирает с
   * учётом этого, а `dropped` не отмечается вовсе — человек этот трек даже не услышал, и
   * записывать его в нелюбимое было бы неправдой (разбор в lib/wave.ts).
   */
  type TrackOutcome = 'finished' | 'skip' | 'dropped';

  /**
   * Урн трека — ключ, под которым его знают кэш и выравнивание громкости. Раньше эта строка
   * собиралась прямо в `startLoading`; предзагрузка обязана собирать её точно так же, иначе
   * подготовленная ссылка не совпадёт сама с собой и работа уйдёт в мусор.
   */
  const buildUrn = buildTrackUrn;

  /**
   * За сколько секунд до конца готовить следующий трек. Раньше вся подготовка начиналась
   * после `audio:ended`: сначала запрос подписи (у Яндекса это `/get-file-info`, у SoundCloud
   * — разрешение transcoding), потом первый байт потока. Между треками получалась пауза на
   * пол-секунды и больше — на плохой сети секунды. Трёх секунд хватает, чтобы ссылка и первые
   * байты приехали заранее, и мало, чтобы успеть подготовить не тот трек: за три секунды до
   * конца очередь уже почти всегда та, с которой мы и продолжим.
   */
  const PRELOAD_LEAD_SECS = 3;
  type PreparedNext = { queueRef: any[]; index: number; urn: string; url: string | null };
  let preparedNext: PreparedNext | null = null;
  let preparingNext = false;

  /**
   * Сколько секунд два трека звучат вместе на автоматическом переходе. Ноль — встык, как было.
   *
   * Считается из настроек, а не хранится: без подготовки следующего трека микшировать нечего
   * (переход начинается с уже готовых данных, иначе уходящий трек кончится раньше, чем
   * входящий заговорит), поэтому выключенная подготовка означает и выключенное микширование.
   */
  $: crossfadeSecs = $settings.preloadNext === false
    ? 0
    : Math.max(0, ($settings.crossfadeMs ?? 0) / 1000);

  /**
   * За сколько секунд до конца начинать подготовку. Раньше это была константа, но с
   * микшированием она перестала быть верной: переход начинается за `crossfadeSecs` до конца, и
   * если подготовка стартует позже — а при переходе длиннее трёх секунд именно так и выходит, —
   * то к моменту перехода готового трека ещё нет, и переход просто не случится. Отсрочка
   * загрузки (`loadEstimateMs`) прибавляется сверху по той же причине: переход теперь просят
   * заранее, и ссылка должна быть на руках ещё раньше. Две секунды сверху — запас на сам запрос
   * подписи.
   */
  $: preloadLeadSecs = Math.max(PRELOAD_LEAD_SECS, crossfadeSecs + loadEstimateMs / 1000 + 2);

  /**
   * Сколько миллисекунд занимает включение трека — оценка по прошлым включениям.
   *
   * Из неё берётся запас, на который переход просят заранее. Между «пора микшировать» и первым
   * звуком входящего трека проходит запрос подписи, сеть, склейка HLS и — на первом включении —
   * полный проход по файлу для выравнивания громкости. Если начинать переход по готовности,
   * уходящий трек к этому времени обычно уже кончился, и «микширование» гасит тишину: ровно от
   * этого автопереход и был «плохо заметен». Поэтому загрузку заводят раньше, а лишнее время
   * досиживает Rust, держа входящий трек на паузе (см. `remainingMs` ниже).
   *
   * Оценка не средняя, а спадающий максимум: переоценка стоит только того, что название
   * следующего трека появится в плеере чуть раньше — лишнее время всё равно уходит в ожидание, —
   * а недооценка съедает само перекрытие. То есть ошибаться безопасно лишь в одну сторону.
   */
  const LOAD_ESTIMATE_START_MS = 2500;
  const LOAD_ESTIMATE_MIN_MS = 800;
  const LOAD_ESTIMATE_MAX_MS = 9000;
  let loadEstimateMs = LOAD_ESTIMATE_START_MS;
  function noteLoadDuration(ms: number) {
    const measured = Math.max(0, ms);
    loadEstimateMs = Math.round(
      Math.min(Math.max(measured, loadEstimateMs * 0.7, LOAD_ESTIMATE_MIN_MS), LOAD_ESTIMATE_MAX_MS)
    );
  }

  /**
   * Переход для играющего трека уже запущен. Без этого флага обработчик тика запускал бы его
   * заново каждые 100 мс всё время, пока до конца остаётся меньше `crossfadeSecs`.
   */
  let crossfadeArmed = false;
  /** Сколько миллисекунд микширования забирает следующая загрузка (см. `startLoading`). */
  let pendingCrossfadeMs = 0;
  /**
   * До какого момента (`performance.now()`) `audio:ended` — это эхо уже начатого перехода.
   *
   * Уходящий трек при микшировании доигрывает до своего настоящего конца прямо во время
   * загрузки входящего, и его конец — то же самое событие, по которому мы уже переключились
   * сами. Без окна интерфейс включил бы посреди перехода ещё один, третий трек.
   *
   * Именно окно по времени, а не флаг «идёт переход»: флаг пришлось бы снимать во всех концах
   * загрузки, включая те, где она обрывается на ошибке, — и один пропущенный конец навсегда
   * оставил бы плеер глухим к `audio:ended`, то есть трек доигрывал бы в тишину. Окно
   * закрывается само.
   */
  let crossfadeEndedUntil = 0;
  /** Запас окна на саму загрузку. Ровно то же число, что `CROSSFADE_LOAD_SLACK_MS` в Rust. */
  const CROSSFADE_LOAD_SLACK_MS = 8000;
  /**
   * Момент (`performance.now()`), когда уходящий трек доиграет по-настоящему.
   *
   * Записывается при запуске перехода, читается в момент вызова загрузки: между этими двумя
   * точками проходит неизвестно сколько — запрос подписи, проверка кэша, иногда `waveRefill`. Из
   * разницы получается `remainingMs`, из которого Rust считает, сколько уходящему играть одному
   * до начала перехода. Ноль — перехода нет.
   */
  let crossfadeOutgoingEndsAt = 0;

  /**
   * Сколько уходящему треку осталось играть прямо сейчас — аргумент `remainingMs` загрузки.
   *
   * Считается по часам, а не по позиции плеера: позиция к этому моменту уже принадлежит
   * входящему треку. Пауза во время загрузки часы, конечно, обманывает — тогда остаток выйдет
   * больше настоящего, — но это безопасная сторона: Rust ведёт отсчёт тиками и всё равно начнёт
   * переход, как только уходящий кончится.
   */
  function outgoingRemainingMs(crossfadeMs: number) {
    if (crossfadeMs <= 0 || crossfadeOutgoingEndsAt === 0) return 0;
    return Math.max(0, Math.round(crossfadeOutgoingEndsAt - performance.now()));
  }

  /**
   * Подготовить следующий трек, пока текущий доигрывает. Вызывается из обработчика тика, то
   * есть 10 раз в секунду, — поэтому все проверки дешёвые и стоят до любого запроса.
   *
   * Самое важное здесь — `queueRef`. Очередь сравнивается по тождеству массива, а не по
   * содержимому: `queue.set` всегда кладёт НОВЫЙ массив, значит «тот же массив» надёжно
   * означает «очередь не трогали». Без этого либо готовили бы заново каждый тик, либо
   * подсунули бы трек, которого в очереди уже нет.
   */
  async function maybePreloadNext() {
    if (preparingNext || $settings.preloadNext === false) return;
    // Трек на повторе — следующего не будет. Текущий ещё грузится — не мешаем.
    if (repeatMode === 2 || loadingGeneration !== null) return;
    if (duration <= 0 || duration - currentTime > preloadLeadSecs) return;

    const q = get(queue);
    if (!q || q.length === 0) return;
    if (preparedNext && preparedNext.queueRef === q) return;

    const index = isShuffle && q.length > 1 ? Math.floor(Math.random() * q.length) : 0;
    const track = q[index];
    if (!track) return;

    // Файл с диска грузить заранее нечего, но выбранный индекс запомнить надо: при
    // перемешивании иначе выпал бы другой трек, чем тот, который мы «подготовили».
    if (track.isLocal || track.source === 'Локальный') {
      preparedNext = { queueRef: q, index, urn: '', url: null };
      return;
    }

    preparingNext = true;
    try {
      const urn = buildUrn(track);
      let cached = false;
      try {
        cached = await invoke<boolean>('track_is_cached', { urn });
      } catch (e) {}

      let url: string | null = null;
      if (!cached) {
        try {
          // `silent`: предупреждать про урезанный отрывок будем при включении, а не за три
          // секунды до него — иначе уведомление всплывает поверх ещё играющего трека.
          url = await getAudioUrl(track, { silent: true });
        } catch (e) {
          console.warn('[player] предзагрузка: ссылку получить не удалось', e);
        }
      }

      // Пока ходили за ссылкой, очередь могли переписать — тогда вся работа не про тот трек.
      if (get(queue) !== q) return;
      preparedNext = { queueRef: q, index, urn, url };

      if (!cached && url && $settings.autoCache) {
        invoke('track_ensure_cached', {
          request: { urn, coverUrl: track.coverUrl || null, url, urls: [url], hq: false, durationMs: track.duration ? track.duration : null }
        })
          .then(() => window.dispatchEvent(new CustomEvent('trackCacheChanged', { detail: { urn, cached: true } })))
          .catch(e => console.warn('[player] предзагрузка в кэш не удалась', e));
      }
    } finally {
      preparingNext = false;
    }
  }

  /**
   * Начать переход, пока текущий трек ещё играет. Вызывается из обработчика тика, то есть 10
   * раз в секунду, — все проверки дешёвые и стоят до любого действия.
   *
   * Переход — это обычное «включить следующий», просто раньше времени: `handleTrackEnded`
   * делает всё то же самое (очередь, история, отметка волне), а `pendingCrossfadeMs` говорит
   * загрузке не снимать прежний плеер, а передать ему эстафету с плавным затуханием.
   *
   * Подготовленный следующий трек здесь обязателен. Без него загрузка началась бы с запроса
   * подписи, уходящий трек успел бы кончиться, и вместо микширования вышла бы обычная пауза —
   * только ещё и с обрубленным на `crossfadeSecs` концом трека.
   */
  function maybeStartCrossfade() {
    if (crossfadeArmed || crossfadeSecs <= 0) return;
    // Трек на повторе никуда не переходит; загрузка в полёте — переход уже идёт или не время.
    if (repeatMode === 2 || loadingGeneration !== null) return;
    if (duration <= 0) return;

    // Переход не должен съедать заметную часть короткого трека: восемь секунд микширования на
    // двадцатисекундной склейке — это уже не переход, а половина трека вдвоём. Четверть
    // длительности — граница, и она же становится настоящей длиной перехода: обе половины
    // столько же гаснут и нарастают.
    const fadeSecs = Math.min(crossfadeSecs, duration * 0.25);
    if (fadeSecs <= 0) return;

    // А заводить загрузку надо ещё раньше: перекрытие обязано длиться ровно `fadeSecs`, значит
    // всё, что уйдёт на саму загрузку, должно уместиться ДО его начала. Половина трека — предел
    // на запас вместе с переходом: иначе короткая склейка начинала бы переход с первых секунд.
    const armSecs = Math.min(fadeSecs + loadEstimateMs / 1000, duration * 0.5);
    const remainingSecs = duration - currentTime;
    if (remainingSecs > armSecs) return;

    const q = get(queue);
    if (!q || q.length === 0) return;
    if (!preparedNext || preparedNext.queueRef !== q) return;

    crossfadeArmed = true;
    pendingCrossfadeMs = Math.round(fadeSecs * 1000);
    // Настоящий конец уходящего трека — от него загрузка отсчитает остаток (`remainingMs`).
    crossfadeOutgoingEndsAt = performance.now() + Math.max(0, remainingSecs) * 1000;
    crossfadeEndedUntil = crossfadeOutgoingEndsAt + CROSSFADE_LOAD_SLACK_MS;
    handleTrackEnded('finished');
  }

  async function handleTrackEnded(outcome: TrackOutcome = 'finished') {
    if (repeatMode === 2) {
      invoke('audio_seek', { position: 0 });
      invoke('audio_play').catch(() => {});
      return;
    }

    if ($waveActive) {
      waveTrackDone($currentTrack, currentTime, outcome);
      // Порция догружается заранее, но если очередь всё-таки опустела — ждём: без этого
      // волна кончалась бы на последнем треке порции и уходила в обычный автоплей.
      await waveRefill();
    }

    const currentQueue = get(queue);
    if (currentQueue && currentQueue.length > 0) {
      // Если следующий трек уже подготовлен, берём именно его. Иначе при перемешивании
      // жребий бросался бы дважды: предзагрузка тянула бы ссылку для одного трека, а играл
      // бы другой — и вся подготовка каждый раз уходила бы впустую.
      const prepared = preparedNext && preparedNext.queueRef === currentQueue ? preparedNext : null;
      let nextIndex = prepared
        ? prepared.index
        : isShuffle && currentQueue.length > 1
          ? Math.floor(Math.random() * currentQueue.length)
          : 0;
      const nextTrack = currentQueue[nextIndex];
      const newQueue = [...currentQueue.slice(0, nextIndex), ...currentQueue.slice(nextIndex + 1)];
      
      if (repeatMode === 1 && $currentTrack) {
        queue.set([...newQueue, $currentTrack]);
      } else {
        queue.set(newQueue);
      }
      
      if ($currentTrack) {
        const hist = get(trackHistory);
        trackHistory.set([...hist, $currentTrack]);
      }
      currentTrack.set(nextTrack);
      isPlaying.set(true);
    } else if ($currentTrack) {
      import('$lib/api').then(async api => {
        const trending = await api.getRelatedTracks($currentTrack, $likedTracks, $listenStats, $playlists);
        if (trending && trending.length > 0) {
          const nextTrack = trending[Math.floor(Math.random() * trending.length)];
          currentTrack.set(nextTrack);
        } else {
          $isPlaying = false;
        }
      });
    } else {
      $isPlaying = false;
    }
  }

  function playNext(outcome: TrackOutcome = 'skip') {
    handleTrackEnded(outcome);
  }

  function doPlayPrev() {
    // If we have history, maybe go back? For now, let's just seek to 0 if > 3s, else pop history
    if (currentTime > 3) {
      invoke('audio_seek', { position: 0 });
    } else {
      const hist = get(trackHistory);
      if (hist.length > 0) {
        const prevTrack = hist[hist.length - 1];
        trackHistory.set(hist.slice(0, -1));
        const currentQueue = get(queue);
        if ($currentTrack) {
          queue.set([$currentTrack, ...currentQueue]);
        }
        currentTrack.set(prevTrack);
        isPlaying.set(true);
      } else {
        invoke('audio_seek', { position: 0 });
      }
    }
  }

  function playPrev() {
    doPlayPrev();
  }

  onMount(() => {
    const handleTrackCacheChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ urn?: string; cached?: boolean }>).detail;
      if (!$currentTrack || !detail?.urn || detail.urn !== buildUrn($currentTrack)) return;
      isDownloaded = detail.cached === true;
    };
    window.addEventListener('trackCacheChanged', handleTrackCacheChanged);

    trackListener(listen('audio:tick', (event) => {
      // Muted mid-scrub: the dot must follow the cursor, not the backend position.
      if (isScrubbing) return;
      // Во время микширования уходящий трек ещё присылает свою позицию, а название в плеере
      // уже сменилось: чужая секунда под новым названием читается как сломанный плеер.
      // Ждём входящего — он начнёт с нуля, как и при обычном переключении.
      if (crossfadeArmed && loadingGeneration !== null) return;
      currentTime = event.payload as number;
      progress.set(currentTime);
      if ($currentTrack) tickLastFmTrack($currentTrack, currentTime, duration, $isPlaying);
      paintProgress();
      maybePreloadNext();
      maybeStartCrossfade();
    }));

    trackListener(listen('audio:ended', () => {
      // Уходящий трек дошёл до своего настоящего конца, но переход по нему уже начат — это
      // то же самое событие, а не повод включить ещё один трек (разбор у `crossfadeEndedUntil`).
      if (performance.now() < crossfadeEndedUntil) return;
      handleTrackEnded();
    }));

    trackListener(listen('media:play', () => isPlaying.set(true)));
    trackListener(listen('media:pause', () => isPlaying.set(false)));
    trackListener(listen('media:toggle', () => isPlaying.update(p => !p)));
    trackListener(listen('media:next', () => playNext()));
    trackListener(listen('media:prev', () => playPrev()));

    trackListener(listen('tray-action', (event) => {
      const id = event.payload;
      if (id === 'play_pause') isPlaying.update(p => !p);
      else if (id === 'next') playNext();
      else if (id === 'prev') playPrev();
    }));

    statInterval = setInterval(async () => {
      if ($isPlaying) {
        listenStats.update(s => ({ ...s, listenSeconds: s.listenSeconds + 1 }));

        if ($currentTrack) {
          currentTrackListenTime++;
          if (!currentTrackCounted && duration > 0) {
            let threshold = duration < 60 ? duration * 0.8 : 60;
            if (currentTrackListenTime >= threshold) {
              currentTrackCounted = true;
              listenStats.update(s => {
                const historyObj = s.history || {};
                const trackId = $currentTrack.title + '-' + $currentTrack.artist;
                const currentHistory = historyObj[trackId] || { count: 0, title: $currentTrack.title, artist: $currentTrack.artist, coverUrl: $currentTrack.coverUrl };
                return {
                  ...s,
                  tracksPlayed: (s.tracksPlayed || 0) + 1,
                  history: {
                    ...historyObj,
                    [trackId]: {
                      ...currentHistory,
                      count: currentHistory.count + 1,
                      title: $currentTrack.title,
                      artist: $currentTrack.artist,
                      coverUrl: $currentTrack.coverUrl,
                      id: $currentTrack.id,
                      source: $currentTrack.source,
                      artists: $currentTrack.artists,
                      duration: $currentTrack.duration,
                      lastPlayedAt: Date.now()
                    }
                  }
                };
              });
            }
          }
        }
      }
    }, 1000);
    return () => window.removeEventListener('trackCacheChanged', handleTrackCacheChanged);
  });

  onDestroy(() => {
    destroyed = true;
    for (const unlisten of unlisteners) unlisten();
    unlisteners = [];
    clearInterval(statInterval);
  });

  /**
   * Ссылка на поток отклонена раздачей? У Яндекса это 403, реже 410, и означает не «нет
   * доступа», а «подпись просрочена»: подписанная ссылка живёт минуты, а между её выдачей и
   * первым байтом успевает пройти получение обложки, проверка кэша и текста. Текст ошибки
   * приходит строкой из `Err(String)` бэкенда (`audio/engine.rs`, `load_url`).
   */
  function isRejectedByCdn(e: unknown): boolean {
    const text = typeof e === 'string' ? e : `${(e as any)?.message ?? ''}`;
    return /\b(403|410)\b/.test(text);
  }

  /**
   * Загрузка потока с одной пересборкой подписи.
   *
   * Раньше 403 от раздачи был приговором: уведомление «Не смог включить: HTTP 403 — ссылка
   * на поток отклонена раздачей» и переход к следующему треку. Причём следующий трек часто
   * получал тот же 403, потому что дело не в конкретном треке — просроченная ссылка
   * означает лишь, что подпись надо взять заново. `getAudioUrl` делает именно это: для
   * Яндекса заново подписывает `/get-file-info`, для SoundCloud заново разрешает
   * transcoding. Так что вторая попытка — не «а вдруг повезёт», а исправление известной
   * причины.
   *
   * Ровно одна повторная попытка: если и свежая подпись отклонена, дело не в сроке, и
   * долбить раздачу в цикле незачем. Гонку проверяем до и после запроса — за время
   * получения новой ссылки человек мог переключить трек.
   */
  async function streamWithFreshSignature(track: any, url: string, generation: number, urn: string, crossfadeMs: number) {
    // `cacheKey` — урн трека, а не ссылка. Под этим ключом бэкенд хранит вычисленную
    // громкость выравнивания (`audio/decode.rs`, `resolve_normalization_gain`). Пока здесь
    // стоял `null`, ключа не было, и анализ первых 30 секунд шёл заново при каждом
    // включении одного и того же трека. Ссылка на ключ не годится: у неё каждый раз новая
    // подпись, то есть кэш никогда не совпал бы сам с собой.
    const load = (target: string) =>
      invoke('audio_load_url', {
        url: target,
        sessionId: null,
        cachePath: null,
        cacheKey: urn,
        startPaused: false,
        crossfadeMs,
        // Считается на каждую попытку заново: пока ходили за свежей подписью, у уходящего
        // трека осталось меньше, и старое число отправило бы переход ждать несуществующее время.
        remainingMs: outgoingRemainingMs(crossfadeMs),
      });

    try {
      return await load(url);
    } catch (e) {
      if (!isRejectedByCdn(e) || generation !== loadGeneration) throw e;

      let fresh: string | null = null;
      try {
        // `silent`: про 30-секундный отрывок уже сказали при запуске — это тот же трек,
        // просто с новой подписью.
        fresh = await getAudioUrl(track, { silent: true });
      } catch (refreshError) {
        console.warn('[player] пересобрать ссылку не удалось', refreshError);
      }
      // Та же ссылка — значит источник отдал её из своего кэша, повтор ничего не изменит.
      if (!fresh || fresh === url || generation !== loadGeneration) throw e;

      console.warn('[player] ссылка отклонена раздачей, иду со свежей подписью', e);
      return await load(fresh);
    }
  }

  /**
   * Включить трек — вся загрузка целиком, от проверки кэша до `audio_play`.
   *
   * Тело живёт в функции, а не прямо в `$:`, намеренно: чтения внутри тела функции Svelte
   * не записывает в зависимости реакции. Пока код стоял в блоке, в его зависимости попадали
   * `loadGeneration`, `loadingGeneration`, `duration` и `$settings` — то есть блок числил
   * своими причинами сработать собственные же записи и чужие настройки. Держалось это лишь
   * на защёлке `token.ran` внутри Svelte; изменения настроек во время игры хватило бы, чтобы
   * трек молча перезапустился с нуля. Теперь причина ровно одна — смена `$currentTrack`.
   */
  async function startLoading(track: any) {
    if (!track) return;

    // Забираем микширование, приготовленное `maybeStartCrossfade`, и сразу обнуляем: оно
    // годится ровно на одну загрузку. Любое другое включение (клик, «дальше», медиаклавиша)
    // приходит с нулём — и остаётся мгновенным, как от кнопки и ждут.
    const crossfadeMs = pendingCrossfadeMs;
    pendingCrossfadeMs = 0;
    crossfadeArmed = crossfadeMs > 0;
    if (crossfadeMs === 0) {
      crossfadeEndedUntil = 0;
      crossfadeOutgoingEndsAt = 0;
    }
    // Отсюда мерим, сколько заняло включение: из этого числа складывается запас, на который в
    // следующий раз попросят переход заранее (см. `loadEstimateMs`).
    const loadStartedAt = performance.now();

    const generation = ++loadGeneration;
    loadingGeneration = generation;
    currentTrackListenTime = 0;
    currentTrackCounted = false;
    duration = 0;
    currentTime = 0;
    progress.set(0);
    durationStore.set(0);
    paintProgress();
    // Force the next $isPlaying reaction to re-send play/pause: the backend player was
    // just torn down, so the deduped state no longer reflects it.
    lastPlayStateSent = null;

    // Прежний трек снимаем ДО загрузки и обязательно дожидаемся ответа.
    //
    // Раньше здесь стоял `invoke('audio_stop')` без `await` — и это была та самая причина,
    // по которой «трек не включается, только иногда что-то мелькнёт». Два независимых
    // сообщения (`stop` и `load`) шли к одному плееру, порядок их выполнения ничем не был
    // связан, и `stop`, опоздавший на пару сотен миллисекунд, снимал уже собранный новый
    // плеер: звук успевал начаться и обрывался, а ошибки не было ни одной — интерфейс
    // считал, что играет. `await` выстраивает порядок, а поколение загрузки на стороне Rust
    // (`claim_load` в audio/engine.rs) закрывает остаток гонки.
    //
    // При микшировании снимать нельзя: прежний трек обязан доиграть под входящий. От `stop`
    // нужна только вторая его половина — отмена загрузки, которая могла остаться в полёте от
    // предыдущего нажатия. Ровно это и делает `audio_cancel_load`.
    try {
      await invoke(crossfadeMs > 0 ? 'audio_cancel_load' : 'audio_stop');
    } catch (e) {
      console.warn('[player] audio_stop не ответил', e);
    }
    if (generation !== loadGeneration) return;

    const currentTrackObj = track;
    const urn = buildUrn(currentTrackObj);

    // Забираем подготовку и сразу обнуляем: она годится ровно на одно включение. Сверка по
    // урну обязательна — человек мог нажать не на тот трек, что стоял следующим в очереди.
    const prepared = preparedNext && preparedNext.urn === urn ? preparedNext : null;
    preparedNext = null;

    let isLocalFile = false;
    let localPath = "";
    if (currentTrackObj.isLocal || currentTrackObj.source === 'Локальный') {
      isLocalFile = true;
      localPath = currentTrackObj.audioUrl;
    }

    let isCached = false;
    if (!isLocalFile) {
      try {
        isCached = await invoke<boolean>('track_is_cached', { urn });
      } catch(e) {}
    }

    let url: string | null = null;
    let urlError: unknown = null;
    if (isCached || isLocalFile) {
      url = currentTrackObj.audioUrl || "dummy://url";
    } else if (prepared?.url) {
      // Ссылка уже получена за три секунды до конца прошлого трека — идём сразу в поток.
      // Просрочиться она не страшно: `streamWithFreshSignature` подпишет заново на 403/410.
      url = prepared.url;
    } else {
      try {
        url = await getAudioUrl(currentTrackObj);
      } catch (e) {
        // Причину запоминаем: ниже она решает, сбой это или трека действительно нет.
        urlError = e;
        console.error("getAudioUrl failed", e);
      }
    }

    if (generation !== loadGeneration) return; // гонка: успел прийти более свежий запрос

    if (!url && !isLocalFile && !isCached) {
      console.warn("No URL found for track", currentTrackObj, urlError);
      if (loadingGeneration === generation) loadingGeneration = null;

      // Раньше здесь стоял приговор: трек получал `isBanned = true`, и не только в
      // объекте — флаг уходил в базу через `saveTrack` и в стор лайков, который пишется
      // в localStorage. То есть ЛЮБАЯ осечка при получении ссылки (403 из-за заголовков,
      // просроченная подпись, обрыв сети, невставленный токен) навсегда превращала живой
      // трек в мёртвую строку: в «Любимом» такая строка получала `cursor-not-allowed` и
      // обработчик `if (!track.isBanned)`, то есть перестала реагировать на клик вообще —
      // и оставалась такой после перезапуска приложения. Именно так «с главной всё
      // играет, а из лайков ничего не запускается»: лента подгружается заново каждый
      // запуск и флаг на ней не оседает, а лайки лежат на диске.
      //
      // Плеер не может знать, что трек заблокирован в регионе — он знает только, что
      // ссылку получить не удалось. Поэтому никаких пометок: говорим причину и идём
      // дальше. Настоящую недоступность отдаёт сам источник (`available === false` в
      // yandex.ts, `policy === 'BLOCK'` в api.ts) — этому мы верим, своим догадкам нет.
      const reason = urlError instanceof Error ? urlError.message.trim() : '';
      notify(reason || 'Источник не передал ссылку на этот трек. Включаю следующий.', 'error');
      setTimeout(() => playNext('dropped'), 1500);
      return;
    }

    const safeUrl = url || "dummy://url";

    // Текст запрашиваем в фоне — плеер его не показывает, но результат нужен кнопке
    // «Показать текст» в полноэкранном режиме: она обещает текст только когда он есть.
    // Раньше ответ просто выбрасывался (`.catch(() => {})`), хотя запрос всё равно шёл.
    lyricsStatus.set('loading');
    getLyrics(currentTrackObj.title, currentTrackObj.artist, currentTrackObj)
      .then(text => {
        // Пока ходили за текстом, человек мог переключить трек — тогда этот ответ уже не про
        // то, что играет, и записывать его нельзя.
        if (generation !== loadGeneration) return;
        lyricsStatus.set(text ? 'found' : 'none');
      })
      .catch(() => {
        // Сеть отвалилась — это не «текста нет», это «мы не знаем».
        if (generation === loadGeneration) lyricsStatus.set('unknown');
      });

    let loadPromise;
    if (!isLocalFile) {
      try {
         const request = {
           urn: urn,
           coverUrl: currentTrackObj.coverUrl || null,
           url: safeUrl,
           urls: [safeUrl],
           hq: false,
           durationMs: currentTrackObj.duration ? currentTrackObj.duration : null
         };

         if (isCached) {
            const cached = await invoke<any>('track_ensure_cached', { request });
            // Ещё одна сверка: подготовка кэша — это диск и иногда сеть, за это время
            // человек мог переключить трек, и включать этот уже нельзя.
            if (generation !== loadGeneration) return;
            loadPromise = invoke('audio_load_file', { path: cached.path, cacheKey: urn, startPaused: false, crossfadeMs, remainingMs: outgoingRemainingMs(crossfadeMs) });
         } else {
            // Stream immediately for instant playback
            loadPromise = streamWithFreshSignature(currentTrackObj, safeUrl, generation, urn, crossfadeMs)
              .catch(e => {
                console.error("Playback failed:", e);
                // `invoke` отклоняется строкой из `Err(String)` — в ней уже лежит причина
                // (например «HTTP 403 — ссылка на поток отклонена раздачей»). Прятать её за
                // общим «не смог включить» значит терять единственную подсказку.
                const reason = (typeof e === 'string' ? e : (e as any)?.message ?? '').trim();
                notify(reason ? `Не удалось включить трек: ${reason}` : 'Не удалось включить трек. Перехожу к следующему.', 'error');
                setTimeout(() => playNext('dropped'), 1500);
                throw e;
              });

            // Cache in the background if enabled
            if ($settings.autoCache) {
              invoke('track_ensure_cached', { request })
                .then(() => window.dispatchEvent(new CustomEvent('trackCacheChanged', { detail: { urn, cached: true } })))
                .catch(e => console.error("Background cache failed", e));
            }
         }
      } catch(e) {
         console.error("Playback prep failed", e);
         return;
      }
    } else {
       loadPromise = invoke('audio_load_file', { path: localPath, cacheKey: localPath, startPaused: false, crossfadeMs, remainingMs: outgoingRemainingMs(crossfadeMs) });
    }

    loadPromise.then((res: any) => {
      if (loadingGeneration === generation) loadingGeneration = null;
      // Эстафета передана (или загрузка кончилась ничем): уходящий трек с этого момента гаснет
      // сам по тику, и держать окно с флагом больше нельзя. Особенно окно: следующий трек может
      // оказаться короче запаса на загрузку, и тогда его собственный конец попал бы внутрь
      // чужого окна — трек доиграл бы, а дальше не поехало бы вообще ничего.
      if (generation === loadGeneration) {
        crossfadeArmed = false;
        crossfadeEndedUntil = 0;
      }
      // Бэкенд говорит прямо: эту загрузку обогнала более свежая, плеер не собран.
      // Раньше на её месте приходил успех с пустой длительностью, и дальше шло
      // `isPlaying = true` и `audio_play` в пустоту — тишина без единой ошибки.
      if (res?.superseded) return;

      // Загрузка удалась — её длительность и есть та мерка, из которой берётся запас следующего
      // перехода. Обогнанные (`superseded`) сюда не попадают: их оборвали, и мерить в них нечего.
      noteLoadDuration(performance.now() - loadStartedAt);

      duration = res.duration || res.durationSecs || res.duration_secs || (currentTrackObj.duration ? currentTrackObj.duration / 1000 : 0);
      durationStore.set(duration);
      paintProgress();
      $isPlaying = true;
      beginLastFmTrack(currentTrackObj, duration);
      invoke('audio_play').catch(() => {});

      invoke('audio_set_metadata', {
        title: currentTrackObj.title,
        artist: currentTrackObj.artist,
        coverUrl: currentTrackObj.coverUrl,
        durationSecs: duration
      }).catch(() => {});
    }).catch(e => {
      if (loadingGeneration === generation) loadingGeneration = null;
      if (generation === loadGeneration) {
        crossfadeArmed = false;
        crossfadeEndedUntil = 0;
      }
      console.error("Load error", e);
      setTimeout(() => {
        playNext('dropped');
      }, 1500);
    });
  }

  // Реакция на запрос воспроизведения. Единственная зависимость блока — `$currentTrack`,
  // поэтому «сработал блок» и означает «кто-то попросил включить трек». См. `loadGeneration`.
  $: startLoading($currentTrack);

  // React to play/pause state.
  // The reaction re-runs whenever *any* of its dependencies changes ($isPlaying,
  // loadingGeneration), so a single load fired four IPC calls that the backend already
  // agreed with. The dedupe lives inside a function on purpose: reads in a function
  // body are not tracked as `$:` dependencies, so the guard can't retrigger itself.
  let lastPlayStateSent: boolean | null = null;
  function applyPlayState(playing: boolean) {
    if (playing === lastPlayStateSent) return;
    lastPlayStateSent = playing;
    invoke(playing ? 'audio_play' : 'audio_pause').catch(e => console.error(e));
    invoke('audio_set_playback_state', { playing }).catch(e => console.error(e));
  }
  $: {
    if ($isPlaying && loadingGeneration === null) applyPlayState(true);
    else if (!$isPlaying) applyPlayState(false);
  }

  // Apply volume. Keyed on `$currentTrack` as well as the volume itself, so every track
  // change used to re-send an identical gain; and a volume drag emits one IPC call per
  // pointer sample, most of them the same rounded value.
  let lastVolumeSent = -1;
  function applyVolume(value: number) {
    if (value === lastVolumeSent) return;
    lastVolumeSent = value;
    invoke('audio_set_volume', { volume: value }).catch(e => console.error(e));
  }
  $: if ($currentTrack) applyVolume(Math.pow($globalVolume, 3));

  // Apply EQ
  $: if ($equalizerBands) {
    invoke('audio_set_eq', { enabled: true, gains: $equalizerBands }).catch(e => console.error(e));
  }

  /**
   * Где играет трек — подписью для чужих глаз, а не кодом источника.
   *
   * Уходит в Discord второй строкой статуса: «слушаю» без «где» одинаково выглядит и для
   * трека из Яндекса, и для файла с диска, а разница как раз и интересна тому, кто читает
   * статус. Неизвестный источник даёт `null` — тогда строка остаётся прежней, без хвоста:
   * назвать сервис наугад значит соврать в чужом профиле.
   */
  function sourceLabel(track: any): string | null {
    if (!track) return null;
    if (track.isLocal || track.source === 'Локальный') return 'Локальный файл';
    switch (track.source) {
      case 'yandex': return 'Яндекс Музыка';
      case 'soundcloud': return 'SoundCloud';
      default: return null;
    }
  }

  // Discord RPC updates
  function updateDiscordRpc() {
    if ($settings.enableDiscordRpc === false) {
      invoke('discord_clear_activity').catch(() => {});
      return;
    }
    invoke('discord_set_activity', {
      track: {
        title: $currentTrack?.title || "Неизвестный трек",
        artist: $currentTrack?.artist || "Неизвестный исполнитель",
        artwork_url: $currentTrack?.coverUrl || "lomify_logo",
        track_url: null,
        duration_secs: duration ? Math.floor(duration) : null,
        elapsed_secs: currentTime ? Math.floor(currentTime) : null,
        is_playing: $isPlaying,
        mode: "track",
        show_button: false,
        source: sourceLabel($currentTrack)
      }
    }).catch(e => console.warn("Discord RPC error:", e));
  }

  $: triggerDiscordRpc($currentTrack, $isPlaying, duration);
  function triggerDiscordRpc(track: any, playing: boolean, dur: number) {
    if (track !== undefined) {
      updateDiscordRpc();
    }
  }

  function formatTime(s: number) {
    if (!s || isNaN(s)) return "0:00";
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
  }

  // The `audio:tick` event lands 10x/s. Binding the bar width, the dot offset and the
  // elapsed label to `currentTime` in the template made Svelte re-run the whole
  // component's update path ten times a second for two style strings. These two
  // elements are written directly instead, and the label — which can only change once
  // per second — is gated on the integer second, so a normal playing minute costs 60
  // reactive updates instead of 600. Because `currentTime` is now referenced in
  // neither the template nor any `$:` block, Svelte stops wrapping its assignment in
  // `$invalidate` altogether and the tick handler no longer schedules any work.
  let progressFillEl: HTMLElement | undefined;
  let progressDotEl: HTMLElement | undefined;
  let elapsedLabel = "0:00";
  let lastLabelSec = -1;

  function paintProgress() {
    const pct = duration > 0
      ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
      : 0;
    paintProgressPct(pct);
    const sec = Math.floor(currentTime);
    if (sec !== lastLabelSec) {
      lastLabelSec = sec;
      elapsedLabel = formatTime(currentTime);
    }
  }

  function paintProgressPct(pct: number) {
    if (progressFillEl) progressFillEl.style.width = `${pct}%`;
    if (progressDotEl) progressDotEl.style.left = `${pct}%`;
  }

  // --- Scrubbing -------------------------------------------------------------
  // While the pointer is held down we only repaint and update the label; the actual
  // `audio_seek` goes out once on release, so a scrub across the whole track costs one
  // IPC call instead of a hundred. `isScrubbing` also mutes the `audio:tick` handler —
  // otherwise the backend's position would keep yanking the dot back under the cursor.
  let isScrubbing = false;

  function seekTo(newTime: number) {
    invoke('audio_seek', { position: newTime }).catch(e => console.error(e));
    currentTime = newTime;
    progress.set(currentTime);
    paintProgress();
    updateDiscordRpc();
  }

  function timeForRatio(ratio: number) {
    return Math.max(0, Math.min(duration - 0.1, ratio * duration));
  }

  function onScrubStart() {
    if (!duration) return;
    isScrubbing = true;
  }

  function onScrubMove(ratio: number) {
    if (!duration) return;
    paintProgressPct(ratio * 100);
    const preview = timeForRatio(ratio);
    const sec = Math.floor(preview);
    if (sec !== lastLabelSec) {
      lastLabelSec = sec;
      elapsedLabel = formatTime(preview);
    }
  }

  function onScrubCommit(ratio: number) {
    isScrubbing = false;
    if (!duration) return;
    seekTo(timeForRatio(ratio));
  }

  function setVolumeFromRatio(ratio: number) {
    $globalVolume = ratio;
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.deltaY < 0) {
      $globalVolume = Math.min(1, $globalVolume + 0.05);
    } else if (e.deltaY > 0) {
      $globalVolume = Math.max(0, $globalVolume - 0.05);
    }
  }
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="px-4 pb-4 bg-transparent pointer-events-none">
  <div
    class="pointer-events-auto h-[90px] flex items-center px-6 justify-between transition-colors {$currentView === 'fullscreen' ? 'bg-transparent border-t border-white/5' : ($settings.uiStyle === 'style1' ? 'bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl rounded-2xl' : 'bg-black/40 backdrop-blur-xl border border-white/10 shadow-2xl rounded-2xl')}"
    on:wheel={handleWheel}
  >
  
  <!-- Track Info -->
  <div class="flex items-center gap-4 w-[30%] min-w-[180px]">
      {#if $currentTrack}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="relative group cursor-pointer overflow-hidden rounded-xl shadow-md w-14 h-14 bg-neutral-800 flex-shrink-0"
          on:click={toggleFullscreenView}
        >
          {#if currentDisplayCover}
            <img src={currentDisplayCover} alt="Cover" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-[400ms]" />
          {:else}
            <div class="w-full h-full bg-gradient-to-br from-neutral-700 to-neutral-900"></div>
          {/if}
          <div class="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <MorphIcon
              icon={$currentView === 'fullscreen' ? Minimize2Data : Maximize2Data}
              size={16}
              class="text-white"
              spring="snappy"
              reducedMotion="user"
            />
          </div>
        </div>
        <div class="flex flex-col min-w-0">
          <button
            type="button"
            class="player-track-title"
            title={$currentTrack.title}
            on:click={toggleFullscreenView}
          >{$currentTrack.title}</button>
          <div class="text-xs text-neutral-400 mt-0.5 min-w-0">
            <ArtistTag artist={$currentTrack.artist} artists={$currentTrack.artists} />
          </div>
        </div>
        <div class="flex items-center gap-2 ml-2 relative">
          <button aria-label="Like track" class="interactive-item text-neutral-400 hover:text-white" on:click={toggleLike}>
            <Heart size={18} fill={isLiked ? "var(--color-primary)" : "none"} color={isLiked ? "var(--color-primary)" : "currentColor"} />
          </button>
          <!-- Меню «в плейлист». Раскрывается вверх и от левого края: плеер стоит в самом низу
               окна, а строка с кнопками — у левого края, так что вниз и вправо меню уехало бы
               за пределы экрана. -->
          <PlaylistMenu
            track={$currentTrack}
            placement="top"
            align="left"
            buttonClass="interactive-item text-neutral-400 hover:text-white py-2"
          />
          <!-- Признак волны. Стоит здесь, а не в ряду с перемешиванием и повтором: тот ряд
               отцентрован относительно окна, и кнопка, появляющаяся и исчезающая в нём,
               сдвигала бы главную кнопку плеера. Показывается только когда волна играет —
               выключать то, что не включено, незачем. -->
          {#if $waveActive}
            <button
              aria-label="Выключить Мою тусню"
              class="interactive-item text-primary"
              title="Играет «Моя тусня» — нажми, чтобы дальше играла только очередь"
              on:click={() => stopWave()}
            >
              <Radio size={18} />
            </button>
          {/if}
        </div>
      {:else}
        <div class="w-14 h-14 bg-white/5 rounded-xl flex-shrink-0"></div>
        <div class="flex flex-col gap-2 w-full max-w-[120px]">
          <div class="w-full h-3 bg-white/5 rounded-full"></div>
          <div class="w-2/3 h-2 bg-white/5 rounded-full"></div>
        </div>
      {/if}
    </div>

    <!-- Controls -->
    <div class="flex flex-col items-center justify-center w-[40%] max-w-[600px] px-4">
      <div class="flex items-center gap-6 mb-2">
        <button 
          aria-label="Shuffle" 
          class="transition {isShuffle ? 'text-primary' : 'text-neutral-400 hover:text-white'}"
          on:click={() => isShuffle = !isShuffle}
        >
          <Shuffle size={18} />
        </button>
        <button aria-label="Skip Back" class="text-neutral-200 hover:text-white interactive-item" on:click={playPrev}><SkipBack size={20} /></button>
        
        <!-- Play Button. Форма, физика и свечение — в `.play-btn` (app.css): раньше это
             была строка утилит с `hover:scale-105 active:scale-95`, из-за чего иконка
             дёргалась на каждом нажатии, а второй дизайн не мог переопределить главную
             кнопку плеера вообще. -->
        <button
          aria-label={$isPlaying ? 'Пауза' : 'Воспроизвести'}
          class="play-btn"
          on:click={() => $isPlaying = !$isPlaying}
          disabled={!$currentTrack}
        >
          <div class="play-btn-glow"></div>
          <!-- Один SVG остаётся на месте между состояниями. Раньше Play получал `ml-1`
               (ровно 4px вправо), поэтому треугольник и выглядел смещённым. -->
          <MorphIcon
            icon={$isPlaying ? PauseData : PlayData}
            size={16}
            strokeWidth={2.35}
            fill="currentColor"
            class="play-pause-morph"
            spring="snappy"
            reducedMotion="user"
          />
        </button>

        <!-- Обработчик через стрелку, а не `on:click={playNext}`: обработчику события Svelte
             передаёт сам `MouseEvent`, и он приехал бы первым аргументом — то есть вместо
             «пропустили» плеер сообщил бы волне какую-то мышь (см. `TrackOutcome`). -->
        <button aria-label="Skip Forward" class="text-neutral-200 hover:text-white interactive-item" on:click={() => playNext()}><SkipForward size={20} /></button>
        <button 
          aria-label="Repeat" 
          class="interactive-item transition {repeatMode > 0 ? 'text-primary' : 'text-neutral-400 hover:text-white'} relative"
          on:click={() => repeatMode = (repeatMode + 1) % 3}
        >
          <Repeat size={18} />
          {#if repeatMode === 2}
            <span class="absolute -top-1 -right-1 text-[8px] font-bold bg-primary text-black w-3 h-3 flex items-center justify-center rounded-full">1</span>
          {/if}
        </button>
      </div>
      
      <!-- Progress Bar (fill/dot are painted imperatively by paintProgress — see script) -->
      <div class="w-full flex items-center gap-3 text-[11px] tnum text-neutral-400">
        <span class="w-10 text-right">{elapsedLabel}</span>
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="group flex-1 h-5 flex items-center cursor-pointer relative py-1 touch-none select-none"
          use:dragValue={{ onStart: onScrubStart, onChange: onScrubMove, onCommit: onScrubCommit, disabled: !duration }}
        >
          <div class="w-full h-[4px] bg-white/10 rounded-full overflow-hidden relative">
            <div
              bind:this={progressFillEl}
              class="h-full bg-white rounded-full group-hover:bg-primary transition-colors pointer-events-none"
              style="width: 0%"
            ></div>
          </div>
          <!-- Hover Dot -->
          <div
            bind:this={progressDotEl}
            class="absolute h-3.5 w-3.5 bg-white rounded-full shadow-md pointer-events-none transition-opacity top-1/2 -translate-y-1/2 -ml-[7px] {isScrubbing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
            style="left: 0%"
          ></div>
        </div>
        <span class="w-10">{formatTime(duration)}</span>
      </div>
    </div>

    <!-- Right Controls -->
    <div class="w-[30%] flex justify-end items-center gap-4 text-neutral-400 pr-2 min-w-[180px]">
      {#if !isDownloaded}
        <button aria-label="Download" class="interactive-item hover:text-white transition-colors" on:click={handleDownload} title="Скачать" disabled={isDownloading}>
          {#if isDownloading}
            <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          {:else}
            <Download size={18} />
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="interactive-item player-cache-action cache-state-control"
          class:is-busy={isRemovingDownload}
          aria-label={`Удалить скачанный файл «${$currentTrack?.title ?? 'трека'}»`}
          title="Удалить скачанный файл"
          on:click={handleRemoveDownload}
          disabled={isRemovingDownload}
        >
          {#if isRemovingDownload}
            <Loader2 size={17} class="animate-spin" />
          {:else}
            <span class="cache-state-saved"><Check size={18} /></span>
            <span class="cache-state-remove"><Trash2 size={17} /></span>
          {/if}
        </button>
      {/if}

      <button aria-label="Share" class="interactive-item hover:text-white transition-colors" on:click={handleShare} title="Поделиться">
        <Share2 size={18} />
      </button>
      
      <div class="flex items-center gap-2 group w-24 py-2 group/vol">
        <Volume2 size={18} class="group-hover:text-white transition" />
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="w-full flex items-center cursor-pointer h-6 relative touch-none select-none"
          use:dragValue={{ onChange: setVolumeFromRatio }}
          on:wheel={handleWheel}
        >
            <div class="w-full h-[4px] bg-white/10 rounded-full relative pointer-events-none group-hover/vol:bg-white/20 transition-colors">
              <div 
                class="absolute left-0 top-0 h-full bg-white rounded-full group-hover:bg-primary transition-colors" 
                style="width: {$globalVolume * 100}%"
              ></div>
              <!-- Volume Hover Dot -->
              <div 
                class="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none -ml-1.5"
                style="left: {$globalVolume * 100}%"
              ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
