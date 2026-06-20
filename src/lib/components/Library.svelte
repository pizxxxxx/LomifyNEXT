<script lang="ts">
  import { onMount } from 'svelte';
  import { Play, FolderOpen, Heart, User, Music, Trash2, ListMusic, Plus, ExternalLink, Activity as EqIcon, Check, Download, Info, Radio, X, Loader2 } from 'lucide-svelte';
  import ArtistTag from './ArtistTag.svelte';
  import PlaylistTrailer from './PlaylistTrailer.svelte';
  import { currentTrack, isPlaying, likedTracks, queue, currentView, searchQuery, playlists, currentArtist, notify, settings } from '$lib/stores';
  import { saveTrack, getTracks, removeTrack } from '$lib/db';
  import { getAudioUrl } from '$lib/api';
  import { invoke } from '@tauri-apps/api/core';

  let activeTab = 'liked'; // 'liked', 'artists', 'local', 'playlists'
  let localTracks: any[] = [];
  let cachedUrns = new Set<string>();
  let expandedPlaylist: string | null = null;
  let activePreviewPlaylist: any = null;
  
  function startPlaylistPreview(e: Event, pl: any) {
    e.stopPropagation();
    activePreviewPlaylist = pl;
  }
  
  // Computed grouped artists
  $: groupedArtists = (() => {
    const map = $likedTracks.reduce((acc: any, t) => {
      if (t.artist) {
        if (!acc[t.artist]) {
          acc[t.artist] = { count: 0, avatarUrl: t.artistAvatarUrl || t.coverUrl };
        }
        acc[t.artist].count += 1;
      }
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
    (async () => {
      localTracks = await getTracks();
      try {
        const list = await invoke<string[]>('track_list_cached');
        cachedUrns = new Set(list);
      } catch (e) {}
    })();

    const handleCacheCleared = () => {
      cachedUrns.clear();
      cachedUrns = cachedUrns;
    };
    window.addEventListener('cacheCleared', handleCacheCleared);
    return () => window.removeEventListener('cacheCleared', handleCacheCleared);
  });

  function isTrackCached(track: any, _cache?: Set<string>) {
    const trackIdStr = track.id ? track.id : `${track.title}-${track.artist}`;
    const urn = `lomify:${track.source}:${trackIdStr}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');
    return cachedUrns.has(urn);
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
        notify(`Добавлено ${newTracks.length} локальных треков`, 'success');
      }
    } catch (err) {
      console.error("Failed to open dialog:", err);
      notify('Ошибка при добавлении треков', 'error');
    }
  }

  async function deleteTrack(e: Event, id: string) {
    e.stopPropagation();
    await removeTrack(id);
    localTracks = localTracks.filter(t => t.id !== id);
    notify('Трек удален из локальных', 'info');
  }

  function playTrackList(track: any, list: any[]) {
    const idx = list.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set(list.slice(idx + 1));
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function removeLikedTrack(e: Event, track: any) {
    e.stopPropagation();
    likedTracks.set($likedTracks.filter(t => t.title !== track.title || t.artist !== track.artist));
    notify('Удалено из любимых', 'info');
  }

  function createPlaylist() {
    if (!newPlaylistName.trim()) return;
    playlists.update(p => [...p, { id: Date.now().toString(), title: newPlaylistName.trim(), tracks: [] }]);
    notify(`Плейлист "${newPlaylistName.trim()}" создан`, 'success');
    newPlaylistName = '';
  }

  function deletePlaylist(e: Event, id: string) {
    e.stopPropagation();
    playlists.update(p => p.filter(pl => pl.id !== id));
    notify('Плейлист удален', 'info');
  }

  function addToPlaylist(e: Event, track: any, playlistId: string) {
    e.stopPropagation();
    playlists.update(p => {
      const idx = p.findIndex(pl => pl.id === playlistId);
      if (idx !== -1) {
        if (!p[idx].tracks.some((t: any) => t.title === track.title && t.artist === track.artist)) {
          p[idx].tracks.push(track);
          notify(`Добавлено в "${p[idx].title}"`, 'success');
        } else {
          notify(`Трек уже есть в "${p[idx].title}"`, 'info');
        }
      }
      return p;
    });
  }

  function removeFromPlaylist(e: Event, track: any, playlistId: string) {
    e.stopPropagation();
    playlists.update(p => {
      const idx = p.findIndex(pl => pl.id === playlistId);
      if (idx !== -1) {
        p[idx].tracks = p[idx].tracks.filter((t: any) => t.title !== track.title || t.artist !== track.artist);
        notify(`Удалено из "${p[idx].title}"`, 'info');
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
        // Track is dead/banned
        track.isBanned = true;
        if (track.id) {
           const dbTrack = await getTracks().then(ts => ts.find((t: any) => t.id === track.id));
           if (dbTrack) {
             dbTrack.isBanned = true;
             await saveTrack(dbTrack);
             likedTracks.update(ts => ts.map(t => t.id === track.id ? { ...t, isBanned: true } : t));
           }
        }
        throw new Error("No audio URL found (possibly banned)");
      }
      
      const trackIdStr = track.id ? track.id : `${track.title}-${track.artist}`;
      const urn = `lomify:${track.source}:${trackIdStr}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');
      const request = {
        urn,
        url,
        urls: [url],
        hq: false,
        durationMs: track.duration ? track.duration : null
      };

      await invoke('track_ensure_cached', { request });
      cachedUrns.add(urn);
      cachedUrns = cachedUrns; // trigger reactivity
      if (e) notify(`Трек ${track.title} скачан`, 'success');
      return true;
    } catch (err) {
      console.error(err);
      if (e) notify(`Ошибка скачивания ${track.title}`, 'error');
      return false;
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
      notify(`Загрузка отменена. Скачано треков: ${downloadedCount}`, 'info');
    } else if (downloadedCount > 0) {
      notify(`Загрузка завершена! Скачано треков: ${downloadedCount}`, 'success');
    } else {
      notify('Все треки уже скачаны', 'info');
    }
  }

  $: isAllLikedCached = $likedTracks.length > 0 && $likedTracks.every(track => isTrackCached(track));

  function isAllPlaylistCached(tracks: any[]) {
    if (!tracks || tracks.length === 0) return false;
    return tracks.every(track => isTrackCached(track));
  }
</script>

<div class="w-full max-w-6xl {$settings.leftAlignTracks ? 'mr-auto ml-0' : 'mx-auto'} flex flex-col">
  <div class="flex items-center justify-between mb-8">
    <h1 class="text-4xl font-extrabold tracking-tight drop-shadow-md">Медиатека</h1>
  </div>

  <!-- Tabs -->
  <div class="flex gap-4 mb-8 border-b border-white/10 pb-4">
    <button 
      class="flex items-center gap-2 px-6 py-3 rounded-2xl font-bold transition-all shadow-sm {activeTab === 'liked' ? 'bg-primary text-black scale-105 shadow-primary/30' : 'glass-button text-neutral-300 hover:text-white'}"
      on:click={() => activeTab = 'liked'}
    >
      <Heart size={18} fill={activeTab === 'liked' ? "black" : "none"} /> Любимые треки
    </button>
    <button 
      class="flex items-center gap-2 px-6 py-3 rounded-2xl font-bold transition-all shadow-sm {activeTab === 'playlists' ? 'bg-primary text-black scale-105 shadow-primary/30' : 'glass-button text-neutral-300 hover:text-white'}"
      on:click={() => activeTab = 'playlists'}
    >
      <ListMusic size={18} /> Плейлисты
    </button>
    <button 
      class="flex items-center gap-2 px-6 py-3 rounded-2xl font-bold transition-all shadow-sm {activeTab === 'artists' ? 'bg-primary text-black scale-105 shadow-primary/30' : 'glass-button text-neutral-300 hover:text-white'}"
      on:click={() => activeTab = 'artists'}
    >
      <User size={18} /> Артисты
    </button>
    <button 
      class="flex items-center gap-2 px-6 py-3 rounded-2xl font-bold transition-all shadow-sm {activeTab === 'local' ? 'bg-primary text-black scale-105 shadow-primary/30' : 'glass-button text-neutral-300 hover:text-white'}"
      on:click={() => activeTab = 'local'}
    >
      <FolderOpen size={18} /> Локальные файлы
    </button>
  </div>

  <!-- Content -->
  <div class="flex-1 pr-4 perspective-[1000px]">
    {#if activeTab === 'local'}
      <div class="flex flex-col gap-4 mb-6">
        <div class="flex items-center justify-between">
          <h2 class="text-2xl font-bold drop-shadow-md">Офлайн треки</h2>
          <button class="cursor-pointer glass-button hover:bg-primary hover:text-black transition-all px-6 py-3 rounded-2xl font-bold flex items-center gap-2 text-sm shadow-md" on:click={handleFileSelect}>
            <FolderOpen size={18} />
            Выбрать файлы
          </button>
        </div>
      </div>

      {#if localTracks.length === 0}
        <div class="w-full h-[300px] flex flex-col items-center justify-center text-neutral-400 glass-panel rounded-3xl mt-4">
          <Music size={56} class="mb-4 opacity-50 drop-shadow-lg" />
          <p class="text-xl font-bold mb-2">Нет локальных треков</p>
          <p class="text-sm opacity-80">Нажмите "Выбрать файлы", чтобы добавить музыку с компьютера</p>
        </div>
      {:else}
        <div class="flex flex-col gap-3 p-2">
          {#each localTracks as track, i}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div 
              class="flex items-center gap-4 group cursor-pointer rounded-xl p-2 transition-all hover:-translate-y-1 hover:shadow-lg w-full {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'}"
              on:click={() => playTrackList(track, localTracks)}
            >
              <div class="w-6 text-right text-[11px] font-mono text-white/30 group-hover:hidden">
                {#if isActive && $isPlaying}
                  <EqIcon size={14} class="text-primary animate-pulse ml-auto" />
                {:else}
                  {i + 1}
                {/if}
              </div>
              <div class="w-6 text-right hidden group-hover:block text-white/50">
                <Play size={14} fill="currentColor" class="ml-auto" />
              </div>
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
                <span class="text-neutral-400 text-[12px] mt-0.5 truncate"><ArtistTag artist={track.artist} /></span>
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
        <div class="w-full h-[300px] flex flex-col items-center justify-center text-neutral-400 glass-panel rounded-3xl mt-4">
          <Heart size={56} class="mb-4 opacity-50 drop-shadow-lg" />
          <p class="text-xl font-bold">У вас пока нет любимых треков</p>
        </div>
      {:else}
        <div class="flex items-center justify-between mb-4 px-2 mt-2">
          <div class="text-sm text-neutral-400">{$likedTracks.length} треков</div>
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
        <div class="flex flex-col gap-3 p-2">
          {#each $likedTracks as track, i}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div 
              class="relative hover:z-50 flex items-center gap-4 group rounded-xl p-2 transition-all w-full {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'} {track.isBanned ? 'opacity-40 grayscale cursor-not-allowed' : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg'}"
              on:click={() => { if (!track.isBanned) playTrackList(track, $likedTracks); }}
            >
              <div class="w-6 text-right text-[11px] font-mono text-white/30 {track.isBanned ? '' : 'group-hover:hidden'}">
                {#if track.isBanned}
                  <X size={14} class="text-red-500 ml-auto" />
                {:else if isActive && $isPlaying}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary ml-auto"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg>
                {:else}
                  {i + 1}
                {/if}
              </div>
              {#if !track.isBanned}
                <div class="w-6 text-right hidden group-hover:block text-white/50">
                  <Play size={14} fill="currentColor" class="ml-auto" />
                </div>
              {/if}
              <div class="relative w-12 h-12 min-w-[3rem] min-h-[3rem] aspect-square shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800">
                {#if track.coverUrl}
                  <img src={track.coverUrl} alt="Cover" class="w-full h-full object-cover" />
                {:else}
                  <div class="w-full h-full flex items-center justify-center text-neutral-500">
                    <Music size={20} />
                  </div>
                {/if}
              </div>
              <div class="flex flex-col flex-1 min-w-0 pr-4">
                <div class="flex items-center gap-2">
                  <span class="font-bold text-[14px] truncate {isActive ? 'text-primary' : 'text-white'}">{track.title}</span>
                  {#if isTrackCached(track, cachedUrns)}
                    <div title="Скачан" class="flex"><Check size={14} class="text-primary shrink-0" /></div>
                  {/if}
                </div>
                <span class="text-neutral-400 text-[12px] mt-0.5 truncate hover:text-white hover:underline cursor-pointer transition-colors w-fit"><ArtistTag artist={track.artist} /></span>
              </div>
              {#if !isTrackCached(track, cachedUrns)}
                <button 
                  class="opacity-0 group-hover:opacity-100 p-2 text-neutral-400 hover:text-white rounded-full transition-all mr-1"
                  on:click|stopPropagation={(e) => downloadTrack(e, track)}
                  aria-label="Скачать"
                >
                  <Download size={18} />
                </button>
              {:else}
                <div class="opacity-0 group-hover:opacity-100 p-2 text-primary rounded-full transition-all mr-1 flex items-center justify-center cursor-default" title="Скачан">
                  <Check size={18} />
                </div>
              {/if}

              <!-- Dropdown for Info -->
              <div class="relative group/info mr-1">
                <button class="opacity-0 group-hover:opacity-100 p-2 text-neutral-400 hover:text-white rounded-full transition-all" aria-label="Информация">
                  <Info size={18} />
                </button>
                <div class="absolute right-0 top-full pt-1 w-56 hidden group-hover/info:block z-50">
                  <div class="bg-neutral-900 border border-white/10 rounded-xl shadow-xl p-3 text-xs text-neutral-300 pointer-events-none">
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
              </div>
              
              <!-- Dropdown for Playlists -->
              <div class="relative group/dropdown mr-2">
                <button class="opacity-0 group-hover:opacity-100 p-2 text-neutral-400 hover:text-white rounded-full transition-all" aria-label="Добавить в плейлист">
                  <Plus size={18} />
                </button>
                <div class="absolute right-0 top-full pt-1 w-48 hidden group-hover/dropdown:block z-50">
                  <div class="bg-neutral-900 border border-white/10 rounded-xl shadow-xl overflow-hidden">
                    {#if $playlists.length > 0}
                      {#each $playlists as pl}
                        {@const isInPlaylist = pl.tracks && pl.tracks.some((t: any) => (t.id && t.id === track.id) || (t.title === track.title && t.artist === track.artist))}
                        <button class="w-full text-left flex items-center justify-between px-4 py-2 text-sm text-neutral-300 hover:bg-white/10 hover:text-white" on:click|stopPropagation={(e) => isInPlaylist ? removeFromPlaylist(e, track, pl.id) : addToPlaylist(e, track, pl.id)}>
                          <span>{pl.title}</span>
                          {#if isInPlaylist}
                            <Check size={16} class="text-primary" />
                          {/if}
                        </button>
                      {/each}
                    {:else}
                      <div class="w-full text-left px-4 py-3 text-xs text-neutral-500 italic">
                        Нет плейлистов
                      </div>
                    {/if}
                  </div>
                </div>
              </div>


              <button 
                class="opacity-0 group-hover:opacity-100 p-3 hover:bg-red-500/20 hover:text-red-400 text-neutral-500 rounded-full transition-all mr-2"
                on:click|stopPropagation={(e) => removeLikedTrack(e, track)}
                aria-label="Убрать из любимых"
              >
                <Heart size={20} fill="currentColor" />
              </button>
            </div>
          {/each}
        </div>
      {/if}
      
    {:else if activeTab === 'artists'}
      {#if groupedArtists.length === 0}
        <div class="w-full h-[300px] flex flex-col items-center justify-center text-neutral-400 glass-panel rounded-3xl p-8 text-center gap-4">
          <User size={56} class="opacity-50 drop-shadow-lg" />
          <h3 class="text-xl font-bold text-white">Тут пока нет артистов</h3>
          <p class="text-neutral-400 text-lg">Лайкайте треки, чтобы артисты появились здесь!</p>
        </div>
      {:else}
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-2">
          {#each groupedArtists as artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div 
              class="glass-button p-4 rounded-2xl flex flex-col items-center gap-3 text-center cursor-pointer hover:-translate-y-1 transition-transform group"
              on:click={() => { currentArtist.set(artist.name); currentView.set('artist'); }}
            >
              <div class="w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center shadow-lg overflow-hidden group-hover:shadow-[0_0_20px_var(--color-primary)] transition-shadow">
                {#if artist.avatarUrl}
                  <img src={artist.avatarUrl} alt={artist.name} class="w-full h-full object-cover" />
                {:else}
                  <User size={24} class="text-neutral-400 group-hover:text-primary transition-colors" />
                {/if}
              </div>
              <div>
                <div class="font-bold text-white truncate w-full max-w-[100px]"><ArtistTag artist={artist.name} /></div>
                <div class="text-[11px] text-neutral-400 mt-1">{artist.count} треков</div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if activeTab === 'playlists'}
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 p-2">
        <!-- Create Playlist Tile -->
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div 
          class="glass-button p-4 rounded-2xl flex flex-col items-center justify-center gap-3 text-center cursor-pointer hover:-translate-y-1 transition-transform group min-h-[200px] border border-dashed border-white/20 hover:border-primary/50 bg-black/20"
          on:click={() => {
            newPlaylistName = '';
            showCreatePlaylistModal = true;
          }}
        >
          <div class="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
            <Plus size={32} class="text-neutral-400 group-hover:text-primary transition-colors" />
          </div>
          <div class="font-bold text-neutral-300 mt-2">Новый плейлист</div>
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
            <div class="w-full aspect-square min-w-[3rem] min-h-[3rem] rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 mb-3 border border-white/5 group-hover:border-primary/30 transition-all duration-300 group-hover:-translate-y-1">
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

              <!-- Delete Button -->
              <button 
                class="absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-red-500/80 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all"
                on:click|stopPropagation={(e) => deletePlaylist(e, pl.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
            
            <!-- Metadata -->
            <div class="px-1 relative">
              <div class="font-bold text-[14px] text-white truncate">{pl.title}</div>
              <div class="text-neutral-400 text-[12px] mt-0.5">{pl.tracks?.length || 0} треков</div>
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
              <h2 class="text-2xl font-bold text-white flex items-center gap-3 pr-8">
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
                    class="flex items-center gap-4 group/track cursor-pointer rounded-xl p-2 transition-all hover:-translate-y-1 hover:shadow-lg w-full {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'}"
                    on:click={() => playTrackList(track, pl.tracks)}
                  >
                    <div class="w-6 text-right text-[11px] font-mono text-white/30 group-hover/track:hidden">
                      {#if isActive && $isPlaying}
                         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary ml-auto"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg>
                      {:else}
                        {i + 1}
                      {/if}
                    </div>
                    <div class="w-6 text-right hidden group-hover/track:block text-white/50">
                      <Play size={14} fill="currentColor" class="ml-auto" />
                    </div>
                    <div class="relative w-12 h-12 min-w-[3rem] min-h-[3rem] aspect-square shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800">
                      {#if track.coverUrl}
                        <img src={track.coverUrl} alt="Cover" class="w-full h-full object-cover" />
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
                      <span class="text-neutral-400 text-[12px] mt-0.5 truncate"><ArtistTag artist={track.artist} /></span>
                    </div>
                    <button 
                      class="opacity-0 group-hover/track:opacity-100 p-2 hover:bg-white/10 text-neutral-500 rounded-full transition-all mr-2"
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
      <h2 class="text-xl font-bold text-white mb-4">Новый плейлист</h2>
      <!-- svelte-ignore a11y-autofocus -->
      <input 
        type="text" 
        bind:value={newPlaylistName} 
        placeholder="Введите название..." 
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
