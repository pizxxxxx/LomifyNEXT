<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Play, FolderOpen, Heart, User, Music, Trash2, ListMusic, Plus, ExternalLink, Check, Download, Info, Radio, X, Loader2, ArrowLeft } from 'lucide-svelte';
  import { LayoutGrid as LayoutGridIcon, List as ListIcon, Pause as PauseIcon, Play as PlayIcon } from 'lucide';
  import { MorphIcon } from 'morphicons/svelte';
  import ArtistTag from './ArtistTag.svelte';
  import PlaylistMenu from './PlaylistMenu.svelte';
  import TrackStatus from './TrackStatus.svelte';
  import PlaylistTrailer from './PlaylistTrailer.svelte';
  import { currentTrack, isPlaying, likedTracks, queue, currentView, searchQuery, playlists, notify, settings } from '$lib/stores';
  import { goToArtist } from '$lib/utils/navigation';
  import { splitArtists } from '$lib/utils/artists';
  import { saveTrack, getTracks, removeTrack } from '$lib/db';
  import { getAudioUrl } from '$lib/api';
  import { setTrackLiked } from '$lib/likes';
  import { invoke } from '@tauri-apps/api/core';
  import { withCount } from '$lib/utils/plural';
  import { coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';

  type LibraryTab = 'liked' | 'playlists' | 'artists' | 'local';

  /** Порядок вкладок — он же порядок ячеек переключателя, из него берётся и направление
      перехода: вправо, если ушли к следующей вкладке, влево — если к предыдущей. */
  const TAB_ORDER: LibraryTab[] = ['liked', 'playlists', 'artists', 'local'];

  let activeTab: LibraryTab = 'liked';
  let navDir = 1;
  $: tabIndex = TAB_ORDER.indexOf(activeTab);

  let localTracks: any[] = [];
  let cachedUrns = new Set<string>();
  let removingCachedUrns = new Set<string>();
  let expandedPlaylist: string | null = null;
  let openedPlaylist: any = null;
  let activePreviewPlaylist: any = null;

  $: openedPlaylist = expandedPlaylist
    ? $playlists.find(playlist => playlist.id === expandedPlaylist) ?? null
    : null;

  type LikedView = 'list' | 'grid';
  const LIKED_VIEW_KEY = 'lomify-library-liked-view';
  let likedView: LikedView = 'list';

  function toggleLikedView() {
    likedView = likedView === 'list' ? 'grid' : 'list';
    activeTrackMenu = null;
    try {
      localStorage.setItem(LIKED_VIEW_KEY, likedView);
    } catch (e) {}
  }

  /**
   * Сколько строк рисуем сразу. Раньше медиатека строила ВСЕ строки в один кадр, и на
   * нескольких сотнях лайков это был один синхронный проход на полсекунды: клик по
   * «Медиатеке» ощущался как заминка, а анимация входа за это время успевала «пройти»
   * вхолостую — её просто не было видно. Первый кадр теперь заведомо дешёвый, остальное
   * дорисовывается по кадрам: к моменту, когда человек доскроллит, список уже целый.
   */
  const ROWS_FIRST_PAINT = 18;
  const ROWS_STEP = 40;
  let rowBudget = ROWS_FIRST_PAINT;
  let growHandle = 0;

  /** Оба всплывающих слоя строки принадлежат одному состоянию: это не даёт информации и
      плейлистам открыться одновременно и держит тяжёлую разметку только у одной строки. */
  type TrackMenuKind = 'info' | 'playlist';
  let activeTrackMenu: { row: number; kind: TrackMenuKind } | null = null;

  function isTrackMenuOpen(row: number, kind?: TrackMenuKind) {
    return activeTrackMenu?.row === row && (!kind || activeTrackMenu.kind === kind);
  }

  function toggleInfoMenu(event: MouseEvent, row: number) {
    event.preventDefault();
    event.stopPropagation();
    activeTrackMenu = isTrackMenuOpen(row, 'info') ? null : { row, kind: 'info' };
  }

  function handlePlaylistMenuToggle(row: number, event: CustomEvent<boolean>) {
    if (event.detail) {
      activeTrackMenu = { row, kind: 'playlist' };
    } else if (isTrackMenuOpen(row, 'playlist')) {
      activeTrackMenu = null;
    }
  }

  function onTrackMenuPointerDown(event: PointerEvent) {
    if (!activeTrackMenu) return;
    const owner = (event.target as HTMLElement | null)?.closest?.('[data-track-menu-owner]') as HTMLElement | null;
    if (owner?.dataset.trackMenuOwner !== String(activeTrackMenu.row)) activeTrackMenu = null;
  }

  function onTrackMenuKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (showCreatePlaylistModal) {
      closeCreatePlaylistDialog();
    } else if (expandedPlaylist) {
      closePlaylistDetail();
    } else {
      activeTrackMenu = null;
    }
  }

  function setTab(tab: LibraryTab) {
    if (tab === activeTab) return;
    navDir = TAB_ORDER.indexOf(tab) > tabIndex ? 1 : -1;
    expandedPlaylist = null;
    activeTrackMenu = null;
    activeTab = tab;
    // Бюджет строк сбрасывается вместе с вкладкой: иначе переход на «Локальные» с уже
    // раскрученного «Любимого» снова строил бы сотни строк в том же кадре, в котором
    // начинается выезд панели, и выезда опять было бы не видно.
    rowBudget = ROWS_FIRST_PAINT;
    growRows();
  }

  /** Сколько строк вообще нужно активной вкладке — предел, до которого растёт бюджет. */
  $: rowsNeeded =
    activeTab === 'liked' ? $likedTracks.length
    : activeTab === 'local' ? localTracks.length
    : activeTab === 'artists' ? groupedArtists.length
    : $playlists.length;

  $: visibleLiked = $likedTracks.slice(0, rowBudget);
  $: visibleLocal = localTracks.slice(0, rowBudget);
  $: visibleArtists = groupedArtists.slice(0, rowBudget);

  function growRows() {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (growHandle) cancelAnimationFrame(growHandle);
    const step = () => {
      growHandle = 0;
      if (rowBudget >= rowsNeeded) return;
      rowBudget += ROWS_STEP;
      growHandle = requestAnimationFrame(step);
    };
    growHandle = requestAnimationFrame(step);
  }

  function startPlaylistPreview(e: Event, pl: any) {
    e.stopPropagation();
    activePreviewPlaylist = pl;
  }

  function focusPlaylistCard(id: string) {
    if (typeof document === 'undefined') return;
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
    document.querySelector<HTMLButtonElement>(`[data-playlist-id="${safeId}"]`)?.focus();
  }

  function openPlaylistDetail(id: string) {
    expandedPlaylist = id;
    activeTrackMenu = null;
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.library-playlist-detail')?.scrollIntoView({ block: 'start' });
      });
    }
  }

  function closePlaylistDetail() {
    const id = expandedPlaylist;
    expandedPlaylist = null;
    if (id) void tick().then(() => focusPlaylistCard(id));
  }

  // Computed grouped artists
  //
  // Считаем по отдельным именам, а не по подписи трека. Пока ключом была строка целиком,
  // фит «A, B» становился третьим «артистом» с собственной плиткой, а сами A и B недобирали
  // по треку каждый: в разделе появлялись имена, которых нет ни в одном сервисе.
  $: groupedArtists = (() => {
    const map = $likedTracks.reduce((acc: any, t) => {
      const names = splitArtists(t.artist, t.artists);
      names.forEach((name, i) => {
        if (!acc[name]) {
          // `artistAvatarUrl` — портрет ПЕРВОГО исполнителя (см. `mapYandexTrack`), поэтому
          // остальным он не достаётся: чужое лицо на плитке хуже обложки трека.
          acc[name] = { count: 0, avatarUrl: (i === 0 ? t.artistAvatarUrl : '') || t.coverUrl };
        }
        acc[name].count += 1;
      });
      return acc;
    }, {});
    return Object.entries(map)
      .map(([name, data]: any) => ({ name, count: data.count, avatarUrl: data.avatarUrl }))
      .sort((a, b) => b.count - a.count);
  })();

  // Playlist creation
  let newPlaylistName = '';
  let showCreatePlaylistModal = false;
  let createPlaylistTrigger: HTMLButtonElement;

  function openCreatePlaylistDialog() {
    newPlaylistName = '';
    showCreatePlaylistModal = true;
  }

  function closeCreatePlaylistDialog(restoreFocus = true) {
    showCreatePlaylistModal = false;
    if (restoreFocus) void tick().then(() => createPlaylistTrigger?.focus());
  }

  function handleCreatePlaylistSubmit() {
    if (newPlaylistName.trim()) {
      const createdId = createPlaylist();
      if (!createdId) return;
      // Оставляем фон модалки на время завершения исходного нажатия: новая карточка появляется
      // ровно под кнопкой «Создать», и при синхронном снятии слоя могла открыться следом.
      const finish = () => {
        expandedPlaylist = null;
        showCreatePlaylistModal = false;
        void tick().then(() => focusPlaylistCard(createdId));
      };
      if (typeof window === 'undefined') finish();
      else window.setTimeout(finish, 80);
    }
  }

  onMount(() => {
    try {
      const savedView = localStorage.getItem(LIKED_VIEW_KEY);
      if (savedView === 'list' || savedView === 'grid') likedView = savedView;
    } catch (e) {}

    (async () => {
      localTracks = await getTracks();
      growRows();
      try {
        const list = await invoke<string[]>('track_list_cached');
        cachedUrns = new Set(list);
      } catch (e) {}
    })();
    growRows();

    const handleCacheCleared = () => {
      cachedUrns = new Set();
    };
    const handleTrackCacheChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ urn?: string; cached?: boolean }>).detail;
      if (!detail?.urn) return;
      const next = new Set(cachedUrns);
      if (detail.cached) next.add(detail.urn);
      else next.delete(detail.urn);
      cachedUrns = next;
    };
    window.addEventListener('cacheCleared', handleCacheCleared);
    window.addEventListener('trackCacheChanged', handleTrackCacheChanged);
    window.addEventListener('pointerdown', onTrackMenuPointerDown, true);
    window.addEventListener('keydown', onTrackMenuKeydown);
    return () => {
      window.removeEventListener('cacheCleared', handleCacheCleared);
      window.removeEventListener('trackCacheChanged', handleTrackCacheChanged);
      window.removeEventListener('pointerdown', onTrackMenuPointerDown, true);
      window.removeEventListener('keydown', onTrackMenuKeydown);
    };
  });

  onDestroy(() => {
    if (growHandle) cancelAnimationFrame(growHandle);
  });

  /**
   * URN считается регулярным выражением, а вызывали его по два-три раза на строку в каждом
   * кадре перерисовки списка. Объект трека для одной строки не меняется, поэтому результат
   * живёт рядом с ним: `WeakMap` не держит треки в памяти после удаления из списка.
   */
  const urnCache = new WeakMap<object, string>();

  function trackUrn(track: any): string {
    const hit = urnCache.get(track);
    if (hit) return hit;
    const trackIdStr = track.id ? track.id : `${track.title}-${track.artist}`;
    const urn = `lomify:${track.source}:${trackIdStr}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');
    urnCache.set(track, urn);
    return urn;
  }

  // `_cache` не используется в теле намеренно: он нужен как зависимость в разметке, чтобы
  // Svelte перерисовал строки, когда пополнился набор скачанного.
  function isTrackCached(track: any, _cache?: Set<string>) {
    return cachedUrns.has(trackUrn(track));
  }

  function isRemovingCachedTrack(track: any) {
    return removingCachedUrns.has(trackUrn(track));
  }

  function publishTrackCacheState(urn: string, cached: boolean) {
    window.dispatchEvent(new CustomEvent('trackCacheChanged', { detail: { urn, cached } }));
  }

  import { open } from '@tauri-apps/plugin-dialog';

  async function handleFileSelect() {
    try {
      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Audio',
          extensions: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg']
        }]
      });
      
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      
      const newTracks = await Promise.all(paths.map(async path => {
        const fileNameWithExt = path.replace(/^.*[\\/]/, '');
        const fileName = fileNameWithExt.replace(/\.[^/.]+$/, "");
        const nameParts = fileName.split('-');
        const artist = nameParts.length > 1 ? nameParts[0].trim() : 'Неизвестен';
        const title = nameParts.length > 1 ? nameParts[1].trim() : nameParts[0].trim();
        
        const stableId = `local-${path}`;
        
        return {
          id: stableId,
          title,
          artist,
          coverUrl: '',
          isLocal: true,
          audioUrl: path,
          source: 'Локальный'
        };
      }));
      
      for (const track of newTracks) {
        if (!localTracks.find(t => t.id === track.id)) {
          await saveTrack(track);
          localTracks = [...localTracks, track];
        }
      }
      if (newTracks.length > 0) {
        notify(`Добавлено с компьютера: ${withCount(newTracks.length, 'трек', 'трека', 'треков')}.`, 'success');
      }
    } catch (err) {
      console.error("Failed to open dialog:", err);
      notify('Не удалось добавить файлы. Возможно, их формат не поддерживается.', 'error');
    }
  }

  async function deleteTrack(e: Event, id: string) {
    e.stopPropagation();
    await removeTrack(id);
    localTracks = localTracks.filter(t => t.id !== id);
    notify('Трек удалён из локальной медиатеки.', 'info');
  }

  /**
   * Запуск трека из любого списка библиотеки.
   *
   * Флаг `isBanned` здесь больше не блокирует запуск, и это осознанно. В обработчиках
   * стояло `if (!track.isBanned) playTrackList(...)` — то есть клик по помеченной строке
   * не делал ВООБЩЕ ничего: ни звука, ни уведомления, ни следа в консоли. А пометку
   * ставил плеер при любой неудаче с получением ссылки и складывал в localStorage, так
   * что одна сетевая осечка навсегда выключала строку. Отсюда и «с главной играет, а из
   * лайков нет»: лента фильтрует недоступные треки при загрузке и каждый запуск заново,
   * а лайки лежат на диске вместе с флагами.
   *
   * Теперь флаг — предупреждение, а не запрет: пробуем всё равно, а если источник и
   * правда не отдаст поток, об этом честно скажет плеер. Молчаливого клика не остаётся
   * ни в одном случае.
   */
  function playTrackList(track: any, list: any[]) {
    if (!track) return;
    if (track.isBanned) {
      notify('Этот источник недавно не отвечал. Пробую запустить трек ещё раз.', 'info');
    }
    const idx = list.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set(list.slice(idx + 1));
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function toggleTrackPlayback(e: Event, track: any, list: any[]) {
    e.stopPropagation();
    const isCurrent = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist;
    if (isCurrent) {
      isPlaying.update(value => !value);
      return;
    }
    playTrackList(track, list);
  }

  function removeLikedTrack(e: Event, track: any) {
    e.stopPropagation();
    // Через `$lib/likes`: снятие уезжает в аккаунт Яндекса, а у SoundCloud запоминается
    // локально — иначе сверка при следующем запуске вернула бы трек обратно.
    setTrackLiked(track, false);
    notify('Трек убран из любимых.', 'info');
  }

  function createPlaylist(): string | null {
    const title = newPlaylistName.trim();
    if (!title) return null;
    const id = Date.now().toString();
    playlists.update(p => [...p, { id, title, tracks: [] }]);
    notify(`Плейлист «${title}» создан.`, 'success');
    newPlaylistName = '';
    return id;
  }

  function deletePlaylist(e: Event, id: string) {
    e.stopPropagation();
    playlists.update(p => p.filter(pl => pl.id !== id));
    notify('Плейлист удалён.', 'info');
  }

  // Добавление в плейлист живёт в `PlaylistMenu` — здесь осталось только удаление, которым
  // пользуется раскрытый плейлист (крестик у строки).
  function removeFromPlaylist(e: Event, track: any, playlistId: string) {
    e.stopPropagation();
    playlists.update(p => {
      const idx = p.findIndex(pl => pl.id === playlistId);
      if (idx !== -1) {
        p[idx].tracks = p[idx].tracks.filter((t: any) => t.title !== track.title || t.artist !== track.artist);
        notify(`Трек убран из плейлиста «${p[idx].title}».`, 'info');
      }
      return p;
    });
  }

  async function downloadTrack(e: any, track: any): Promise<boolean> {
    if (e) e.stopPropagation();
    try {
      let url = track.url;
      if (!url) {
        url = await getAudioUrl(track);
      }
      if (!url) {
        // Пометок «заблокирован» здесь больше нет. Раньше неудача скачивания писала
        // `isBanned = true` в объект, в базу и в лайки — то есть в localStorage, навсегда.
        // После этого строка в «Любимом» переставала реагировать на клик даже при живом
        // треке: причиной могла быть просроченная подпись, 403 из-за заголовков или обрыв
        // сети, а последствие было одно и то же и необратимое. Не удалось скачать — значит
        // не удалось скачать, и только сейчас.
        throw new Error("No audio URL found");
      }
      
      const urn = trackUrn(track);
      const request = {
        urn,
        coverUrl: track.coverUrl || null,
        url,
        urls: [url],
        hq: false,
        durationMs: track.duration ? track.duration : null
      };

      await invoke('track_ensure_cached', { request });
      publishTrackCacheState(urn, true);
      if (e) notify(`Трек «${track.title}» сохранён на компьютере.`, 'success');
      return true;
    } catch (err) {
      console.error(err);
      if (e) notify(`Не удалось скачать трек «${track.title}».`, 'error');
      return false;
    }
  }

  /** Удаляет только сохранённый звук и его служебные метаданные. Сам трек остаётся в
      лайках/плейлисте и сразу снова получает действие «Скачать». */
  async function removeDownloadedTrack(e: Event, track: any) {
    e.stopPropagation();
    const urn = trackUrn(track);
    if (removingCachedUrns.has(urn)) return;

    removingCachedUrns = new Set(removingCachedUrns).add(urn);
    try {
      const removed = await invoke<boolean>('track_remove_cached', { urn });
      const stillCached = await invoke<boolean>('track_is_cached', { urn });
      if (!removed && stillCached) {
        throw new Error('cache file is still in use');
      }
      publishTrackCacheState(urn, false);
      notify(`Трек «${track.title}» удалён с компьютера.`, 'info');
    } catch (err) {
      console.error('Could not remove cached track', err);
      notify(`Не удалось удалить трек «${track.title}». Возможно, файл сейчас используется.`, 'error');
    } finally {
      const next = new Set(removingCachedUrns);
      next.delete(urn);
      removingCachedUrns = next;
    }
  }


  let isDownloadingAll = false;
  let cancelDownloadAll = false;
  async function downloadAllTracks(tracks: any[]) {
    if (isDownloadingAll || tracks.length === 0) return;
    isDownloadingAll = true;
    cancelDownloadAll = false;
    let downloadedCount = 0;
    
    for (const track of tracks) {
      if (cancelDownloadAll) break;
      if (!isTrackCached(track, cachedUrns) && !track.isBanned) {
        const success = await downloadTrack(null, track);
        if (success) {
          downloadedCount++;
        }
      }
    }
    
    isDownloadingAll = false;
    if (cancelDownloadAll) {
      notify(`Загрузка остановлена. Сохранено ${withCount(downloadedCount, 'трек', 'трека', 'треков')}.`, 'info');
    } else if (downloadedCount > 0) {
      notify(`Готово: сохранено ${withCount(downloadedCount, 'трек', 'трека', 'треков')}.`, 'success');
    } else {
      notify('Все треки уже сохранены на компьютере.', 'info');
    }
  }

  $: isAllLikedCached = $likedTracks.length > 0 && $likedTracks.every(track => isTrackCached(track, cachedUrns));

  function isAllPlaylistCached(tracks: any[]) {
    if (!tracks || tracks.length === 0) return false;
    return tracks.every(track => isTrackCached(track));
  }
</script>

<div class="w-full max-w-6xl mx-auto flex flex-col">
  <div class="flex items-center justify-between mb-8">
    <h1 class="page-title">Медиатека</h1>
  </div>

  <!-- Вкладки. Тот же переключатель, что на странице артиста между «Треками» и «Альбомами»:
       активный раздел показывает не перекрашенная кнопка, а одна плашка, которая переезжает
       между ячейками, а содержимое выезжает в сторону перехода. Раньше здесь были четыре
       независимые кнопки с `scale-105` — по ним нельзя было понять, что это один орган
       управления, и связи между «было» и «стало» не возникало.
       Оформление тянется из токенов (`--color-primary`), поэтому в теме aurora переключатель
       выглядит по-аврорному сам, без второго набора правил. -->
  <div class="library-tabs">
    <div
      class="seg-control is-lg"
      style="--seg-count: 4; --seg-index: {tabIndex}"
      role="tablist"
      aria-label="Разделы медиатеки"
    >
      <span class="seg-pill" aria-hidden="true"></span>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'liked'}
        class="seg-item"
        class:is-active={activeTab === 'liked'}
        on:click={() => setTab('liked')}
      >
        <Heart size={15} fill={activeTab === 'liked' ? 'currentColor' : 'none'} />
        Любимые
        <span class="seg-count tnum">{$likedTracks.length}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'playlists'}
        class="seg-item"
        class:is-active={activeTab === 'playlists'}
        on:click={() => setTab('playlists')}
      >
        <ListMusic size={15} />
        Плейлисты
        <span class="seg-count tnum">{$playlists.length}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'artists'}
        class="seg-item"
        class:is-active={activeTab === 'artists'}
        on:click={() => setTab('artists')}
      >
        <User size={15} />
        Артисты
        <span class="seg-count tnum">{groupedArtists.length}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'local'}
        class="seg-item"
        class:is-active={activeTab === 'local'}
        on:click={() => setTab('local')}
      >
        <FolderOpen size={15} />
        Локальные
        <span class="seg-count tnum">{localTracks.length}</span>
      </button>
    </div>
  </div>

  <!-- Content -->
  {#key activeTab}
    <div
      class="library-pane flex-1 pr-4 perspective-[1000px]"
      in:fly={{ x: 34 * navDir, duration: 340, easing: cubicOut }}
    >
    {#if activeTab === 'local'}
      <div class="flex flex-col gap-4 mb-6">
        <div class="flex items-center justify-between">
          <h2 class="section-title">Офлайн треки</h2>
          <button class="cursor-pointer glass-button hover:bg-primary hover:text-black transition-all px-6 py-3 rounded-2xl font-bold flex items-center gap-2 text-sm shadow-md" on:click={handleFileSelect}>
            <FolderOpen size={18} />
            Выбрать файлы
          </button>
        </div>
      </div>

      {#if localTracks.length === 0}
        <div class="w-full py-20 px-10 flex flex-col items-start plate mt-4">
          <Music size={26} class="mb-5 text-white/20" />
          <p class="display-title">Здесь будет твоя музыка</p>
          <p class="empty-hint">Всё, что лежит на компьютере — папкой целиком или по одному файлу. Кнопка «Выбрать файлы» сверху.</p>
        </div>
      {:else}
        <div class="flex flex-col gap-3 p-2">
          {#each visibleLocal as track, i}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div 
              class="flex items-center gap-4 group cursor-pointer rounded-xl p-2 transition-colors w-full interactive-item {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'}"
              on:click={() => playTrackList(track, localTracks)}
            >
              <TrackStatus index={i} {isActive} playing={$isPlaying} />
              <div class="relative w-12 h-12 min-w-[3rem] min-h-[3rem] aspect-square shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800">
                <div class="w-full h-full flex items-center justify-center text-neutral-500">
                  <Music size={20} />
                </div>
              </div>
              <div class="flex flex-col flex-1 min-w-0 pr-4">
                <span class="font-bold text-[14px] truncate {isActive ? 'text-primary' : 'text-white'}">
                  {track.title}
                  {#if isTrackCached(track, cachedUrns)}
                    <Check size={14} class="text-primary inline-block ml-2 mb-0.5" />
                  {/if}
                </span>
                <span class="text-neutral-400 text-[12px] mt-0.5 min-w-0"><ArtistTag artist={track.artist} artists={track.artists} /></span>
              </div>
              <button
                class="opacity-0 group-hover:opacity-100 p-3 hover:bg-red-500/20 hover:text-red-400 text-neutral-500 rounded-full transition-all mr-2"
                on:click|stopPropagation={(e) => deleteTrack(e, track.id)}
                aria-label="Удалить"
              >
                <Trash2 size={20} />
              </button>
            </div>
          {/each}
        </div>
      {/if}

    {:else if activeTab === 'liked'}
      {#if $likedTracks.length === 0}
        <div class="w-full py-20 px-10 flex flex-col items-start plate mt-4">
          <Heart size={26} class="mb-5 text-white/20" />
          <p class="display-title">Пока ни одного лайка</p>
          <p class="empty-hint">Жми на сердечко у трека — он окажется здесь и останется доступным даже без сети.</p>
        </div>
      {:else}
        <div class="library-liked-toolbar">
          <div class="text-sm text-neutral-400">{withCount($likedTracks.length, 'трек', 'трека', 'треков')}</div>
          <div class="library-liked-tools">
            <button
              type="button"
              data-press-late
              class="library-view-toggle"
              aria-label={likedView === 'list' ? 'Показать треки плиткой' : 'Показать треки списком'}
              title={likedView === 'list' ? 'Показать плиткой' : 'Показать списком'}
              on:click={toggleLikedView}
            >
              <MorphIcon
                icon={likedView === 'list' ? LayoutGridIcon : ListIcon}
                size={17}
                spring="snappy"
                reducedMotion="user"
              />
              <span>{likedView === 'list' ? 'Плиткой' : 'Списком'}</span>
            </button>
            <button
              class="glass-button transition-all px-4 py-2 rounded-xl font-bold flex items-center gap-2 text-sm shadow-md {isDownloadingAll ? 'hover:bg-red-500 hover:text-white group' : 'hover:bg-primary hover:text-black'} disabled:opacity-50"
              on:click={() => {
                if (isDownloadingAll) {
                  cancelDownloadAll = true;
                } else {
                  downloadAllTracks($likedTracks);
                }
              }}
              disabled={isAllLikedCached && !isDownloadingAll}
            >
              {#if isDownloadingAll}
                <div class="group-hover:hidden flex items-center gap-2">
                  <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg> Загрузка...
                </div>
                <div class="hidden group-hover:flex items-center gap-2">
                  <X size={16} /> Отменить
                </div>
              {:else if isAllLikedCached}
                <Check size={16} class="text-green-400" /> Скачано
              {:else}
                <Download size={16} /> Скачать всё
              {/if}
            </button>
          </div>
        </div>
        {#if likedView === 'list'}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="track-row-list"
          class:has-open-track-menu={activeTrackMenu !== null}
        >
          {#each visibleLiked as track, i}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            {@const cached = isTrackCached(track, cachedUrns)}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              data-row={i}
              data-track-menu-owner={i}
              class="track-row-card group interactive-item {isActive ? 'is-active' : ''} {track.isBanned ? 'is-banned' : ''}"
              class:has-open-menu={activeTrackMenu?.row === i}
              on:click={() => playTrackList(track, $likedTracks)}
            >
              <TrackStatus index={i} {isActive} playing={$isPlaying} banned={track.isBanned} />
              <div class="track-row-art">
                {#if track.coverUrl}
                  <img src={coverUrlForTrack(track, $downloadedCoverCache)} alt="" loading="lazy" decoding="async" />
                {:else}
                  <div class="track-row-art-empty">
                    <Music size={20} />
                  </div>
                {/if}
              </div>
              <div class="track-row-copy">
                <div class="flex items-center gap-2">
                  <span class="track-row-title">{track.title}</span>
                  {#if cached}
                    <span title="Скачан" class="track-row-saved"><Check size={13} /></span>
                  {/if}
                </div>
                <span class="track-row-artist"><ArtistTag artist={track.artist} artists={track.artists} /></span>
              </div>
              <div class="track-row-actions">
                {#if !cached}
                  <button
                    class="track-row-action"
                    on:click|stopPropagation={(e) => downloadTrack(e, track)}
                    aria-label="Скачать"
                  >
                    <Download size={18} />
                  </button>
                {:else}
                  <button
                    type="button"
                    class="track-row-action is-saved cache-state-control"
                    class:is-busy={isRemovingCachedTrack(track)}
                    on:click|stopPropagation={(e) => removeDownloadedTrack(e, track)}
                    aria-label={`Удалить скачанный файл «${track.title}»`}
                    title="Удалить скачанный файл"
                    disabled={isRemovingCachedTrack(track)}
                  >
                    {#if isRemovingCachedTrack(track)}
                      <Loader2 size={17} class="animate-spin" />
                    {:else}
                      <span class="cache-state-saved"><Check size={18} /></span>
                      <span class="cache-state-remove"><Trash2 size={17} /></span>
                    {/if}
                  </button>
                {/if}

                <!-- Информация и плейлисты управляются одним состоянием. Поэтому открытие
                     одного меню всегда закрывает соседнее и меню другой строки. -->
                <div class="track-row-menu-slot" data-track-menu-owner={i}>
                  <button
                    data-press-late
                    class="track-row-action"
                    class:is-open={activeTrackMenu?.row === i && activeTrackMenu?.kind === 'info'}
                    aria-label="Информация"
                    aria-haspopup="dialog"
                    aria-expanded={activeTrackMenu?.row === i && activeTrackMenu?.kind === 'info'}
                    on:click={(event) => toggleInfoMenu(event, i)}
                  >
                    <Info size={18} />
                  </button>
                </div>

                <span class="track-row-menu-slot" data-track-menu-owner={i}>
                  <PlaylistMenu
                    {track}
                    placement={i >= visibleLiked.length - 2 ? 'top' : 'bottom'}
                    align="right"
                    buttonClass="track-row-action"
                    open={activeTrackMenu?.row === i && activeTrackMenu?.kind === 'playlist'}
                    on:toggle={(event) => handlePlaylistMenuToggle(i, event)}
                  />
                </span>

                <button
                  class="track-row-action is-danger is-liked"
                  on:click|stopPropagation={(e) => removeLikedTrack(e, track)}
                  aria-label="Убрать из любимых"
                >
                  <Heart size={18} fill="currentColor" />
                </button>
              </div>

              <!-- Панель принадлежит строке, а не узкому слоту иконки. Иначе абсолютный
                   слой оказывался в локальном контексте кнопки: состояние открывалось,
                   но сама панель могла остаться под соседними строками. -->
              {#if activeTrackMenu?.row === i && activeTrackMenu?.kind === 'info'}
                <div class="track-row-info-pop {i >= visibleLiked.length - 2 ? 'is-top' : 'is-bottom'}" role="dialog" aria-label="Информация о треке" tabindex="-1" on:click|stopPropagation>
                  <div class="track-row-popover">
                    <p class="mb-1"><strong class="text-white">Автор:</strong> {track.artist}</p>
                    {#if track.playbackCount != null}
                      <p class="mb-1"><strong class="text-white">Прослушиваний SC:</strong> {track.playbackCount.toLocaleString('ru-RU')}</p>
                    {/if}
                    {#if track.releaseDate}
                      <p class="mb-1"><strong class="text-white">Выпущен:</strong> {new Date(track.releaseDate).toLocaleDateString('ru-RU')}</p>
                    {/if}
                    {#if track.genre}
                      <p><strong class="text-white">Жанр:</strong> {track.genre}</p>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
        {:else}
          <!-- Плитка сохраняет все действия строки, но переносит их на саму обложку. Меню
               информации и плейлистов по-прежнему делят одно состояние, поэтому слои не
               могут открыться одновременно и соседние карточки не накрывают их кнопками. -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="library-track-grid"
            class:has-open-track-menu={activeTrackMenu !== null}
          >
            {#each visibleLiked as track, i}
              {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
              {@const cached = isTrackCached(track, cachedUrns)}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div
                data-track-menu-owner={i}
                class="track-tile library-track-tile group interactive-item {isActive ? 'is-active' : ''} {track.isBanned ? 'is-banned' : ''}"
                class:has-open-menu={activeTrackMenu?.row === i}
                on:click={() => playTrackList(track, $likedTracks)}
              >
                <div class="tile-art" class:is-active={isActive}>
                  <div class="library-tile-art-clip spec-art">
                    {#if track.coverUrl}
                      <img src={coverUrlForTrack(track, $downloadedCoverCache)} alt="" class="tile-cover-image" loading="lazy" decoding="async" />
                    {:else}
                      <div class="library-tile-art-empty"><Music size={34} /></div>
                    {/if}

                    <div class="tile-cover-overlay">
                      <button
                        type="button"
                        class="tile-play-button {track.isBanned ? 'is-muted' : ''}"
                        aria-label={isActive && $isPlaying ? `Поставить «${track.title}» на паузу` : `Воспроизвести «${track.title}»`}
                        on:click={(e) => toggleTrackPlayback(e, track, $likedTracks)}
                      >
                        {#if isActive}
                          <MorphIcon
                            icon={$isPlaying ? PauseIcon : PlayIcon}
                            size={20}
                            strokeWidth={2.3}
                            fill="currentColor"
                            class="play-pause-morph"
                            spring="snappy"
                            reducedMotion="user"
                          />
                        {:else}
                          <Play fill="currentColor" size={20} />
                        {/if}
                      </button>
                    </div>
                  </div>

                  {#if cached}
                    <span class="library-tile-cached" title="Скачан" aria-label="Скачан">
                      <Check size={13} />
                    </span>
                  {/if}

                  <div class="library-tile-actions">
                    {#if !cached}
                      <button
                        type="button"
                        class="library-tile-action"
                        aria-label="Скачать"
                        title="Скачать"
                        on:click|stopPropagation={(e) => downloadTrack(e, track)}
                      >
                        <Download size={16} />
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="library-tile-action is-saved cache-state-control"
                        class:is-busy={isRemovingCachedTrack(track)}
                        aria-label={`Удалить скачанный файл «${track.title}»`}
                        title="Удалить скачанный файл"
                        disabled={isRemovingCachedTrack(track)}
                        on:click|stopPropagation={(e) => removeDownloadedTrack(e, track)}
                      >
                        {#if isRemovingCachedTrack(track)}
                          <Loader2 size={15} class="animate-spin" />
                        {:else}
                          <span class="cache-state-saved"><Check size={16} /></span>
                          <span class="cache-state-remove"><Trash2 size={15} /></span>
                        {/if}
                      </button>
                    {/if}

                    <button
                      type="button"
                      data-press-late
                      class="library-tile-action"
                      class:is-open={activeTrackMenu?.row === i && activeTrackMenu?.kind === 'info'}
                      aria-label="Информация"
                      aria-haspopup="dialog"
                      aria-expanded={activeTrackMenu?.row === i && activeTrackMenu?.kind === 'info'}
                      on:click={(event) => toggleInfoMenu(event, i)}
                    >
                      <Info size={16} />
                    </button>

                    <PlaylistMenu
                      {track}
                      placement={i >= visibleLiked.length - 5 ? 'top' : 'bottom'}
                      align="right"
                      iconSize={16}
                      buttonClass="library-tile-action"
                      open={activeTrackMenu?.row === i && activeTrackMenu?.kind === 'playlist'}
                      on:toggle={(event) => handlePlaylistMenuToggle(i, event)}
                    />

                    <button
                      type="button"
                      class="library-tile-action is-liked"
                      aria-label="Убрать из любимых"
                      title="Убрать из любимых"
                      on:click|stopPropagation={(e) => removeLikedTrack(e, track)}
                    >
                      <Heart size={16} fill="currentColor" />
                    </button>
                  </div>
                </div>

                <div class="tile-meta library-tile-meta">
                  <h3 class="tile-title" class:is-active={isActive} title={track.title}>{track.title}</h3>
                  <div class="library-tile-caption">
                    <span class="tile-sub"><ArtistTag artist={track.artist} artists={track.artists} /></span>
                    <span class="library-tile-source" class:is-yandex={track.source === 'yandex'}>
                      {track.source === 'yandex' ? 'Я.Музыка' : 'SoundCloud'}
                    </span>
                  </div>
                </div>

                {#if activeTrackMenu?.row === i && activeTrackMenu?.kind === 'info'}
                  <div class="track-row-info-pop {i >= visibleLiked.length - 5 ? 'is-top' : 'is-bottom'}" role="dialog" aria-label="Информация о треке" tabindex="-1" on:click|stopPropagation>
                    <div class="track-row-popover">
                      <p class="mb-1"><strong class="text-white">Автор:</strong> {track.artist}</p>
                      {#if track.playbackCount != null}
                        <p class="mb-1"><strong class="text-white">Прослушиваний SC:</strong> {track.playbackCount.toLocaleString('ru-RU')}</p>
                      {/if}
                      {#if track.releaseDate}
                        <p class="mb-1"><strong class="text-white">Выпущен:</strong> {new Date(track.releaseDate).toLocaleDateString('ru-RU')}</p>
                      {/if}
                      {#if track.genre}
                        <p><strong class="text-white">Жанр:</strong> {track.genre}</p>
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/if}
      
    {:else if activeTab === 'artists'}
      <section class="library-showcase" aria-labelledby="library-artists-title">
        <div class="library-showcase-head">
          <div class="library-showcase-copy">
            <span class="library-showcase-kicker"><User size={14} aria-hidden="true" /> По любимым трекам</span>
            <h2 id="library-artists-title" class="library-showcase-title">Твои артисты</h2>
            <p>Собрали исполнителей, к которым ты возвращаешься чаще всего.</p>
          </div>
          <span class="library-showcase-count tnum">{withCount(groupedArtists.length, 'артист', 'артиста', 'артистов')}</span>
        </div>

        {#if groupedArtists.length === 0}
          <div class="library-showcase-empty">
            <span class="library-showcase-empty-icon"><User size={25} aria-hidden="true" /></span>
            <div>
              <p class="display-title">Артисты соберутся сами</p>
              <p class="empty-hint">Добавь несколько треков в любимые — исполнители появятся здесь автоматически.</p>
            </div>
          </div>
        {:else}
          <div class="library-artist-grid">
            {#each visibleArtists as artist, index}
              <button
                type="button"
                class="library-artist-card"
                on:click={() => goToArtist(artist.name)}
                aria-label={`Открыть артиста ${artist.name}`}
              >
                <span class="library-artist-rank tnum" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span class="library-artist-art">
                  {#if artist.avatarUrl}
                    <img src={artist.avatarUrl} alt="" loading="lazy" decoding="async" />
                  {:else}
                    <User size={25} aria-hidden="true" />
                  {/if}
                </span>
                <span class="library-artist-info">
                  <strong>{artist.name}</strong>
                  <span>{withCount(artist.count, 'любимый трек', 'любимых трека', 'любимых треков')}</span>
                </span>
                <span class="library-card-open" aria-hidden="true"><ExternalLink size={15} /></span>
              </button>
            {/each}
          </div>
        {/if}
      </section>

    {:else if activeTab === 'playlists'}
      {#if openedPlaylist}
        {@const hasTracks = Boolean(openedPlaylist.tracks?.length)}
        <section class="library-playlist-detail" aria-labelledby="library-playlist-detail-title">
          <button type="button" class="library-playlist-back" on:click={closePlaylistDetail}>
            <ArrowLeft size={16} aria-hidden="true" />
            Все плейлисты
          </button>

          <div class="library-playlist-detail-hero">
            <div class="library-playlist-detail-cover" aria-hidden="true">
              {#if hasTracks && openedPlaylist.tracks[0].coverUrl}
                <img src={coverUrlForTrack(openedPlaylist.tracks[0], $downloadedCoverCache)} alt="" decoding="async" />
              {:else}
                <ListMusic size={46} />
              {/if}
            </div>

            <div class="library-playlist-detail-copy">
              <span class="library-showcase-kicker"><ListMusic size={14} aria-hidden="true" /> Плейлист</span>
              <h2 id="library-playlist-detail-title">{openedPlaylist.title}</h2>
              <p>{withCount(openedPlaylist.tracks?.length || 0, 'трек', 'трека', 'треков')} · твоя подборка</p>

              <div class="library-playlist-detail-actions">
                <button
                  type="button"
                  class="is-primary"
                  disabled={!hasTracks}
                  on:click={() => {
                    if (hasTracks) {
                      queue.set(openedPlaylist.tracks.slice(1));
                      currentTrack.set(openedPlaylist.tracks[0]);
                      isPlaying.set(true);
                    }
                  }}
                >
                  <Play fill="currentColor" size={16} aria-hidden="true" />
                  Слушать
                </button>
                <button type="button" disabled={!hasTracks} on:click={(event) => startPlaylistPreview(event, openedPlaylist)}>
                  <Radio size={16} aria-hidden="true" />
                  Превью
                </button>
                <button
                  type="button"
                  class:is-danger={isDownloadingAll}
                  disabled={isAllPlaylistCached(openedPlaylist.tracks) && !isDownloadingAll}
                  on:click={() => {
                    if (isDownloadingAll) {
                      cancelDownloadAll = true;
                    } else {
                      downloadAllTracks(openedPlaylist.tracks || []);
                    }
                  }}
                >
                  {#if isDownloadingAll}
                    <Loader2 size={16} class="animate-spin" aria-hidden="true" />
                    Отменить
                  {:else if isAllPlaylistCached(openedPlaylist.tracks)}
                    <Check size={16} aria-hidden="true" />
                    Скачано
                  {:else}
                    <Download size={16} aria-hidden="true" />
                    Скачать
                  {/if}
                </button>
              </div>
            </div>
          </div>

          <div class="library-playlist-detail-section-head">
            <div>
              <span>Содержание</span>
              <h3>Треки</h3>
            </div>
            <span class="tnum">{openedPlaylist.tracks?.length || 0}</span>
          </div>

          {#if !hasTracks}
            <div class="library-playlist-detail-empty">
              <span><Music size={24} aria-hidden="true" /></span>
              <strong>Здесь пока пусто</strong>
              <p>Добавь музыку из любимых — меню трека уже умеет отправлять её в плейлист.</p>
              <button type="button" on:click={() => setTab('liked')}>Перейти в любимые</button>
            </div>
          {:else}
            <div class="library-playlist-track-list">
              {#each openedPlaylist.tracks as track, i}
                {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <div
                  class="library-playlist-track group/track"
                  class:is-active={isActive}
                  on:click={() => playTrackList(track, openedPlaylist.tracks)}
                >
                  <TrackStatus index={i} {isActive} playing={$isPlaying} />
                  <div class="library-playlist-track-cover">
                    {#if track.coverUrl}
                      <img src={coverUrlForTrack(track, $downloadedCoverCache)} alt="" loading="lazy" decoding="async" />
                    {:else}
                      <Music size={19} aria-hidden="true" />
                    {/if}
                  </div>
                  <div class="library-playlist-track-copy">
                    <strong>
                      {track.title}
                      {#if isTrackCached(track, cachedUrns)}
                        <Check size={13} class="library-playlist-track-cached" aria-label="Скачано" />
                      {/if}
                    </strong>
                    <span><ArtistTag artist={track.artist} artists={track.artists} /></span>
                  </div>
                  <div class="library-playlist-track-actions">
                    {#if isTrackCached(track, cachedUrns)}
                      <button
                        type="button"
                        class="cache-state-control"
                        class:is-busy={isRemovingCachedTrack(track)}
                        data-press-late
                        on:click|stopPropagation={(event) => removeDownloadedTrack(event, track)}
                        aria-label={`Удалить скачанный файл «${track.title}»`}
                        title="Удалить скачанный файл"
                        disabled={isRemovingCachedTrack(track)}
                      >
                        {#if isRemovingCachedTrack(track)}
                          <Loader2 size={16} class="animate-spin" />
                        {:else}
                          <Download size={16} />
                        {/if}
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="is-danger"
                      data-press-late
                      on:click|stopPropagation={(event) => removeFromPlaylist(event, track, openedPlaylist.id)}
                      aria-label={`Убрать «${track.title}» из плейлиста`}
                      title="Убрать из плейлиста"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else}
        <section class="library-showcase" aria-labelledby="library-playlists-title">
          <div class="library-showcase-head">
            <div class="library-showcase-copy">
              <span class="library-showcase-kicker"><ListMusic size={14} aria-hidden="true" /> Свои подборки</span>
              <h2 id="library-playlists-title" class="library-showcase-title">Плейлисты</h2>
              <p>Собирай музыку по настроению и запускай нужную подборку одним нажатием.</p>
            </div>
            <span class="library-showcase-count tnum">{withCount($playlists.length, 'плейлист', 'плейлиста', 'плейлистов')}</span>
          </div>

          <div class="library-playlist-grid">
            <button
              type="button"
              class="library-playlist-create"
              bind:this={createPlaylistTrigger}
              on:click={openCreatePlaylistDialog}
            >
              <span class="library-playlist-create-icon"><Plus size={25} aria-hidden="true" /></span>
              <span>
                <strong>Новый плейлист</strong>
                <small>Собрать свою подборку</small>
              </span>
            </button>

            {#each $playlists as pl}
              {@const hasTracks = Boolean(pl.tracks?.length)}
              <article class="library-playlist-card">
                <div class="library-playlist-art-shell">
                  <button
                    type="button"
                    class="library-playlist-open"
                    data-playlist-id={pl.id}
                    aria-label={`Открыть плейлист ${pl.title}`}
                    on:click={() => openPlaylistDetail(pl.id)}
                  >
                    <span class="library-playlist-art">
                      {#if hasTracks && pl.tracks[0].coverUrl}
                        <img src={coverUrlForTrack(pl.tracks[0], $downloadedCoverCache)} alt="" loading="lazy" decoding="async" />
                      {:else}
                        <ListMusic size={36} aria-hidden="true" />
                      {/if}
                      <span class="library-playlist-art-shade" aria-hidden="true"></span>
                      <span class="library-playlist-open-hint" aria-hidden="true">Открыть</span>
                    </span>
                  </button>

                  <div class="library-playlist-actions">
                    <button
                      type="button"
                      on:click={(event) => startPlaylistPreview(event, pl)}
                      aria-label={`Запустить превью плейлиста ${pl.title}`}
                      title="Превью"
                      disabled={!hasTracks}
                    >
                      <Radio size={17} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="is-primary"
                      on:click={() => {
                        if (hasTracks) {
                          queue.set(pl.tracks.slice(1));
                          currentTrack.set(pl.tracks[0]);
                          isPlaying.set(true);
                        }
                      }}
                      aria-label={`Включить плейлист ${pl.title}`}
                      title="Слушать"
                      disabled={!hasTracks}
                    >
                      <Play fill="currentColor" size={17} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="is-danger"
                      data-press-late
                      on:click={(event) => deletePlaylist(event, pl.id)}
                      aria-label={`Удалить плейлист ${pl.title}`}
                      title="Удалить"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div class="library-playlist-meta">
                  <strong title={pl.title}>{pl.title}</strong>
                  <span>{withCount(pl.tracks?.length || 0, 'трек', 'трека', 'треков')}</span>
                </div>
              </article>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
    </div>
  {/key}
</div>

{#if activePreviewPlaylist}
  <PlaylistTrailer playlist={activePreviewPlaylist} onClose={() => activePreviewPlaylist = null} />
{/if}

{#if showCreatePlaylistModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="playlist-create-backdrop" on:pointerdown|self={() => closeCreatePlaylistDialog()}>
    <div
      class="playlist-create-dialog"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="playlist-create-title"
      aria-describedby="playlist-create-help"
      on:click|stopPropagation
    >
      <button
        type="button"
        class="playlist-create-close"
        aria-label="Закрыть создание плейлиста"
        on:click={() => closeCreatePlaylistDialog()}
      >
        <X size={18} aria-hidden="true" />
      </button>

      <span class="playlist-create-mark"><ListMusic size={24} aria-hidden="true" /></span>
      <span class="playlist-create-kicker">Новая подборка</span>
      <h2 id="playlist-create-title">Как назовём плейлист?</h2>
      <p id="playlist-create-help">Название можно будет изменить позже.</p>

      <label for="playlist-create-name">Название</label>
      <div class="playlist-create-field">
        <Music size={17} aria-hidden="true" />
        <!-- svelte-ignore a11y-autofocus -->
        <input
          id="playlist-create-name"
          type="text"
          bind:value={newPlaylistName}
          placeholder="Например, Ночной город"
          maxlength="80"
          autocomplete="off"
          on:keydown={(event) => event.key === 'Enter' && handleCreatePlaylistSubmit()}
          autofocus
        />
        <span class="tnum">{newPlaylistName.trim().length}/80</span>
      </div>

      <div class="playlist-create-actions">
        <button type="button" class="is-secondary" on:click={() => closeCreatePlaylistDialog()}>Отмена</button>
        <button type="button" class="is-primary" on:click={handleCreatePlaylistSubmit} disabled={!newPlaylistName.trim()}>
          <Plus size={17} aria-hidden="true" />
          Создать
        </button>
      </div>
    </div>
  </div>
{/if}
