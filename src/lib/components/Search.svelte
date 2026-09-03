<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    Search as SearchIcon,
    Play,
    Loader2,
    Music,
    Heart,
    ListMusic,
    Radio,
    X,
    Clock3,
    UserRound,
    HardDrive,
    RefreshCw,
    ChevronDown
  } from 'lucide-svelte';
  import { Plus as PlusIcon, Check as CheckIcon } from 'lucide';
  import { MorphIcon } from 'morphicons/svelte';
  import { performSearchDetailed, getSoundCloudPlaylists } from '$lib/api';
  import { currentTrack, isPlaying, settings, searchQuery, searchResults, searchPlaylists, queue, searchHistory, likedTracks, playlists, notify } from '$lib/stores';
  import { getTracks } from '$lib/db';
  import ArtistTag from './ArtistTag.svelte';
  import PlaylistMenu from './PlaylistMenu.svelte';
  import TrackStatus from './TrackStatus.svelte';
  import PlaylistTrailer from './PlaylistTrailer.svelte';
  import { withCount } from '$lib/utils/plural';
  import { isTrackLiked, toggleTrackLike } from '$lib/likes';
  import { splitArtists } from '$lib/utils/artists';
  import { goToArtist } from '$lib/utils/navigation';
  import MusicServiceIcon from './MusicServiceIcon.svelte';
  import { coverUrlAtSize } from '$lib/offlineCovers';

  type SearchView = 'all' | 'tracks' | 'artists' | 'playlists' | 'local';
  type SearchSourceKind = 'soundcloud' | 'yandex' | 'local';

  interface ArtistMatch {
    name: string;
    avatarUrl: string;
    source: SearchSourceKind;
    matches: number;
  }

  let isLoading = false;
  let timeout: any;
  // `clearTimeout` only cancels a request that has not fired yet — it cannot abort an
  // async body that is already awaiting the network. So a slow query for "kli" could
  // resolve *after* the fast query for "klimentos" and overwrite the correct results:
  // you saw the right thing first and then it jumped to something else entirely. Every
  // run takes a generation number and only the newest one is allowed to publish.
  let searchGeneration = 0;
  let expandedPlaylistId: string | null = null;
  let activePreviewPlaylist: any = null;
  let resultView: SearchView = 'all';
  let visibleTrackLimit = 20;
  let searchError = '';
  let searchNotice = '';

  const SEARCH_PAGE_SIZE = 20;

  $: localResults = $searchResults.filter((track: any) => sourceKind(track) === 'local');
  $: artistMatches = collectArtistMatches($searchResults).slice(0, 6);
  $: tracksForView = resultView === 'local' ? localResults : $searchResults;
  $: topResult = resultView === 'all' ? ($searchResults[0] ?? null) : null;
  $: tracksAfterTop = topResult ? tracksForView.filter((track: any) => track !== topResult) : tracksForView;
  $: visibleTrackResults = tracksAfterTop.slice(0, visibleTrackLimit);
  $: hasSearchData = $searchResults.length > 0 || $searchPlaylists.length > 0;

  function isPlaylistSaved(playlist: any, library: any[]) {
    return library.some(item => item.title === playlist.title || item.id === playlist.id);
  }

  function startPlaylistPreview(e: Event, pl: any) {
    e.stopPropagation();
    activePreviewPlaylist = pl;
  }

  onMount(() => {
    if ($searchQuery.trim() !== '' && $searchResults.length === 0) {
      scheduleSearch($searchQuery, 0);
    }
  });

  onDestroy(() => clearTimeout(timeout));

  function handleSearch(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    scheduleSearch(val);
  }

  function scheduleSearch(val: string, delay = 380) {
    searchQuery.set(val);
    clearTimeout(timeout);
    // Anything still in flight is stale from here on.
    const generation = ++searchGeneration;

    if (val.trim() === '') {
      searchResults.set([]);
      searchPlaylists.set([]);
      isLoading = false;
      searchError = '';
      searchNotice = '';
      resultView = 'all';
      return;
    }

    // Старая выдача не должна притворяться результатом уже нового запроса во время debounce.
    searchResults.set([]);
    searchPlaylists.set([]);
    expandedPlaylistId = null;
    visibleTrackLimit = SEARCH_PAGE_SIZE;
    resultView = 'all';
    searchError = '';
    searchNotice = '';
    isLoading = true;
    timeout = setTimeout(async () => {
      // Capture the query this run belongs to: `$searchQuery` keeps changing while we await.
      const query = val;
      const lowerQuery = query.toLowerCase();
      try {
        let filteredLocal: any[] = [];
        try {
          // Локальная медиатека отвечает первой и показывается, пока сеть ещё думает.
          const localTracks = await getTracks();
          filteredLocal = localTracks.filter(t =>
            t.title.toLowerCase().includes(lowerQuery) ||
            t.artist.toLowerCase().includes(lowerQuery)
          ).map(t => ({ ...t, source: 'Локальный', isLocal: true }));
        } catch (e) {
          console.warn('[Search] локальная медиатека недоступна', e);
          searchNotice = 'Не получилось проверить файлы на компьютере — онлайн-поиск продолжается.';
        }

        // Local matches show up immediately — no reason to stare at a spinner while
        // SoundCloud thinks. Still gated on the generation so a stale run stays quiet.
        if (generation === searchGeneration && filteredLocal.length > 0) {
          searchResults.set(filteredLocal);
        }

        const [tracksOutcome, playlistsOutcome] = await Promise.allSettled([
          performSearchDetailed(query),
          $settings.searchSource === 'soundcloud'
            ? getSoundCloudPlaylists(query, 4, true)
            : Promise.resolve([] as any[]),
        ]);

        if (generation !== searchGeneration) return;

        const onlineResults = tracksOutcome.status === 'fulfilled' ? tracksOutcome.value.tracks : [];
        const onlinePlaylists = playlistsOutcome.status === 'fulfilled' ? playlistsOutcome.value : [];

        // Одинаковый трек из файла и каталога показывается один раз. Локальный вариант
        // выигрывает по источнику воспроизведения, а недостающие обложка/длительность
        // добираются из онлайна.
        searchResults.set(mergeSearchResults(filteredLocal, onlineResults, query));
        searchPlaylists.set(onlinePlaylists || []);

        if (tracksOutcome.status === 'rejected') {
          searchError = filteredLocal.length > 0 || onlinePlaylists.length > 0
            ? 'Онлайн-каталог сейчас не ответил. Показываю то, что удалось найти.'
            : 'Онлайн-каталог сейчас недоступен.';
        } else if (tracksOutcome.value.fallbackUsed) {
          searchNotice = 'Яндекс Музыка не ответила — временно показаны результаты SoundCloud.';
        } else if (playlistsOutcome.status === 'rejected') {
          searchNotice = 'Треки найдены, но плейлисты SoundCloud сейчас не загрузились.';
        }
        isLoading = false;

        // Update history
        searchHistory.update(h => {
          const clean = query.trim();
          if (clean) {
            const key = clean.toLocaleLowerCase('ru');
            const filtered = h.filter(q => q.toLocaleLowerCase('ru') !== key);
            return [clean, ...filtered].slice(0, 20);
          }
          return h;
        });
      } catch (err) {
        console.error('[Search] запрос не удался', err);
        if (generation === searchGeneration) isLoading = false;
      }
    }, delay);
  }

  function setSearchSource(source: 'soundcloud' | 'yandex') {
    if (source === $settings.searchSource) return;
    if (source === 'yandex' && !$settings.yandexToken) {
      notify('Подключи Яндекс Музыку в настройках — тогда поиск сможет использовать её каталог.', 'info');
      return;
    }

    $settings.searchSource = source;
    expandedPlaylistId = null;
    searchResults.set([]);
    searchPlaylists.set([]);
    resultView = 'all';
    visibleTrackLimit = SEARCH_PAGE_SIZE;
    if ($searchQuery.trim()) scheduleSearch($searchQuery, 0);
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      scheduleSearch($searchQuery, 0);
    } else if (event.key === 'Escape' && $searchQuery) {
      event.preventDefault();
      clearSearch();
    }
  }

  function clearSearch() {
    scheduleSearch('', 0);
  }

  function retrySearch() {
    if ($searchQuery.trim()) scheduleSearch($searchQuery, 0);
  }

  function setResultView(view: SearchView) {
    resultView = view;
    visibleTrackLimit = SEARCH_PAGE_SIZE;
  }

  function removeHistoryItem(query: string) {
    searchHistory.update(items => items.filter(item => item !== query));
  }

  function sourceKind(track: any): SearchSourceKind {
    if (track?.isLocal || `${track?.source ?? ''}`.toLocaleLowerCase('ru') === 'локальный') return 'local';
    return track?.source === 'yandex' ? 'yandex' : 'soundcloud';
  }

  function sourceLabel(track: any) {
    const source = sourceKind(track);
    if (source === 'local') return 'На компьютере';
    return source === 'yandex' ? 'Яндекс Музыка' : 'SoundCloud';
  }

  function onlineSource(track: any): 'soundcloud' | 'yandex' {
    return sourceKind(track) === 'yandex' ? 'yandex' : 'soundcloud';
  }

  function normalizeSearchValue(value: unknown) {
    return `${value ?? ''}`
      .toLocaleLowerCase('ru')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function resultKey(track: any) {
    return `${normalizeSearchValue(track?.title)}::${normalizeSearchValue(track?.artist)}`;
  }

  function resultScore(track: any, query: string, order: number) {
    const needle = normalizeSearchValue(query);
    const title = normalizeSearchValue(track?.title);
    const artist = normalizeSearchValue(track?.artist);
    let score = 0;
    if (title === needle) score += 1000;
    else if (title.startsWith(needle)) score += 520;
    else if (title.includes(needle)) score += 260;
    if (artist === needle) score += 720;
    else if (artist.startsWith(needle)) score += 360;
    else if (artist.includes(needle)) score += 180;
    if (sourceKind(track) === 'local') score += 12;
    return score - order * 0.01;
  }

  function mergeSearchResults(local: any[], online: any[], query: string) {
    const merged = new Map<string, any>();
    for (const track of online) merged.set(resultKey(track), track);
    for (const track of local) {
      const onlineTwin = merged.get(resultKey(track));
      merged.set(resultKey(track), onlineTwin
        ? {
            ...onlineTwin,
            ...track,
            coverUrl: track.coverUrl || onlineTwin.coverUrl,
            artistAvatarUrl: track.artistAvatarUrl || onlineTwin.artistAvatarUrl,
            duration: track.duration || onlineTwin.duration,
            albumTitle: track.albumTitle || onlineTwin.albumTitle,
            source: 'Локальный',
            isLocal: true
          }
        : track);
    }

    return [...merged.values()]
      .map((track, order) => ({ track, score: resultScore(track, query, order) }))
      .sort((a, b) => b.score - a.score)
      .map(item => item.track);
  }

  function collectArtistMatches(tracks: any[]): ArtistMatch[] {
    const found = new Map<string, ArtistMatch>();
    for (const track of tracks) {
      for (const name of splitArtists(track?.artist, track?.artists)) {
        const key = normalizeSearchValue(name);
        if (!key) continue;
        const existing = found.get(key);
        if (existing) {
          existing.matches += 1;
        } else {
          found.set(key, {
            name,
            avatarUrl: track?.artistAvatarUrl || track?.coverUrl || '',
            source: sourceKind(track),
            matches: 1
          });
        }
      }
    }
    return [...found.values()].sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name, 'ru'));
  }

  function formatDuration(raw: unknown) {
    const value = Number(raw) || 0;
    if (value <= 0) return '';
    const seconds = Math.round(value > 1000 ? value / 1000 : value);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${`${seconds % 60}`.padStart(2, '0')}`;
  }

  /**
   * Флаг `isBanned` больше не глушит клик: в обработчике стояло `if (!track.isBanned)`, и
   * помеченная строка не отвечала ничем. Пометку же ставил плеер при любой неудаче с
   * получением ссылки, включая сетевую. Подробный разбор — в `playTrackList` (Library.svelte).
   */
  function playTrack(track: any) {
    if (!track) return;
    if (track.isBanned) {
      notify('Этот источник недавно не отвечал. Пробую запустить трек ещё раз.', 'info');
    }
    const idx = $searchResults.findIndex((t: any) => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set($searchResults.slice(idx + 1));
    } else {
      queue.set([]);
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function playPlaylist(pl: any) {
    if (pl.tracks && pl.tracks.length > 0) {
      queue.set(pl.tracks.slice(1));
      currentTrack.set(pl.tracks[0]);
      isPlaying.set(true);
    }
  }

  function togglePlaylistSaved(pl: any) {
    if (isPlaylistSaved(pl, $playlists)) {
      playlists.update(items => items.filter(item => item.title !== pl.title && item.id !== pl.id));
      notify(`Плейлист «${pl.title}» убран из медиатеки.`, 'info');
      return;
    }
    playlists.update(items => [...items, {
      id: pl.id || Date.now().toString(),
      title: pl.title,
      tracks: pl.tracks || [],
      coverUrl: pl.coverUrl || pl.tracks?.[0]?.coverUrl || ''
    }]);
    notify(`Плейлист «${pl.title}» добавлен в медиатеку.`, 'success');
  }

  function toggleLikeSearch(track: any, e: Event) {
    e.stopPropagation();
    // Через `$lib/likes`: отметка уезжает в аккаунт Яндекса, а снятая не возвращается сверкой.
    const liked = toggleTrackLike(track);
    notify(liked ? 'Трек добавлен в любимые.' : 'Трек убран из любимых.', liked ? 'success' : 'info');
  }

  /**
   * Какая строка держит открытое меню плейлистов. Само меню теперь живёт в `PlaylistMenu` и
   * состояние сообщает событием — здесь оно нужно ровно для двух вещей: поднять строку по
   * z-index и не гасить ряд кнопок, пока меню на экране (иначе меню исчезало вместе с рядом,
   * стоило курсору съехать со строки).
   */
  let showPlaylistMenuId: string | null = null;
</script>

<div class="search-page">
  <header class="search-page-head">
    <div class="search-page-title">
      <span>Вся музыка в одном месте</span>
      <h1>Поиск</h1>
      <p>Ищи треки, исполнителей, плейлисты и файлы с компьютера в одной выдаче.</p>
    </div>

    <div class="search-source-switch">
      <span class="search-source-label">Онлайн-каталог</span>
      <div
        class="seg-control search-source-control"
        style="--seg-count: 2; --seg-index: {$settings.searchSource === 'yandex' ? 1 : 0}"
        role="tablist"
        aria-label="Источник поиска"
        aria-busy={isLoading}
      >
        <span class="seg-pill" aria-hidden="true"></span>
        <button
          type="button"
          role="tab"
          aria-selected={$settings.searchSource === 'soundcloud'}
          class="seg-item"
          class:is-active={$settings.searchSource === 'soundcloud'}
          on:click={() => setSearchSource('soundcloud')}
        >
          <MusicServiceIcon service="soundcloud" size={15} />
          SoundCloud
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={$settings.searchSource === 'yandex'}
          aria-disabled={!$settings.yandexToken}
          class="seg-item"
          class:is-active={$settings.searchSource === 'yandex'}
          class:is-unavailable={!$settings.yandexToken}
          on:click={() => setSearchSource('yandex')}
          title={$settings.yandexToken ? 'Искать в Яндекс Музыке' : 'Сначала подключи Яндекс Музыку в настройках'}
        >
          <MusicServiceIcon service="yandex" size={16} />
          Яндекс
        </button>
      </div>
    </div>
  </header>

  <div class="search-command">
    <SearchIcon size={23} aria-hidden="true" />
    <input
      type="search"
      aria-label="Поиск музыки"
      autocomplete="off"
      spellcheck="false"
      placeholder="Название трека, исполнитель или плейлист"
      bind:value={$searchQuery}
      on:input={handleSearch}
      on:keydown={handleSearchKeydown}
    />
    <div class="search-command-actions">
      {#if isLoading}<Loader2 size={17} class="search-command-spinner" aria-label="Ищу" />{/if}
      {#if $searchQuery}
        <button type="button" aria-label="Очистить поиск" title="Очистить · Esc" on:click={clearSearch}>
          <X size={17} />
        </button>
      {/if}
    </div>
  </div>

  <div class="search-command-foot">
      <span>{isLoading ? 'Сначала покажу музыку с компьютера, а затем добавлю результаты из каталога' : 'Enter — найти сразу · Esc — очистить строку'}</span>
    {#if $searchQuery.trim() && hasSearchData}
      <span class="tnum">{withCount($searchResults.length, 'трек', 'трека', 'треков')}{#if $searchPlaylists.length} · {withCount($searchPlaylists.length, 'плейлист', 'плейлиста', 'плейлистов')}{/if}</span>
    {/if}
  </div>

  {#if $searchQuery.trim() === ''}
    <section class="search-welcome plate">
      <span class="search-welcome-icon" aria-hidden="true"><SearchIcon size={24} /></span>
      <div class="search-welcome-copy">
        <span>Как это работает</span>
        <h2>Введи название трека или имя исполнителя</h2>
        <p>Точные совпадения появятся первыми. Повторы не будут занимать место, а музыка с компьютера останется доступной даже без сети.</p>
      </div>
      <div class="search-capability-grid" aria-label="Что умеет поиск">
        <span><Music size={16} /><strong>Треки</strong><small>Из выбранного сервиса</small></span>
        <span><UserRound size={16} /><strong>Исполнители</strong><small>Можно сразу открыть профиль</small></span>
        <span><ListMusic size={16} /><strong>Плейлисты</strong><small>Подборки из SoundCloud</small></span>
        <span><HardDrive size={16} /><strong>На компьютере</strong><small>Работают без подключения к сети</small></span>
      </div>
    </section>

    <section class="search-history-section">
      <div class="search-section-heading">
        <div>
          <span>Быстрый возврат</span>
          <h2>Недавние запросы</h2>
        </div>
        {#if $searchHistory.length > 0}
          <button type="button" class="search-text-action" on:click={() => searchHistory.set([])}>Очистить всё</button>
        {/if}
      </div>

      {#if $searchHistory.length > 0}
        <div class="search-history-list">
          {#each $searchHistory as hist}
            <div class="search-history-chip">
              <button type="button" on:click={() => scheduleSearch(hist, 0)}>
                <Clock3 size={14} aria-hidden="true" />
                <span>{hist}</span>
              </button>
              <button type="button" aria-label="Удалить запрос «{hist}»" on:click={() => removeHistoryItem(hist)}>
                <X size={13} />
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <p class="search-history-empty">Здесь пока пусто. После первого поиска недавние запросы появятся автоматически.</p>
      {/if}
    </section>
  {:else if hasSearchData}
    {#if searchError || searchNotice || isLoading}
      <div class="search-live-status" class:is-error={Boolean(searchError)} aria-live="polite">
        {#if isLoading}<Loader2 size={15} class="search-command-spinner" />{:else if searchError}<RefreshCw size={15} />{:else}<SearchIcon size={15} />{/if}
        <span>{isLoading ? 'Дополняю выдачу из онлайн-каталога…' : (searchError || searchNotice)}</span>
        {#if searchError && !isLoading}<button type="button" on:click={retrySearch}>Повторить</button>{/if}
      </div>
    {/if}

    <div class="search-results-bar">
      <div>
        <span>Результаты</span>
        <h2 title={$searchQuery}>«{$searchQuery}»</h2>
      </div>
      <div class="search-result-tabs" role="tablist" aria-label="Вид результатов">
        <button type="button" role="tab" aria-selected={resultView === 'all'} class:is-active={resultView === 'all'} on:click={() => setResultView('all')}>Всё</button>
        {#if $searchResults.length > 0}
          <button type="button" role="tab" aria-selected={resultView === 'tracks'} class:is-active={resultView === 'tracks'} on:click={() => setResultView('tracks')}>Треки <span>{$searchResults.length}</span></button>
        {/if}
        {#if artistMatches.length > 0}
          <button type="button" role="tab" aria-selected={resultView === 'artists'} class:is-active={resultView === 'artists'} on:click={() => setResultView('artists')}>Исполнители <span>{artistMatches.length}</span></button>
        {/if}
        {#if $searchPlaylists.length > 0}
          <button type="button" role="tab" aria-selected={resultView === 'playlists'} class:is-active={resultView === 'playlists'} on:click={() => setResultView('playlists')}>Плейлисты <span>{$searchPlaylists.length}</span></button>
        {/if}
        {#if localResults.length > 0}
          <button type="button" role="tab" aria-selected={resultView === 'local'} class:is-active={resultView === 'local'} on:click={() => setResultView('local')}>На ПК <span>{localResults.length}</span></button>
        {/if}
      </div>
    </div>

    {#if resultView === 'all' && topResult}
      <section class="search-top-result">
        <div class="search-top-art">
          {#if topResult.coverUrl}
            <img src={topResult.coverUrl} alt="" decoding="async" />
          {:else}
            <Music size={34} aria-hidden="true" />
          {/if}
        </div>
        <div class="search-top-copy">
          <span class="search-result-kicker">Лучшее совпадение</span>
          <h2>{topResult.title}</h2>
          <p><ArtistTag artist={topResult.artist} artists={topResult.artists} /></p>
          <div class="search-top-meta">
            <span class="search-source-badge is-{sourceKind(topResult)}">
              {#if sourceKind(topResult) === 'local'}<HardDrive size={13} />{:else}<MusicServiceIcon service={onlineSource(topResult)} size={13} />{/if}
              {sourceLabel(topResult)}
            </span>
            {#if topResult.albumTitle}<span title={topResult.albumTitle}>{topResult.albumTitle}</span>{/if}
            {#if formatDuration(topResult.duration)}<span class="tnum">{formatDuration(topResult.duration)}</span>{/if}
          </div>
        </div>
        <button type="button" class="search-top-play" on:click={() => playTrack(topResult)}>
          <Play size={18} fill="currentColor" />
          Слушать
        </button>
      </section>
    {/if}

    {#if (resultView === 'all' || resultView === 'artists') && artistMatches.length > 0}
      <section class="search-results-section">
        <div class="search-section-heading">
          <div><span>Из найденных треков</span><h2>Исполнители</h2></div>
          <strong class="tnum">{artistMatches.length}</strong>
        </div>
        <div class="search-artist-grid">
          {#each artistMatches as artist (artist.name)}
            <button type="button" class="search-artist-card" on:click={() => goToArtist(artist.name)}>
              <span class="search-artist-avatar">
                {#if artist.avatarUrl}<img src={coverUrlAtSize(artist.avatarUrl, 120)} alt="" width="56" height="56" loading="lazy" decoding="async" />{:else}<UserRound size={22} />{/if}
              </span>
              <span class="search-artist-copy"><strong>{artist.name}</strong><small>{withCount(artist.matches, 'совпадение', 'совпадения', 'совпадений')}</small></span>
              <span class="search-artist-source is-{artist.source}" aria-label={artist.source === 'local' ? 'Файл на компьютере' : artist.source}>
                {#if artist.source === 'local'}<HardDrive size={13} />{:else}<MusicServiceIcon service={artist.source} size={13} />{/if}
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if (resultView === 'all' || resultView === 'playlists') && $searchPlaylists.length > 0}
      <section class="search-results-section">
        <div class="search-section-heading">
          <div><span>Подборки SoundCloud</span><h2>Плейлисты</h2></div>
          <strong class="tnum">{$searchPlaylists.length}</strong>
        </div>
        <div class="search-playlist-grid">
          {#each $searchPlaylists as pl (pl.id)}
            <article class="search-playlist-card" class:is-expanded={expandedPlaylistId === pl.id}>
              <div class="search-playlist-summary">
                <button type="button" class="search-playlist-art" on:click={() => expandedPlaylistId = expandedPlaylistId === pl.id ? null : pl.id} aria-expanded={expandedPlaylistId === pl.id}>
                  {#if pl.tracks?.[0]?.coverUrl}<img src={pl.tracks[0].coverUrl} alt="" loading="lazy" decoding="async" />{:else}<ListMusic size={28} />{/if}
                  <span><MusicServiceIcon service="soundcloud" size={13} /> SoundCloud</span>
                </button>
                <div class="search-playlist-copy">
                  <button type="button" class="search-playlist-title" on:click={() => expandedPlaylistId = expandedPlaylistId === pl.id ? null : pl.id}>{pl.title}</button>
                  <p>{withCount(pl.tracks?.length || 0, 'трек', 'трека', 'треков')}</p>
                  <div class="search-playlist-actions">
                    <button type="button" class="is-primary" on:click={() => playPlaylist(pl)} title="Слушать плейлист"><Play size={15} fill="currentColor" /> Слушать</button>
                    <button type="button" on:click={(e) => startPlaylistPreview(e, pl)} title="Трейлер плейлиста"><Radio size={15} /> Трейлер</button>
                    <button type="button" on:click={() => expandedPlaylistId = expandedPlaylistId === pl.id ? null : pl.id} aria-expanded={expandedPlaylistId === pl.id}>
                      <ChevronDown size={15} /> {expandedPlaylistId === pl.id ? 'Свернуть' : 'Открыть'}
                    </button>
                  </div>
                </div>
              </div>

              {#if expandedPlaylistId === pl.id}
                <div class="search-playlist-detail">
                  <div class="search-playlist-detail-head">
                    <div><span>Содержимое подборки</span><strong>{pl.title}</strong></div>
                    <button type="button" class:is-saved={isPlaylistSaved(pl, $playlists)} aria-pressed={isPlaylistSaved(pl, $playlists)} on:click={() => togglePlaylistSaved(pl)}>
                      <MorphIcon icon={isPlaylistSaved(pl, $playlists) ? CheckIcon : PlusIcon} size={17} spring="snappy" reducedMotion="user" />
                      {isPlaylistSaved(pl, $playlists) ? 'В медиатеке' : 'Добавить'}
                    </button>
                  </div>
                  <div class="search-playlist-track-grid">
                    {#each pl.tracks.slice(0, 30) as pt, i}
                      {@const playlistTrackActive = $currentTrack?.title === pt.title && $currentTrack?.artist === pt.artist}
                      <!-- svelte-ignore a11y-click-events-have-key-events -->
                      <!-- svelte-ignore a11y-no-static-element-interactions -->
                      <div class="search-playlist-track group/playlist-track" class:is-active={playlistTrackActive} on:click={() => { queue.set(pl.tracks.slice(i + 1)); currentTrack.set(pt); isPlaying.set(true); }}>
                        <span class="tnum">{i + 1}</span>
                        <span class="search-playlist-track-art">{#if pt.coverUrl}<img src={coverUrlAtSize(pt.coverUrl, 50)} alt="" width="36" height="36" loading="lazy" decoding="async" />{:else}<Music size={16} />{/if}</span>
                        <span class="search-playlist-track-copy"><strong>{pt.title}</strong><small><ArtistTag artist={pt.artist} artists={pt.artists} /></small></span>
                        <button type="button" aria-label={isTrackLiked($likedTracks, pt) ? 'Убрать из любимых' : 'Добавить в любимые'} on:click={(e) => toggleLikeSearch(pt, e)}>
                          <Heart size={15} fill={isTrackLiked($likedTracks, pt) ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    {/each}
                  </div>
                  {#if pl.tracks.length > 30}<p class="search-playlist-more">Ещё {pl.tracks.length - 30} треков доступны при запуске плейлиста.</p>{/if}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {/if}

    {#if (resultView === 'all' || resultView === 'tracks' || resultView === 'local') && tracksAfterTop.length > 0}
      <section class="search-results-section">
        <div class="search-section-heading">
          <div><span>{resultView === 'local' ? 'Без подключения к сети' : 'По релевантности'}</span><h2>{resultView === 'local' ? 'На компьютере' : 'Треки'}</h2></div>
          <strong class="tnum">{tracksAfterTop.length}</strong>
        </div>
        <div class="track-row-list search-track-list" class:has-open-track-menu={showPlaylistMenuId !== null}>
          {#each visibleTrackResults as track, i (resultKey(track))}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            {@const rowKey = `${sourceKind(track)}:${track.id || track.title}`}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="track-row-card group interactive-item {isActive ? 'is-active' : ''} {track.isBanned ? 'is-banned' : ''}" class:has-open-menu={showPlaylistMenuId === rowKey} on:click={() => playTrack(track)}>
              <TrackStatus index={topResult ? i + 1 : i} {isActive} playing={$isPlaying} banned={track.isBanned} size="md" />
              <div class="track-row-art">
                {#if track.coverUrl}<img src={coverUrlAtSize(track.coverUrl, 120)} alt="" width="48" height="48" loading="lazy" decoding="async" />{:else}<div class="track-row-art-empty"><Music size={20} /></div>{/if}
              </div>
              <div class="track-row-copy">
                <span class="track-row-title">{track.title}</span>
                <span class="track-row-artist"><ArtistTag artist={track.artist} artists={track.artists} /></span>
              </div>
              <div class="search-track-facts">
                <span class="search-source-badge is-{sourceKind(track)}">
                  {#if sourceKind(track) === 'local'}<HardDrive size={12} />{:else}<MusicServiceIcon service={onlineSource(track)} size={12} />{/if}
                  {sourceLabel(track)}
                </span>
                {#if formatDuration(track.duration)}<span class="tnum">{formatDuration(track.duration)}</span>{/if}
              </div>
              <div class="track-row-actions">
                <button type="button" aria-label={isTrackLiked($likedTracks, track) ? 'Убрать из любимых' : 'Добавить в любимые'} aria-pressed={isTrackLiked($likedTracks, track)} class="track-row-action" class:is-liked={isTrackLiked($likedTracks, track)} on:click={(e) => toggleLikeSearch(track, e)}>
                  <Heart size={17} fill={isTrackLiked($likedTracks, track) ? 'currentColor' : 'none'} />
                </button>
                <span class="track-row-menu-slot">
                  <PlaylistMenu {track} placement="top" align="right" on:toggle={(e) => showPlaylistMenuId = e.detail ? rowKey : null} buttonClass="track-row-action" />
                </span>
              </div>
            </div>
          {/each}
        </div>
        {#if visibleTrackResults.length < tracksAfterTop.length}
          <button type="button" class="search-show-more" on:click={() => visibleTrackLimit += SEARCH_PAGE_SIZE}>
            <ChevronDown size={16} /> Показать ещё {Math.min(SEARCH_PAGE_SIZE, tracksAfterTop.length - visibleTrackResults.length)}
          </button>
        {/if}
      </section>
    {/if}
  {:else if isLoading}
    <section class="search-loading-state" aria-live="polite" aria-label="Поиск выполняется">
      <div><Loader2 size={20} class="search-command-spinner" /><span><strong>Ищу «{$searchQuery}»</strong><small>Сначала проверяю музыку на компьютере, затем — онлайн-каталог</small></span></div>
      {#each Array(5) as _}
        <span class="search-loading-row"><i></i><b></b><em></em></span>
      {/each}
    </section>
  {:else if searchError}
    <section class="search-empty-state plate">
      <span><RefreshCw size={23} /></span>
      <h2>Не удалось связаться с каталогом</h2>
      <p>{searchError} Проверь подключение к интернету и попробуй ещё раз.</p>
      <button type="button" on:click={retrySearch}><RefreshCw size={15} /> Повторить поиск</button>
    </section>
  {:else}
    <section class="search-empty-state plate">
      <span><SearchIcon size={23} /></span>
      <h2>По «{$searchQuery}» ничего не нашлось</h2>
      <p>Проверь написание, сократи запрос или попробуй другой онлайн-каталог.</p>
    </section>
  {/if}
</div>

{#if activePreviewPlaylist}
  <PlaylistTrailer playlist={activePreviewPlaylist} onClose={() => activePreviewPlaylist = null} />
{/if}
