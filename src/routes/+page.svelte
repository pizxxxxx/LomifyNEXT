<script lang="ts">
  import { onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { Play, Loader2, ChevronLeft, ChevronRight, WifiOff } from 'lucide-svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Player from '$lib/components/Player.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import Search from '$lib/components/Search.svelte';
  import Lyrics from '$lib/components/Lyrics.svelte';
  import Fullscreen from '$lib/components/Fullscreen.svelte';
  import Equalizer from '$lib/components/Equalizer.svelte';
  import Library from '$lib/components/Library.svelte';
  import Profile from '$lib/components/Profile.svelte';
  import ArtistPage from '$lib/components/ArtistPage.svelte';
  import Notifications from '$lib/components/Notifications.svelte';
  import WaveHero from '$lib/components/WaveHero.svelte';
  import { currentView, previousView, currentTrack, isPlaying, queue, likedTracks, listenStats, searchHistory, playlists, navHistory, navFuture, isHistoryNavigation, currentArtist, searchQuery as searchQueryStore, settings, notify, pageAtmosphere } from '$lib/stores';
  import { getTrendingTracks } from '$lib/api';
  import { LASTFM_TASTE_UPDATED_EVENT } from '$lib/lastfm';
  import { getTracks } from '$lib/db';
  import { coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';

  import { gibberish } from '$lib/actions/gibberish';

  let greeting = 'Добрый вечер';
  let osUsername = 'User';
  let trendingTracks: any[] = [];
  let newReleases: any[] = [];
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

  $: displayView = $currentView === 'fullscreen' ? ($previousView || 'home') : $currentView;
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
    isLoadingHome = true;
    homeError = null;
    try {
      const tracks = await withTimeout(getTrendingTracks($likedTracks, $listenStats, $searchHistory, $playlists));
      // Свои плейлисты — сильный сигнал вкуса, а не содержимое главной. В API их треки уже
      // исключены из результата; эта проверка дополнительно не пропустит контейнер-плейлист.
      trendingTracks = tracks.filter((t) => !Array.isArray(t?.tracks));
      visibleHomeCount = HOME_INITIAL_TRACKS;
      // `getTrendingTracks` внутри гасит отказы через Promise.allSettled и на мёртвой
      // сети возвращает пустой массив, а не ошибку. Формально это успех, по факту —
      // тихий провал: без этой проверки пользователь получил бы пустую страницу без
      // единого объяснения, почему на ней ничего нет.
      if (trendingTracks.length === 0) {
        // Называем тот сервис, из которого лента и собиралась: совет про VPN к Музыке
        // неприменим, а у неё свой типичный отказ — просроченный токен.
        homeError = $settings.searchSource === 'yandex' && $settings.yandexToken
          ? 'Рекомендации не пришли. Возможно, токен Яндекс.Музыки устарел — переподключи аккаунт в настройках.'
          : 'Рекомендации не пришли. Возможно, SoundCloud недоступен без VPN.';
      }
    } catch (err) {
      console.error("Failed to load home feed", err);
      homeError = networkErrorText(err);
    } finally {
      isLoadingHome = false;
    }
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

  async function loadNewReleases() {
    try {
      newReleases = await withTimeout(import('$lib/api').then(m => m.getNewReleases($likedTracks)));
    } catch (e) {
      console.error("Failed to fetch new releases", e);
    }
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
    loadFeed();
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
      const key = `${s.searchSource}:${s.yandexToken ? 'auth' : 'anon'}`;
      if (feedSource === null || feedSource === key) { feedSource = key; return; }
      feedSource = key;
      loadFeed();
      loadNewReleases();
    });
    const refreshLastFmTaste = () => void loadFeed();
    window.addEventListener(LASTFM_TASTE_UPDATED_EVENT, refreshLastFmTaste);

    return () => {
      unsubscribeSettings();
      window.removeEventListener(LASTFM_TASTE_UPDATED_EVENT, refreshLastFmTaste);
    };
  });

  function playTrack(track: any) {
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
  function windowKey(s: { view: string; artist: string }) {
    return s.view === 'artist' ? `artist:${s.artist}` : s.view;
  }

  $: {
    const currentState = { view: $currentView, artist: $currentArtist, search: $searchQueryStore };
    if (currentState.view !== 'fullscreen') {
      if (windowKey(currentState) !== windowKey(lastState) && !$isHistoryNavigation) {
        navHistory.update(h => [...h, lastState]);
        navFuture.set([]);
      }
      lastState = { ...currentState };
      if ($isHistoryNavigation) $isHistoryNavigation = false;
    }
  }

  function goBack() {
    if ($navHistory.length > 0) {
      const history = $navHistory;
      const prev = history.pop();
      navHistory.set(history);
      
      navFuture.update(f => [...f, lastState]);
      
      $isHistoryNavigation = true;
      if (prev) {
        $currentArtist = prev.artist;
        $searchQueryStore = prev.search;
        $currentView = prev.view as any;
      }
    }
  }

  function goForward() {
    if ($navFuture.length > 0) {
      const future = $navFuture;
      const next = future.pop();
      navFuture.set(future);
      
      navHistory.update(h => [...h, lastState]);
      
      $isHistoryNavigation = true;
      if (next) {
        $currentArtist = next.artist;
        $searchQueryStore = next.search;
        $currentView = next.view as any;
      }
    }
  }
   let previousRoute = '';

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

  function syncAtmosShift() {
    atmosShift = mainEl ? Math.min(mainEl.scrollTop, ATMOS_HEIGHT) : 0;
  }

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

<!-- `tracks-left` only re-anchors the track grids themselves (see `.track-collection`
     in app.css) — headings, buttons and the rest of the chrome stay put. -->
<div class="h-screen w-screen flex flex-col bg-[var(--color-dark)] text-white font-sans overflow-hidden relative transition-colors duration-[1500ms]" class:tracks-left={$settings.leftAlignTracks} use:gibberish>
  
  <!-- Main Area -->
  <div class="flex-1 flex overflow-hidden relative">
    
    <!-- Background -->
    <div class="absolute inset-0 pointer-events-none bg-[var(--color-dark)] overflow-hidden transition-colors duration-[1500ms]">
      <!-- During the fullscreen intro this remains behind the translucent overlay, preserving
           the existing visual hand-off. Once the opaque overlay has settled, its own backdrop
           is the only visible one, so retaining this second full-window blur only wastes a GPU
           surface. It is mounted again before the outro begins. -->
      {#if currentDisplayCover && ($currentView !== 'fullscreen' || !fullscreenOverlaySettled)}
        <div class="app-track-backdrop absolute inset-0 opacity-[0.15] blur-[100px] transition-all duration-1000" style="background-image: url('{currentDisplayCover}'); background-size: cover; background-position: center; transform: scale(1.2);"></div>
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
    </div>

    <div class="flex w-full relative">
      {#if displayView !== 'fullscreen'}
        <Sidebar />
      {/if}

      <!-- Main Content -->
      <main
        bind:this={mainEl}
        on:scroll={syncAtmosShift}
        class="flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar {displayView === 'fullscreen' ? 'p-0' : 'px-8 pt-20 pb-32'} relative scroll-smooth"
      >
    
    {#if $currentView !== 'fullscreen'}
      <div class="fixed top-6 left-[300px] z-50 flex items-center gap-3">
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
      class:wave-hero-parked={$currentView !== 'home'}
    >
      <WaveHero
        {greeting}
        username={osUsername}
        sourceTracks={trendingTracks}
        onPage={$currentView === 'home'}
        motionEnabled={!$settings.perfMode}
      />
    </div>

    {#if displayView === 'artist'}
      <ArtistPage />
    {:else if displayView === 'home'}
      {#if isLoadingHome}
        <div class="w-full flex flex-col items-center gap-4 py-20 text-primary">
          <Loader2 class="animate-spin" size={40} />
          <div class="empty-hint !mt-0">Собираем рекомендации…</div>
        </div>
      {:else if homeError}
        <!-- Раньше на этом месте крутился вечный лоадер: любая сетевая осечка обрывала
             загрузку до того, как спиннер выключался. Теперь у неудачи есть свой экран
             с внятной причиной и кнопкой, которая не требует перезапуска приложения. -->
        <div class="w-full flex flex-col items-center justify-center gap-1.5 py-24 text-center">
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
        <div class="w-full max-w-[1480px] mx-auto flex flex-col gap-10 relative z-10 pt-2" style="isolation: isolate;">
          <div class="space-y-16">
            {#if newReleases.length > 0}
              {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
                <svelte:component this={ArchiveStation.default} title="Новые релизы" tracks={newReleases} />
              {/await}
            {/if}

            {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
              {#if visibleTrendingTracks.length > 0}
                <svelte:component this={ArchiveStation.default} title="Главная" tracks={visibleTrendingTracks} />
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
    <Notifications />

    <div class="absolute bottom-0 left-0 w-full {$currentView === 'fullscreen' ? 'z-[105]' : 'z-50'}">
      <Player />
    </div>
  </div>
</div>
