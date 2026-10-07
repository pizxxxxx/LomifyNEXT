<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { Play, Loader2, ChevronLeft, ChevronRight, WifiOff } from 'lucide-svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import LiquidGlassBackdrop from '$lib/components/LiquidGlassBackdrop.svelte';
  import LiquidGlassSidebar from '$lib/components/LiquidGlassSidebar.svelte';
  import LiquidGlassToolbar from '$lib/components/LiquidGlassToolbar.svelte';
  import LiquidGlassQueue from '$lib/components/LiquidGlassQueue.svelte';
  import Player from '$lib/components/Player.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import LiquidGlassSettingsDialog from '$lib/components/LiquidGlassSettingsDialog.svelte';
  import Search from '$lib/components/Search.svelte';
  import Lyrics from '$lib/components/Lyrics.svelte';
  import BackdropAdlibStage from '$lib/components/BackdropAdlibStage.svelte';
  import Fullscreen from '$lib/components/Fullscreen.svelte';
  import Equalizer from '$lib/components/Equalizer.svelte';
  import Library from '$lib/components/Library.svelte';
  import Profile from '$lib/components/Profile.svelte';
  import ArtistPage from '$lib/components/ArtistPage.svelte';
  import Notifications from '$lib/components/Notifications.svelte';
  import WaveHero from '$lib/components/WaveHero.svelte';
  import DailyMixes from '$lib/components/DailyMixes.svelte';
  import DailyMixPage from '$lib/components/DailyMixPage.svelte';
  import { activeDailyMix, type DailyMixSelection } from '$lib/dailyMixActions';
  import { transitionDailyMix, cancelDailyMixMotion } from '$lib/utils/dailyMixMotion';
  import { layoutPosition } from '$lib/actions/layoutPosition';
  import { dailyReleaseArtists, localMixDay } from '$lib/dailyMixesCore';
  import GlyphWake from '$lib/components/GlyphWake.svelte';
  import { currentView, previousView, currentTrack, isPlaying, queue, likedTracks, listenStats, searchHistory, playlists, navHistory, navFuture, isHistoryNavigation, currentArtist, searchQuery as searchQueryStore, settings, effectivePerformanceMode, notify, pageAtmosphere } from '$lib/stores';
  import { getTrendingTracks } from '$lib/api';
  import { stopWave } from '$lib/wave';
  import { LASTFM_TASTE_UPDATED_EVENT } from '$lib/lastfm';
  import { getTracks } from '$lib/db';
  import { coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';

  let greeting = 'Добрый вечер';
  let osUsername = 'User';
  let trendingTracks: any[] = [];
  let newReleases: any[] = [];
  let recommendationsDay = '';
  let releasesDay = '';
  let similarArtists: {name: string, coverUrl: string}[] = [];
  let isLoadingHome = true;
  let isLoadingMore = false;
  let homeError: string | null = null;
  let fullscreenOverlaySettled = false;

  // Сотни карточек с обложками не должны одновременно жить в DOM. Сам список рекомендаций
  // остаётся в памяти (его использует очередь и «Моя тусня»), а сетка раскрывается порциями.
  // 96 видимых позиций — уже шестнадцать рядов на широком экране; дальше полезнее обновить
  // рекомендации, чем держать декодированные текстуры далеко за пределами окна.
  const HOME_INITIAL_TRACKS = 36;
  const HOME_TRACK_BATCH = 24;
  const HOME_RENDER_LIMIT = 96;
  let visibleHomeCount = HOME_INITIAL_TRACKS;
  $: visibleTrendingTracks = trendingTracks.slice(0, Math.min(visibleHomeCount, HOME_RENDER_LIMIT));
  $: canLoadMoreTracks = visibleTrendingTracks.length < HOME_RENDER_LIMIT;

  $: glassSettings = $currentView === 'settings' && $settings.design === 'liquid-glass';
  let settingsReturnView: typeof $currentView = 'home';
  $: displayView = glassSettings ? settingsReturnView : $currentView === 'fullscreen' ? ($previousView || 'home') : $currentView;
  $: if ($settings.design !== 'liquid-glass' && $currentView === 'wave') currentView.set('home');
  $: waveView = $settings.design === 'liquid-glass' ? 'wave' : 'home';
  $: waveVisible = $currentView === waveView || (glassSettings && displayView === waveView);
  $: if ($currentView !== 'fullscreen') fullscreenOverlaySettled = false;
  $: currentDisplayCover = coverUrlForTrack($currentTrack, $downloadedCoverCache);

  /**
   * Сеть не обязана падать — она может просто замолчать: отвалившийся VPN, DNS в
   * никуда, прокси, который держит соединение открытым. Такой запрос не отклонится
   * никогда, и главная оставалась с вечным спиннером. Ставим будильник на всю загрузку.
   */
  const HOME_TIMEOUT_MS = 20000;

  function withTimeout<T>(promise: Promise<T>, ms = HOME_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  function networkErrorText(err: unknown) {
    return err instanceof Error && err.message === 'timeout'
      ? 'Сеть не отвечает. Похоже, интернет или VPN отвалился.'
      : 'Не получилось загрузить рекомендации. Проверь соединение и попробуй ещё раз.';
  }

  function trackSignature(track: any) {
    return `${track?.title || ''}\u0000${track?.artist || ''}`.toLocaleLowerCase('ru-RU');
  }

  function feedContext() {
    return `${$settings.searchSource}:${$settings.searchSource === 'yandex' ? $settings.yandexUser?.uid || '' : $settings.scUser?.id || ''}`;
  }

  async function loadMoreTracks() {
    // Сначала показываем уже загруженную порцию. Повторный сетевой запрос и перестройка всей
    // сетки ради карточек, которые и так лежат в памяти, только давали задержку на кнопке.
    const revealTo = Math.min(HOME_RENDER_LIMIT, trendingTracks.length, visibleHomeCount + HOME_TRACK_BATCH);
    if (revealTo > visibleHomeCount) {
      visibleHomeCount = revealTo;
      return;
    }

    isLoadingMore = true;
    try {
      const moreTracks = await withTimeout(getTrendingTracks($likedTracks, $listenStats, $searchHistory, $playlists));
      // Плейлисты участвуют в профиле вкуса внутри getTrendingTracks, но объект плейлиста
      // никогда не должен снова попасть в домашнюю сетку. Сигнатура убирает и дубли одного
      // трека, приехавшие по нескольким поисковым запросам.
      const existing = new Set(trendingTracks.map(trackSignature));
      const newTracks = moreTracks.filter((t) => !Array.isArray(t?.tracks) && !existing.has(trackSignature(t)));
      trendingTracks = [...trendingTracks, ...newTracks];
      visibleHomeCount = Math.min(HOME_RENDER_LIMIT, visibleHomeCount + HOME_TRACK_BATCH, trendingTracks.length);
    } catch (err) {
      console.error("Failed to load more tracks", err);
      // Лента уже на экране — рушить её ради неудачной догрузки незачем, достаточно
      // сказать вслух, что подгрузка не прошла.
      notify(networkErrorText(err), 'error');
    }
    isLoadingMore = false;
  }

  /**
   * Главная лента. Единственная точка, которая управляет `isLoadingHome`/`homeError`:
   * и первая загрузка, и «Обновить рекомендации», и «Повторить» приходят сюда, поэтому
   * спиннер гарантированно выключается — при любом исходе, включая брошенный запрос.
   */
  async function loadFeed() {
    const context = feedContext();
    isLoadingHome = true;
    homeError = null;
    try {
      const tracks = await withTimeout(getTrendingTracks($likedTracks, $listenStats, $searchHistory, $playlists));
      if (context !== feedContext()) return;
      // Свои плейлисты — сильный сигнал вкуса, а не содержимое главной. В API их треки уже
      // исключены из результата; эта проверка дополнительно не пропустит контейнер-плейлист.
      const received = tracks.filter((t) => !Array.isArray(t?.tracks));
      if (received.length) { trendingTracks = received; recommendationsDay = localMixDay(); }
      visibleHomeCount = HOME_INITIAL_TRACKS;
      // `getTrendingTracks` внутри гасит отказы через Promise.allSettled и на мёртвой
      // сети возвращает пустой массив, а не ошибку. Формально это успех, по факту —
      // тихий провал: без этой проверки пользователь получил бы пустую страницу без
      // единого объяснения, почему на ней ничего нет.
      if (received.length === 0) {
        // Называем тот сервис, из которого лента и собиралась: совет про VPN к Музыке
        // неприменим, а у неё свой типичный отказ — просроченный токен.
        homeError = $settings.searchSource === 'yandex'
          ? ($settings.yandexToken ? 'Яндекс Музыка не прислала рекомендации. Проверь соединение или переподключи аккаунт в настройках.' : 'Подключи Яндекс Музыку в настройках, чтобы получить рекомендации.')
          : 'Рекомендации не пришли. Возможно, SoundCloud недоступен без VPN.';
      }
    } catch (err) {
      console.error("Failed to load home feed", err);
      homeError = networkErrorText(err);
    } finally {
      isLoadingHome = false;
    }
  }

  /**
   * Одна автоматическая попытка повтора - ровно то, что человек и сделал бы сам, нажав
   * «Повторить» на экране ошибки. Первый запрос главной уходит в тот момент, когда сеть
   * ещё поднимается (свежий запуск системы, переподключение Wi-Fi, только что включённый
   * обход блокировки), и чаще всего второй запрос через полсекунды уже проходит. Показывать
   * ради этого экран отказа - заставлять нажимать кнопку вместо приложения.
   *
   * Попытка только одна и только для автоматических загрузок: ручные «Повторить» и
   * «Обновить рекомендации» остаются одним запросом на одно нажатие, иначе человек не
   * понимает, сколько всего сделало приложение. Счётчик сбрасывается после успеха, так что
   * право на бесплатную вторую попытку возвращается к следующему обрыву связи.
   */
  let homeAutoRetryUsed = false;
  const HOME_AUTO_RETRY_DELAY = 600;

  async function loadFeedAuto() {
    await loadFeed();
    if (!homeError) {
      homeAutoRetryUsed = false;
      return;
    }
    if (homeAutoRetryUsed) return;
    homeAutoRetryUsed = true;
    await new Promise((resolve) => setTimeout(resolve, HOME_AUTO_RETRY_DELAY));
    await loadFeed();
    if (!homeError) homeAutoRetryUsed = false;
  }

  // Полки ниже — необязательные. Каждая грузится отдельно и своим провалом не роняет ни
  // главную ленту, ни соседнюю полку: раньше всё это жило в одной цепочке await, и
  // первая же ошибка не доходила до `isLoadingHome = false`.
  async function loadSimilarArtists() {
    try {
      const localTracks = await getTracks();
      const artistMap = new Map<string, string>();
      for (const t of localTracks) {
        if (!artistMap.has(t.artist) && t.artistAvatarUrl) {
          artistMap.set(t.artist, t.artistAvatarUrl);
        } else if (!artistMap.has(t.artist) && t.coverUrl) {
          artistMap.set(t.artist, t.coverUrl);
        }
      }
      similarArtists = Array.from(artistMap.entries()).slice(0, 15).map(([name, coverUrl]) => ({ name, coverUrl }));
    } catch (e) {
      console.error("Failed to load similar artists", e);
    }
  }

  let releasesGeneration = 0;
  onMount(() => {
    const refresh = () => { void loadNewReleases(); };
    window.addEventListener('lomify:artist-follow', refresh);
    return () => window.removeEventListener('lomify:artist-follow', refresh);
  });
  async function loadNewReleases() {
    const generation = ++releasesGeneration;
    const context = feedContext();
    try {
      const source = $settings.searchSource === 'yandex' ? 'yandex' : 'soundcloud';
      const followed = $settings.followedArtists.filter(artist => artist.source === source).map(artist => artist.name).slice(-3);
      const artistNames = [...new Set([...followed, ...dailyReleaseArtists($likedTracks, $listenStats.history, source)])].slice(0, 6);
      const tracks = await withTimeout(import('$lib/api').then(m => m.getNewReleases($likedTracks, { artistNames, limit: 30 })));
      if (generation !== releasesGeneration) return;
      if (context !== feedContext()) return;
      if (tracks.length) { newReleases = tracks; releasesDay = localMixDay(); }
    } catch (e) {
      console.error("Failed to fetch new releases", e);
    }
  }

  async function refreshDailySources() {
    await Promise.allSettled([loadFeedAuto(), loadNewReleases()]);
  }

  async function loadDesktopInfo() {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      osUsername = await invoke('get_os_username');
      const cachedList: string[] = await invoke('track_list_cached');
      cachedTracksCount = cachedList.length;
    } catch (e) {
      console.warn("Could not load cached tracks count", e);
    }
  }


  let cachedTracksCount = 0;

  onMount(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) greeting = 'Доброе утро';
    else if (hour >= 12 && hour < 18) greeting = 'Добрый день';
    else if (hour >= 18 && hour < 23) greeting = 'Добрый вечер';
    else greeting = 'Доброй ночи';
    // Блик и наклон карточек переехали в `$lib/utils/tilt`, а он подключён один раз в
    // `+layout.svelte`. Здесь был свой трекер `mousemove`, и у него было два изъяна.
    // Первый — область действия: `onMount` домашней страницы, то есть на остальных
    // маршрутах (библиотека, поиск, страница артиста) блик по карточкам не двигался
    // вообще, хотя `.interactive-item` там ровно тот же. Второй — характер движения:
    // координаты подставлялись в CSS как есть, без физики, поэтому пятно жёстко
    // приклеивалось к курсору и мгновенно исчезало на уходе. Оба слушателя одновременно
    // писали бы `--mouse-x` одному и тому же элементу, так что этот снят целиком.

    // Четыре независимых загрузки вместо одной цепочки: лента, локальные авторы, новые
    // релизы и данные десктопной оболочки больше не ждут друг друга и не тянут друг
    // друга за собой при ошибке.
    loadFeedAuto();
    loadSimilarArtists();
    loadNewReleases();
    loadDesktopInfo();

    // Смена источника в настройках должна пересобрать главную. Страница монтируется один раз
    // за сессию — виды переключаются внутри неё, — поэтому без этой подписки лента осталась
    // бы собранной в прежнем сервисе до перезапуска приложения. Первый вызов подписки
    // приходит синхронно с текущим значением и только запоминает его: перезагружать нечего,
    // `loadFeed` выше уже идёт.
    let feedSource: string | null = null;
    const unsubscribeSettings = settings.subscribe((s) => {
      const key = `${s.searchSource}:${s.searchSource === 'yandex' ? s.yandexUser?.uid || '' : s.scUser?.id || ''}:${s.yandexToken ? 'auth' : 'anon'}`;
      if (feedSource === null || feedSource === key) { feedSource = key; return; }
      feedSource = key;
      trendingTracks = []; newReleases = []; recommendationsDay = ''; releasesDay = '';
      loadFeedAuto();
      loadNewReleases();
    });
    const refreshLastFmTaste = () => void loadFeedAuto();
    window.addEventListener(LASTFM_TASTE_UPDATED_EVENT, refreshLastFmTaste);

    let lastNavTime = 0;
    const triggerNav = (direction: 'back' | 'forward', source: string) => {
      const now = Date.now();
      if (now - lastNavTime < 250) return;
      lastNavTime = now;
      if (direction === 'back') {
        goBack();
      } else {
        goForward();
      }
    };

    const handleMouseNav = (e: MouseEvent | PointerEvent) => {
      const isBack = e.button === 3 || (e.buttons & 8) !== 0;
      const isForward = e.button === 4 || (e.buttons & 16) !== 0;

      if (isBack) {
        e.preventDefault();
        e.stopPropagation();
        triggerNav('back', e.type);
      } else if (isForward) {
        e.preventDefault();
        e.stopPropagation();
        triggerNav('forward', e.type);
      }
    };

    const handleKeyNav = (e: KeyboardEvent) => {
      if (e.key === 'BrowserBack' || (e.altKey && e.key === 'ArrowLeft')) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          if (e.altKey) return;
        }
        e.preventDefault();
        triggerNav('back', e.key);
      } else if (e.key === 'BrowserForward' || (e.altKey && e.key === 'ArrowRight')) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          if (e.altKey) return;
        }
        e.preventDefault();
        triggerNav('forward', e.key);
      }
    };

    const handlePopState = (e: PopStateEvent) => {
      const now = Date.now();
      if (now - lastNavTime < 250) return;
      lastNavTime = now;
      if (e.state && e.state.view) {
        $isHistoryNavigation = true;
        $currentArtist = e.state.artist || '';
        $searchQueryStore = e.state.search || '';
        $activeDailyMix = e.state.dailyMix || null;
        $currentView = e.state.view;
      } else {
        goBack();
      }
    };

    if (typeof window !== 'undefined' && window.history && !window.history.state) {
      try {
        window.history.replaceState({ view: $currentView, artist: $currentArtist, search: $searchQueryStore, dailyMix: $activeDailyMix }, '');
      } catch {}
    }

    window.addEventListener('pointerdown', handleMouseNav, { capture: true });
    window.addEventListener('pointerup', handleMouseNav, { capture: true });
    window.addEventListener('mousedown', handleMouseNav, { capture: true });
    window.addEventListener('mouseup', handleMouseNav, { capture: true });
    window.addEventListener('auxclick', handleMouseNav, { capture: true });
    window.addEventListener('keydown', handleKeyNav);
    window.addEventListener('popstate', handlePopState);

    return () => {
      unsubscribeSettings();
      window.removeEventListener(LASTFM_TASTE_UPDATED_EVENT, refreshLastFmTaste);
      window.removeEventListener('pointerdown', handleMouseNav, { capture: true });
      window.removeEventListener('pointerup', handleMouseNav, { capture: true });
      window.removeEventListener('mousedown', handleMouseNav, { capture: true });
      window.removeEventListener('mouseup', handleMouseNav, { capture: true });
      window.removeEventListener('auxclick', handleMouseNav, { capture: true });
      window.removeEventListener('keydown', handleKeyNav);
      window.removeEventListener('popstate', handlePopState);
    };
  });

  function playTrack(track: any) {
    stopWave();
    const idx = trendingTracks.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set(trendingTracks.slice(idx + 1));
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  // Navigation Logic
  let lastState: import('$lib/stores').NavState = { view: 'home', artist: '', search: '' };

  // Back/Forward step through *windows*, not through every action. Two things used to
  // leak in as history entries and made the buttons feel broken:
  //   1. `fullscreen` — it is an overlay over the current window, not a window of its
  //      own, so Back would drop you straight into fullscreen mode.
  //   2. every keystroke in search — typing mutates the current window, it doesn't
  //      open a new one, so Back walked back through the query letter by letter.
  function windowKey(s: import('$lib/stores').NavState) {
    return s.view === 'artist' ? `artist:${s.artist}` : s.view === 'daily-mix' ? `daily-mix:${s.dailyMix?.id || ''}` : s.view;
  }

  $: {
    const currentState = { view: $currentView, artist: $currentArtist, search: $searchQueryStore, dailyMix: $activeDailyMix };
    if (currentState.view === 'settings' && lastState.view !== 'settings') settingsReturnView = lastState.view as typeof $currentView;
    if (currentState.view !== 'fullscreen') {
      if (windowKey(currentState) !== windowKey(lastState) && !$isHistoryNavigation) {
        navHistory.update(h => [...h, lastState]);
        navFuture.set([]);
        if (typeof window !== 'undefined' && window.history) {
          try {
            window.history.pushState({ ...currentState }, '');
          } catch {}
        }
      }
      lastState = { ...currentState };
      if ($isHistoryNavigation) $isHistoryNavigation = false;
    }
  }

  function goBack() {
    if ($currentView === 'fullscreen') {
      $currentView = $previousView && $previousView !== 'fullscreen' ? $previousView : 'home';
      return;
    }
    if ($navHistory.length > 0) {
      const history = $navHistory;
      const prev = history.pop();
      navHistory.set(history);
      
      navFuture.update(f => [...f, lastState]);
      
      $isHistoryNavigation = true;
      if (prev) {
        $currentArtist = prev.artist;
        $searchQueryStore = prev.search;
        $activeDailyMix = prev.dailyMix || null;
        $currentView = prev.view as any;
      }
    }
  }

  function goForward() {
    if ($currentView === 'fullscreen') return;
    if ($navFuture.length > 0) {
      const future = $navFuture;
      const next = future.pop();
      navFuture.set(future);
      
      navHistory.update(h => [...h, lastState]);
      
      $isHistoryNavigation = true;
      if (next) {
        $currentArtist = next.artist;
        $searchQueryStore = next.search;
        $activeDailyMix = next.dailyMix || null;
        $currentView = next.view as any;
      }
    }
  }
  function openDailyMix(selection: DailyMixSelection) {
    $activeDailyMix = selection;
    $currentView = 'daily-mix';
  }
  let motionView = 'home';
  let motionKey = 'home';
  $: routeMotionKey = displayView === 'daily-mix' ? `daily-mix:${$activeDailyMix?.id || ''}` : displayView;
  let motionMixId = '';
  let homeScroll = 0;
  $: if (mainEl && routeMotionKey !== motionKey) {
    const old = motionView;
    const id = old === 'daily-mix' && displayView === 'daily-mix' && motionMixId !== $activeDailyMix?.id ? '' : displayView === 'daily-mix' ? $activeDailyMix?.id || '' : motionMixId;
    if (old === 'home') homeScroll = mainEl.scrollTop;
    motionView = displayView;
    motionKey = routeMotionKey;
    motionMixId = displayView === 'daily-mix' ? $activeDailyMix?.id || '' : '';
    if (old === 'daily-mix' || displayView === 'daily-mix') {
      const destination = displayView;
      void transitionDailyMix(id, () => {
        if (!mainEl || destination !== displayView) return;
        mainEl.scrollTo({ top: destination === 'home' ? homeScroll : 0, behavior: 'instant' });
        syncAtmosShift();
        if (destination === 'daily-mix') document.getElementById('daily-mix-heading')?.focus({ preventScroll: true });
      }, $effectivePerformanceMode);
    } else { cancelDailyMixMotion(); }
  }

  /**
   * Прокрутка атмосферной подложки страницы.
   *
   * Подложка (`.page-atmos`) нарисована в слое фона, то есть ВНЕ `<main>` — иначе её
   * обрезал бы стык с боковой панелью (подробнее — у `pageAtmosphere` в stores). Но она
   * продолжает шапку страницы, а шапка лежит внутри `<main>` и прокручивается. Без этого
   * сдвига подложка отвязалась бы от неё на первом же движении колеса: шапка ушла бы вверх,
   * а её же размытое продолжение осталось висеть на месте.
   *
   * Сдвиг ограничен высотой слоя: дальше подложка целиком выше кромки окна, и увозить её в
   * минус на тысячи пикселей незачем.
   */
  const ATMOS_HEIGHT = 620;
  let mainEl: HTMLElement | null = null;
  let atmosShift = 0;
  let mainScrollTop = 0;
  let atmosRaf = 0;

  function syncAtmosShift() {
    if (atmosRaf) return;
    atmosRaf = requestAnimationFrame(() => {
      atmosRaf = 0;
      mainScrollTop = mainEl?.scrollTop ?? 0;
      atmosShift = Math.min(mainScrollTop, ATMOS_HEIGHT);
    });
  }

  onDestroy(() => {
    if (atmosRaf) cancelAnimationFrame(atmosRaf);
    cancelDailyMixMotion();
  });

  // `<main>` один на все разделы, и переключение раздела его прокрутку не сбрасывает —
  // значит новая подложка обязана встать с учётом того, где страница уже стоит.
  $: if ($pageAtmosphere) syncAtmosShift();

  function fullscreenTransition(node: HTMLElement, params: { duration?: number } = {}) {
    const duration = params.duration ?? 420;
    return {
      duration,
      easing: cubicOut,
      css: (t: number) => {
        // Two things used to expose the page behind this overlay as a shrinking
        // rectangle ("квадрат приближающийся"):
        //   • scale < 1 on a `fixed inset-0` element makes it smaller than the viewport;
        //   • `filter: blur()` softens the element's own edges into transparency.
        // So: never scale below 1 (grow 1.03 → 1 instead, always edge-to-edge) and keep
        // the blur on the content inside, not on the full-bleed overlay.
        const scale = 1 + 0.03 * (1 - t);
        return `opacity: ${t}; transform: scale(${scale}); transform-origin: 50% 50%;`;
      }
    };
  }
</script>

<div class="app-shell h-screen w-screen flex flex-col bg-[var(--color-dark)] text-white font-sans overflow-hidden relative transition-colors duration-[1500ms]">
  
  <!-- Main Area -->
  <div class="flex-1 flex overflow-hidden relative">
    
    <!-- Background -->
    {#if $settings.design !== 'liquid-glass'}
    <div class="absolute inset-0 pointer-events-none bg-[var(--color-dark)] overflow-hidden transition-colors duration-[1500ms]">
      <!-- During the fullscreen intro this remains behind the translucent overlay, preserving
           the existing visual hand-off. Once the opaque overlay has settled, its own backdrop
           is the only visible one, so retaining this second full-window blur only wastes a GPU
           surface. It is mounted again before the outro begins. -->
      {#if currentDisplayCover && ($currentView !== 'fullscreen' || !fullscreenOverlaySettled)}
        <!-- The accent already follows the cover. Gradients retain the same quiet colour
             atmosphere without keeping a scaled, full-window 100px blur in GPU memory. -->
        <div class="app-track-backdrop absolute inset-0" aria-hidden="true"></div>
      {/if}
      <div class="absolute inset-0 bg-gradient-to-b from-[var(--color-dark-gradient)]/50 to-[var(--color-dark)] transition-colors duration-[1500ms]"></div>

      <!-- Атмосферная подложка активной страницы: баннер артиста или шапка профиля,
           размытые во всю ширину окна. Слой стоит ПОСЛЕ градиента фона (то есть поверх
           него) и внутри общего фонового слоя — а тот тянется под боковую панель, поэтому
           у подложки нет левой кромки, на которой раньше был виден шов. Панель матовая и
           размывает её сквозь себя сама. -->
      {#if $pageAtmosphere}
        <div
          class="page-atmos"
          class:is-derived={$pageAtmosphere.derived}
          style="transform: translate3d(0, {-atmosShift}px, 0)"
        >
          <img src={$pageAtmosphere.url} alt="" class="page-atmos-media" />
          <div class="page-atmos-veil"></div>
          <div class="page-atmos-fade"></div>
        </div>
      {/if}

      <!-- One capped canvas, dormant while the pointer is still. It sits above the colour
           atmosphere but below every interactive surface, so the glyph wake feels embedded
           in the page rather than painted over cards. -->
      <GlyphWake
        enabled={$settings.glyphWake !== false && !$effectivePerformanceMode && $currentView !== 'fullscreen'}
        mode={$settings.glyphWakeMode || 'classic'}
        scrollOffset={mainScrollTop}
      />
    </div>
    {/if}

    <!-- Backdrop adlibs layer for normal lyrics view: covers full viewport width behind content -->
    {#if $currentView === 'lyrics'}
      <BackdropAdlibStage isFullscreen={false} />
    {/if}

    <div class="app-columns flex w-full relative">
      {#if $settings.design === 'liquid-glass'}<LiquidGlassBackdrop />{/if}
      {#if displayView !== 'fullscreen'}
        {#if $settings.design === 'liquid-glass'}<LiquidGlassSidebar />{:else}<Sidebar />{/if}
      {/if}

      <!-- Main Content -->
      <main
        bind:this={mainEl}
        on:scroll={syncAtmosShift}
        class="app-main-content flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar {displayView === 'fullscreen' ? 'p-0' : 'px-8 pt-20 pb-32'} relative scroll-smooth"
      >
    
    {#if $currentView !== 'fullscreen'}
      {#if $settings.design === 'liquid-glass'}
        <LiquidGlassToolbar back={goBack} forward={goForward} />
      {:else}
      <div class="app-history-nav fixed top-6 z-50 flex items-center gap-3">
        <button 
          class="w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          on:click={goBack}
          disabled={$navHistory.length === 0}
          title="Назад"
        >
          <ChevronLeft size={24} />
        </button>
        <button 
          class="w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          on:click={goForward}
          disabled={$navFuture.length === 0}
          title="Вперед"
        >
          <ChevronRight size={24} />
        </button>
      </div>
      {/if}
    {/if}

    <!-- «Моя волна» стоит ВЫШЕ развилки загрузки, а не внутри ветки с лентой, и это
         намеренно: волна не зависит от рекомендаций SoundCloud. Была бы она внутри —
         на медленной сети её заслонял бы спиннер, а при отказе ленты (у пользователя
         Яндекс Музыки это обычное дело: SoundCloud без VPN недоступен) единственный
         вход в станцию исчезал бы вместе с рекомендациями.

         И выше самой развилки разделов — тоже намеренно. Внутри ветки `home` волна
         пересоздавалась при каждом переходе в другой раздел и обратно: Svelte уничтожает
         компонент, ушедший из ветки `{#if}`, вместе со всем его состоянием. Полосы
         начинались с нуля, и пока не придёт следующий кадр `audio:fft` (до 350 мс), волна
         дышала «холостым» дыханием, а фоновые пятна прыгали в начало своего 17-секундного
         дрейфа — это и был сбой анимации при переключении разделов. Теперь компонент живёт,
         пока открыто приложение.

         `wave-hero-parked` (см. app.css), а не `hidden`: `display: none` отменяет
         CSS-анимации, то есть пятна прыгали бы ровно так же, как при пересоздании. Класс
         убирает блок из потока, ничего не отменяя, а считать кадры волна перестаёт сама —
         по `onPage` она замирает так же, как при уходе окна на задний план.

         Условие по `$currentView`, а не по `displayView`: под полноэкранным режимом
         `displayView` остаётся прошлым разделом, и волна продолжала бы считать кадры под
         оверлеем, который её полностью закрывает. -->
    <div
      class="wave-hero-host w-full max-w-[1480px] mx-auto relative z-10 mb-10"
      class:wave-hero-parked={!waveVisible}
      class:lg-wave-host={$settings.design === 'liquid-glass'}
    >
      <WaveHero
        greeting={$settings.design === 'liquid-glass' ? 'Моя волна' : greeting}
        username={$settings.design === 'liquid-glass' ? '' : osUsername}
        onPage={$currentView === waveView}
        motionEnabled={!$effectivePerformanceMode}
      />
    </div>

    {#if displayView === 'artist'}
      <ArtistPage />
    {:else if displayView === 'home'}
      {#if $settings.design === 'liquid-glass'}
        <header class="lg-home-heading">
          <p>{greeting}{osUsername && osUsername !== 'User' ? `, ${osUsername}` : ''}</p>
          <h1>Главная</h1>
          <span>Подборки, новые релизы и музыка для тебя</span>
        </header>
      {/if}
      <div class="daily-mixes-position w-full max-w-[1480px] mx-auto relative z-10 mb-12 pt-2" use:layoutPosition={$settings.design === 'liquid-glass' && !$effectivePerformanceMode}>
        <DailyMixes recommendations={trendingTracks} {recommendationsDay} releases={newReleases} {releasesDay} onrefresh={refreshDailySources} onopen={openDailyMix} />
      </div>
      {#if isLoadingHome}
        <div class="home-feed-loading w-full flex flex-col items-center gap-4 py-20 text-primary">
          <Loader2 class="animate-spin" size={40} />
          <div class="empty-hint !mt-0">Собираем рекомендации…</div>
        </div>
      {:else if homeError}
        <!-- Раньше на этом месте крутился вечный лоадер: любая сетевая осечка обрывала
             загрузку до того, как спиннер выключался. Теперь у неудачи есть свой экран
             с внятной причиной и кнопкой, которая не требует перезапуска приложения. -->
        <div class="home-feed-error w-full flex flex-col items-center justify-center gap-1.5 text-center">
          <div class="w-12 h-12 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-center text-white/40 mb-4">
            <WifiOff size={20} />
          </div>
          <div class="display-title">Лента не загрузилась</div>
          <div class="empty-hint !mt-0 max-w-[380px]">{homeError}</div>
          <button
            class="glass-button px-6 py-2.5 rounded-xl text-[13.5px] font-medium mt-6"
            on:click={loadFeed}
          >
            Повторить
          </button>
        </div>
      {:else}
        <div class="home-shelves-position w-full max-w-[1480px] mx-auto flex flex-col gap-10 relative z-10 pt-2" style="isolation: isolate;" use:layoutPosition={$settings.design === 'liquid-glass' && !$effectivePerformanceMode}>
          <div class="space-y-16">
            {#if newReleases.length > 0}
              {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
                <svelte:component this={ArchiveStation.default} title="Новые релизы" tracks={newReleases} />
              {/await}
            {/if}

            {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
              {#if visibleTrendingTracks.length > 0}
                <svelte:component this={ArchiveStation.default} title={$settings.design === 'liquid-glass' ? 'Для тебя' : 'Главная'} tracks={visibleTrendingTracks} />
              {/if}

              <div class="w-full flex justify-center gap-4 mt-6 mb-4">
                {#if canLoadMoreTracks}
                  <button
                    class="glass-button px-8 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-primary hover:text-black transition-all shadow-md"
                    on:click={loadMoreTracks}
                    disabled={isLoadingMore}
                  >
                    {#if isLoadingMore}
                      <Loader2 class="animate-spin" size={18} /> Загрузка...
                    {:else}
                      Загрузить ещё треки
                    {/if}
                  </button>
                {/if}

                <button
                  class="glass-button px-8 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-orange-500 hover:text-white transition-all shadow-md"
                  on:click={loadFeed}
                  disabled={isLoadingHome}
                >
                  Обновить рекомендации
                </button>
              </div>
            {/await}

            {#if similarArtists.length > 0}
              {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
                <!-- `artistLinks={false}`: в этой полке в поле автора лежит подпись
                     «Похожий автор», а не аккаунт — ссылка вела бы в пустоту. -->
                <svelte:component
                  this={ArchiveStation.default}
                  title="Похожие авторы (Лайки)"
                  tracks={similarArtists.map(a => ({title: a.name, artist: 'Похожий автор', coverUrl: a.coverUrl}))}
                  artistLinks={false}
                />
              {/await}
            {/if}
          </div>
        </div>
      {/if}
    {:else if displayView === 'wave'}
      <p class="lg-wave-note">Запусти волну или настрой подбор музыки. Любимые и скрытые треки помогают ей лучше понимать твой вкус.</p>
    {:else if displayView === 'daily-mix' && $activeDailyMix}
      {#key $activeDailyMix.id}<DailyMixPage selection={$activeDailyMix} onback={goBack} />{/key}
    {:else if displayView === 'search'}
      <Search />
    {:else if displayView === 'lyrics'}
      <!-- Fullscreen owns its own lyrics layout. Keeping this copy mounted underneath the
           opaque overlay doubled every character node and animation loop on exactly the
           route where long lyrics are most expensive. Other previous views remain mounted
           so the fullscreen transition and navigation state are unchanged. -->
      {#if $currentView !== 'fullscreen'}
        <Lyrics />
      {/if}
    {:else if displayView === 'library'}
      <Library />
    {:else if displayView === 'settings'}
      <Settings />
    {:else if displayView === 'equalizer'}
      <Equalizer />
    {:else if displayView === 'profile'}
      <Profile />
    {:else}
      <div class="w-full h-full flex items-center justify-center text-neutral-500">
        <p>Вкладка {displayView} не реализована...</p>
      </div>
    {/if}
    </main>
    {#if $settings.design === 'liquid-glass' && $currentView !== 'fullscreen'}<LiquidGlassQueue />{/if}
    </div>

    <!-- Fullscreen Overlay at Root level inside the Main Area container, positioned fixed inset-0 -->
    {#if $currentView === 'fullscreen'}
      <div
        transition:fullscreenTransition
        on:introend={() => fullscreenOverlaySettled = true}
        class="fixed inset-0 z-[100] w-screen h-screen overflow-hidden pointer-events-auto bg-[#0a0a0c]"
      >
        <Fullscreen />
      </div>
    {/if}

    <!-- Moved Notifications and Player here so they are inside the overflow-hidden container! -->
    {#if glassSettings}<LiquidGlassSettingsDialog onclose={() => currentView.set(settingsReturnView)} />{/if}
    <Notifications />

    <div class="app-player-dock absolute bottom-0 left-0 w-full {$currentView === 'fullscreen' ? 'z-[105]' : 'z-50'}">
      <Player />
    </div>
  </div>
</div>
