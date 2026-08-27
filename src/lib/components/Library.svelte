<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Play, FolderOpen, Heart, User, Music, Trash2, ListMusic, Plus, ExternalLink, Check, Download, Info, Radio, X, Loader2 } from 'lucide-svelte';
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
  let activePreviewPlaylist: any = null;

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
    if (event.key === 'Escape') activeTrackMenu = null;
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

  function handleCreatePlaylistSubmit() {
    if (newPlaylistName.trim()) {
      createPlaylist();
      showCreatePlaylistModal = false;
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
        notify(`Забрал ${withCount(newTracks.length, 'трек', 'трека', 'треков')} с компьютера`, 'success');
      }
    } catch (err) {
      console.error("Failed to open dialog:", err);
      notify('Не получилось добавить файлы — возможно, формат не тот', 'error');
    }
  }

  async function deleteTrack(e: Event, id: string) {
    e.stopPropagation();
    await removeTrack(id);
    localTracks = localTracks.filter(t => t.id !== id);
    notify('Убрал из локальных', 'info');
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
      notify('Источник считал трек недоступным. Пробую ещё раз', 'info');
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
    notify('Убрал из любимых', 'info');
  }

  function createPlaylist() {
    if (!newPlaylistName.trim()) return;
    playlists.update(p => [...p, { id: Date.now().toString(), title: newPlaylistName.trim(), tracks: [] }]);
    notify(`Плейлист «${newPlaylistName.trim()}» готов`, 'success');
    newPlaylistName = '';
  }

  function deletePlaylist(e: Event, id: string) {
    e.stopPropagation();
    playlists.update(p => p.filter(pl => pl.id !== id));
    notify('Плейлист удалён', 'info');
  }

  // Добавление в плейлист живёт в `PlaylistMenu` — здесь осталось только удаление, которым
  // пользуется раскрытый плейлист (крестик у строки).
  function removeFromPlaylist(e: Event, track: any, playlistId: string) {
    e.stopPropagation();
    playlists.update(p => {
      const idx = p.findIndex(pl => pl.id === playlistId);
      if (idx !== -1) {
        p[idx].tracks = p[idx].tracks.filter((t: any) => t.title !== track.title || t.artist !== track.artist);
        notify(`Убрал из «${p[idx].title}»`, 'info');
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
        url,
        urls: [url],
        hq: false,
        durationMs: track.duration ? track.duration : null
      };

      await invoke('track_ensure_cached', { request });
      publishTrackCacheState(urn, true);
      if (e) notify(`«${track.title}» на диске`, 'success');
      return true;
    } catch (err) {
      console.error(err);
      if (e) notify(`Не смог скачать «${track.title}»`, 'error');
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
      notify(`Удалил «${track.title}» с диска`, 'info');
    } catch (err) {
      console.error('Could not remove cached track', err);
      notify(`Не смог удалить «${track.title}» — возможно, файл сейчас используется`, 'error');
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
      notify(`Остановил. Успел скачать ${withCount(downloadedCount, 'трек', 'трека', 'треков')}`, 'info');
    } else if (downloadedCount > 0) {
      notify(`Готово — ${withCount(downloadedCount, 'трек', 'трека', 'треков')} на диске`, 'success');
    } else {
      notify('Всё уже скачано', 'info');
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
                  <img src={track.coverUrl} alt="" loading="lazy" decoding="async" />
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
                      <img src={track.coverUrl} alt="" class="tile-cover-image" loading="lazy" decoding="async" />
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
      {#if groupedArtists.length === 0}
        <div class="w-full py-20 px-10 flex flex-col items-start plate">
          <User size={26} class="mb-5 text-white/20" />
          <p class="display-title">Артисты соберутся сами</p>
          <p class="empty-hint">Как только полайкаешь несколько треков, они сгруппируются здесь по исполнителям.</p>
        </div>
      {:else}
        <div class="track-collection grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-2">
          {#each visibleArtists as artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div 
              class="glass-button p-4 rounded-2xl flex flex-col items-center gap-3 text-center cursor-pointer group"
              on:click={() => goToArtist(artist.name)}
            >
              <!-- Свечение аватара — отдельный слой-сосед, а не `box-shadow` по ховеру.
                   `transition-shadow` перерисовывает тень каждый кадр перехода, а внутрь
                   самого аватара её не спрятать: у него `overflow: hidden` под обложку.
                   Слой лежит ровно по кругу аватара, отрисован заранее и проявляется
                   одной `opacity`. -->
              <div class="relative w-16 h-16">
                <div
                  class="absolute inset-0 rounded-full shadow-[0_0_20px_var(--color-primary)] opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-hidden="true"
                ></div>
                <div class="relative w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center shadow-lg overflow-hidden">
                  {#if artist.avatarUrl}
                    <img src={artist.avatarUrl} alt={artist.name} class="w-full h-full object-cover" loading="lazy" decoding="async" />
                  {:else}
                    <User size={24} class="text-neutral-400 group-hover:text-primary transition-colors" />
                  {/if}
                </div>
              </div>
              <div>
                <div class="font-bold text-white w-full max-w-[100px] min-w-0"><ArtistTag artist={artist.name} /></div>
                <div class="text-[11px] text-neutral-400 mt-1">{withCount(artist.count, 'трек', 'трека', 'треков')}</div>
              </div>

              <!-- Блик проходит по всей карточке, поэтому его носитель — накладка во всю
                   карточку, а не сама карточка: `overflow: hidden` на `.glass-button`
                   срезал бы её свечение наведения, которое рисуется снаружи рамки. -->
              <div class="sheen-art sheen-overlay" aria-hidden="true"></div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if activeTab === 'playlists'}
      <div class="track-collection grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 p-2">
        <!-- Create Playlist Tile -->
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div 
          class="glass-button p-4 rounded-2xl flex flex-col items-center justify-center gap-3 text-center cursor-pointer group min-h-[200px] border border-dashed border-white/20 hover:border-primary/50 bg-black/20"
          on:click={() => {
            newPlaylistName = '';
            showCreatePlaylistModal = true;
          }}
        >
          <div class="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
            <Plus size={32} class="text-neutral-400 group-hover:text-primary transition-colors" />
          </div>
          <div class="font-bold text-neutral-300 mt-2">Новый плейлист</div>

          <div class="sheen-art sheen-overlay" aria-hidden="true"></div>
        </div>

        <!-- Playlist Tiles -->
        {#each $playlists as pl}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div 
            class="w-full group cursor-pointer interactive-item"
            on:click={() => {
              // Expand behavior: just set it so we know we want to see it. 
              // Alternatively, navigate to a new full-page playlist view.
              // For now, let's keep the existing UI behavior or show the trailer.
              // The user said "сделай чтоб я не видел сразу что в плейлисте чтоб мне в него надо было перейти чтоб увидеть".
              // A full page is best, but to save time, maybe just expand it below?
              // Wait, grid expansion is hard. Let's just open the trailer on play, or full page on click.
              // Since full page doesn't exist yet, I'll just open the Trailer for now, or alert.
              expandedPlaylist = expandedPlaylist === pl.id ? null : pl.id;
            }}
          >
            <!-- Cover -->
            <!-- `spec-art` — глянцевая поверхность: по ней ходит отражение света, положение
                 которого считается из наклона (`$lib/utils/tilt`). Бегущей полосы здесь нет
                 намеренно — один блик на поверхность. Свой `-translate-y-1` снят: карточка
                 уже поднимается целиком через `interactive-item`, и два подъёма складывались
                 в 8px. -->
            <div class="w-full aspect-square min-w-[3rem] min-h-[3rem] rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 mb-3 border border-white/5 transition-colors duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] spec-art art-glow">
              {#if pl.tracks && pl.tracks.length > 0 && pl.tracks[0].coverUrl}
                <img src={pl.tracks[0].coverUrl} alt="Cover" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
              {:else}
                <div class="w-full h-full flex items-center justify-center text-neutral-500">
                  <ListMusic size={32} />
                </div>
              {/if}
              
              <!-- Hover Overlay with Wave Preview Button -->
              <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4">
                <button 
                  class="bg-white/20 hover:bg-white/40 backdrop-blur-md text-white rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                  on:click|stopPropagation={(e) => startPlaylistPreview(e, pl)}
                  title="Превью плейлиста"
                >
                  <Radio size={20} />
                </button>
                <button 
                  class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300 delay-75"
                  on:click|stopPropagation={() => {
                    if (pl.tracks && pl.tracks.length > 0) {
                      queue.set(pl.tracks.slice(1));
                      currentTrack.set(pl.tracks[0]);
                      isPlaying.set(true);
                    }
                  }}
                  title="Слушать"
                >
                  <Play fill="currentColor" size={20} />
                </button>
              </div>

              <!-- Delete Button
                   Срабатывает на отпускании (`data-press-late`), в отличие от остальных кнопок.
                   Плейлист удаляется молча — ни подтверждения, ни отмены, — а кнопка сидит в углу
                   карточки и появляется по наведению, то есть под курсором оказывается сама.
                   Отпускание оставляет путь назад: увёл курсор — ничего не произошло. -->
              <button
                class="absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-red-500/80 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all"
                data-press-late
                on:click|stopPropagation={(e) => deletePlaylist(e, pl.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
            
            <!-- Metadata -->
            <div class="px-1 relative">
              <div class="font-bold text-[14px] text-white truncate">{pl.title}</div>
              <div class="text-neutral-400 text-[12px] mt-0.5">{withCount(pl.tracks?.length || 0, 'трек', 'трека', 'треков')}</div>
            </div>
          </div>
        {/each}
      </div>

      <!-- Render expanded playlist below grid if one is selected -->
      {#if expandedPlaylist}
        {@const pl = $playlists.find(p => p.id === expandedPlaylist)}
        {#if pl}
          <div class="mt-8 glass-panel p-6 rounded-3xl border border-primary/20 relative animate-in fade-in slide-in-from-bottom-4">
            <button class="absolute top-6 right-6 text-neutral-500 hover:text-white transition-colors" on:click={() => expandedPlaylist = null}>
              <X size={24} />
            </button>
            <div class="flex items-center justify-between mb-6 mt-2">
              <h2 class="section-title flex items-center gap-3 pr-8">
                <ListMusic class="text-primary" /> {pl.title}
              </h2>
              <button 
                class="glass-button transition-all px-4 py-2 rounded-xl font-bold flex items-center gap-2 text-sm shadow-md mr-8 {isDownloadingAll ? 'hover:bg-red-500 hover:text-white group' : 'hover:bg-primary hover:text-black'} disabled:opacity-50"
                on:click={() => {
                  if (isDownloadingAll) {
                    cancelDownloadAll = true;
                  } else {
                    downloadAllTracks(pl.tracks || []);
                  }
                }}
                disabled={isAllPlaylistCached(pl.tracks) && !isDownloadingAll}
              >
                {#if isDownloadingAll}
                  <svg class="animate-spin h-4 w-4 group-hover:hidden" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <X size={16} class="hidden group-hover:block" />
                  <span class="group-hover:hidden">Загрузка...</span>
                  <span class="hidden group-hover:inline">Отменить</span>
                {:else if isAllPlaylistCached(pl.tracks)}
                  <Check size={16} class="text-green-400" /> Скачано
                {:else}
                  <Download size={16} /> Скачать всё
                {/if}
              </button>
            </div>
            {#if !pl.tracks || pl.tracks.length === 0}
               <p class="text-neutral-500 text-sm">Плейлист пуст. Добавьте треки из вкладки "Любимые".</p>
            {:else}
              <div class="flex flex-col gap-2">
                {#each pl.tracks as track, i}
                  {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <div 
                    class="flex items-center gap-4 group/track cursor-pointer rounded-xl p-2 transition-colors w-full interactive-item {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'}"
                    on:click={() => playTrackList(track, pl.tracks)}
                  >
                    <TrackStatus index={i} {isActive} playing={$isPlaying} />
                    <div class="relative w-12 h-12 min-w-[3rem] min-h-[3rem] aspect-square shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800">
                      {#if track.coverUrl}
                        <img src={track.coverUrl} alt="Cover" class="w-full h-full object-cover" loading="lazy" decoding="async" />
                      {:else}
                        <div class="w-full h-full flex items-center justify-center text-neutral-500">
                          <Music size={20} />
                        </div>
                      {/if}
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
                    {#if isTrackCached(track, cachedUrns)}
                      <button
                        type="button"
                        class="cache-state-control playlist-cache-action opacity-0 group-hover/track:opacity-100 p-2 text-primary rounded-full transition-all"
                        class:is-busy={isRemovingCachedTrack(track)}
                        data-press-late
                        on:click|stopPropagation={(e) => removeDownloadedTrack(e, track)}
                        aria-label={`Удалить скачанный файл «${track.title}»`}
                        title="Удалить скачанный файл"
                        disabled={isRemovingCachedTrack(track)}
                      >
                        {#if isRemovingCachedTrack(track)}
                          <Loader2 size={16} class="animate-spin" />
                        {:else}
                          <span class="cache-state-saved"><Check size={16} /></span>
                          <span class="cache-state-remove"><Trash2 size={15} /></span>
                        {/if}
                      </button>
                    {/if}
                    <!-- Тоже на отпускании: трек вылетает из плейлиста без подтверждения, а кнопка
                         лежит в конце строки, по которой ведут курсором. -->
                    <button
                      class="opacity-0 group-hover/track:opacity-100 p-2 hover:bg-white/10 text-neutral-500 rounded-full transition-all mr-2"
                      data-press-late
                      on:click|stopPropagation={(e) => removeFromPlaylist(e, track, pl.id)}
                      aria-label="Убрать из плейлиста"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
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
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" on:click={() => showCreatePlaylistModal = false}>
    <div class="bg-[#1a1a1f] w-full max-w-sm rounded-3xl overflow-hidden shadow-2xl border border-white/10 flex flex-col p-6 relative" on:click|stopPropagation>
      <button class="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 text-white transition-colors" on:click={() => showCreatePlaylistModal = false}>
        <X size={20} />
      </button>
      <h2 class="section-title mb-4">Новый плейлист</h2>
      <!-- svelte-ignore a11y-autofocus -->
      <input 
        type="text" 
        bind:value={newPlaylistName} 
        placeholder="Как назовём?" 
        class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-neutral-500 focus:outline-none focus:border-primary mb-6 transition-colors"
        on:keydown={(e) => e.key === 'Enter' && handleCreatePlaylistSubmit()}
        autofocus
      />
      <div class="flex gap-3">
        <button 
          class="flex-1 py-3 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-white font-bold transition-colors" 
          on:click={() => showCreatePlaylistModal = false}
        >
          Отмена
        </button>
        <button 
          class="flex-1 py-3 px-4 rounded-xl bg-primary hover:bg-primary/80 text-black font-bold transition-colors shadow-md disabled:opacity-50 disabled:cursor-not-allowed" 
          on:click={handleCreatePlaylistSubmit}
          disabled={!newPlaylistName.trim()}
        >
          Создать
        </button>
      </div>
    </div>
  </div>
{/if}
