<script lang="ts">
  import { onMount } from 'svelte';
  import { Search as SearchIcon, Play, Loader2, Music, User, Heart, Plus, X, ListMusic, Check } from 'lucide-svelte';
  import { performSearch, getSoundCloudPlaylists } from '$lib/api';
  import { currentTrack, isPlaying, settings, searchQuery, searchResults, searchPlaylists, queue, searchHistory, likedTracks, playlists, notify } from '$lib/stores';
  import { getTracks } from '$lib/db';
  import ArtistTag from './ArtistTag.svelte';
  import { get } from 'svelte/store';

  let isLoading = false;
  let timeout: any;

  onMount(() => {
    if ($searchQuery.trim() !== '' && $searchResults.length === 0) {
      handleSearch({ target: { value: $searchQuery } } as any);
    }
  });

  function handleSearch(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    searchQuery.set(val);
    clearTimeout(timeout);
    
    if ($searchQuery.trim() === '') {
      searchResults.set([]);
      searchPlaylists.set([]);
      return;
    }

    isLoading = true;
    timeout = setTimeout(async () => {
      const lowerQuery = $searchQuery.toLowerCase();
      // Fetch local tracks first
      const localTracks = await getTracks();
      const filteredLocal = localTracks.filter(t => 
        t.title.toLowerCase().includes(lowerQuery) || 
        t.artist.toLowerCase().includes(lowerQuery)
      ).map(t => ({ ...t, source: 'Локальный' }));

      let onlineResults: any[] = [];
      onlineResults = await performSearch($searchQuery);
      
      let onlinePlaylists: any[] = [];
      if ($settings.searchSource === 'soundcloud') {
        onlinePlaylists = await getSoundCloudPlaylists($searchQuery, 4);
      }

      // Combine local and online results
      searchResults.set([...filteredLocal, ...onlineResults]);
      searchPlaylists.set(onlinePlaylists);
      isLoading = false;
      
      // Update history
      searchHistory.update(h => {
        const lower = lowerQuery.trim();
        if (lower) {
          const filtered = h.filter(q => q !== lower);
          return [lower, ...filtered].slice(0, 20);
        }
        return h;
      });
    }, 500);
  }

  function playTrack(track: any) {
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

  function toggleLikeSearch(track: any, e: Event) {
    e.stopPropagation();
    const current = get(likedTracks);
    const idx = current.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      likedTracks.set([...current.slice(0, idx), ...current.slice(idx + 1)]);
      notify('Удалено из любимых', 'info');
    } else {
      likedTracks.set([track, ...current]);
      notify('Добавлено в любимые', 'success');
    }
  }

  let showPlaylistMenuId: string | null = null;
  function handlePlaylistClick(e: Event, trackId: string) {
    e.stopPropagation();
    if (showPlaylistMenuId === trackId) showPlaylistMenuId = null;
    else showPlaylistMenuId = trackId;
  }
  function addToPlaylist(e: Event, track: any, playlistId: string) {
    e.stopPropagation();
    playlists.update(p => {
      const idx = p.findIndex(pl => pl.id === playlistId);
      if (idx !== -1) {
        const updatedPl = { ...p[idx] };
        updatedPl.tracks = updatedPl.tracks ? [...updatedPl.tracks, track] : [track];
        const newP = [...p];
        newP[idx] = updatedPl;
        return newP;
      }
      return p;
    });
    notify(`Добавлено в плейлист`, 'success');
    showPlaylistMenuId = null;
  }

  function removeFromPlaylist(e: Event, track: any, playlistId: string) {
    e.stopPropagation();
    playlists.update(p => {
      const idx = p.findIndex(pl => pl.id === playlistId);
      if (idx !== -1 && p[idx].tracks) {
        const updatedPl = { ...p[idx] };
        updatedPl.tracks = updatedPl.tracks.filter((t: any) => !( (t.id && t.id === track.id) || (t.title === track.title && t.artist === track.artist) ));
        const newP = [...p];
        newP[idx] = updatedPl;
        return newP;
      }
      return p;
    });
    notify(`Удалено из плейлиста`, 'info');
    showPlaylistMenuId = null;
  }
</script>

<div class="max-w-6xl {$settings.leftAlignTracks ? 'mr-auto ml-0' : 'mx-auto'} py-8 px-4 w-full flex flex-col">
  <div class="relative group mb-8 flex-shrink-0">
    <div class="absolute inset-y-0 left-4 flex items-center pointer-events-none text-neutral-400 group-focus-within:text-primary transition-colors z-10">
      <SearchIcon size={24} />
    </div>
    <input 
      type="text" 
      placeholder="Что будем слушать?" 
      class="w-full h-16 glass-panel pl-14 pr-6 text-xl text-white placeholder-neutral-400 outline-none ring-0 focus:outline-none focus:ring-0 border border-transparent focus:border-transparent transition-all"
      bind:value={$searchQuery}
      on:input={handleSearch}
    />
  </div>

  <div class="flex-1 min-h-0">
    {#if isLoading}
      <div class="flex items-center justify-center h-40">
        <Loader2 class="animate-spin text-white/50 w-8 h-8" />
      </div>
    {:else if $searchResults.length === 0 && $searchPlaylists.length === 0 && $searchQuery.trim() !== ''}
      <div class="py-20 text-center text-neutral-400 glass-panel mt-10">
        <SearchIcon size={48} class="mx-auto mb-4 opacity-50" />
        <p class="text-lg">Ничего не найдено по запросу "{$searchQuery}"</p>
      </div>
    {:else if $searchResults.length > 0 || $searchPlaylists.length > 0}
      <div class="space-y-8">
        
        {#if $searchPlaylists.length > 0}
          <div class="animate-in fade-in slide-in-from-bottom-4">
            <h2 class="text-2xl font-bold mb-6 ml-2 flex items-center gap-3">
              <ListMusic class="text-primary" /> Плейлисты
            </h2>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 p-2">
              {#each $searchPlaylists as pl}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <div 
                  class="w-full group cursor-pointer interactive-item"
                  on:click={() => playPlaylist(pl)}
                >
                  <div class="w-full aspect-square min-w-[3rem] min-h-[3rem] rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 mb-3 border border-white/5 group-hover:border-primary/30 transition-all duration-300 group-hover:-translate-y-1">
                    {#if pl.tracks && pl.tracks.length > 0 && pl.tracks[0].coverUrl}
                      <img src={pl.tracks[0].coverUrl} alt="Cover" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                    {:else}
                      <div class="w-full h-full flex items-center justify-center text-neutral-500">
                        <ListMusic size={32} />
                      </div>
                    {/if}
                    <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <button class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300">
                        <Play fill="currentColor" size={20} />
                      </button>
                    </div>
                  </div>
                  <div class="px-1 relative">
                    <div class="font-bold text-[14px] text-white truncate">{pl.title}</div>
                    <div class="text-neutral-400 text-[12px] mt-0.5">{pl.tracks?.length || 0} треков</div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if $searchResults.length > 0}
          <div class="space-y-4 animate-in fade-in slide-in-from-bottom-4" style="animation-delay: 100ms">
            <h2 class="text-2xl font-bold mb-6 ml-2">Треки</h2>
            <div class="flex flex-col gap-2 p-2">
          {#each $searchResults as track, i}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div 
              class="relative flex items-center gap-4 group rounded-xl p-3 transition-all w-full {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'} {track.isBanned ? 'opacity-40 grayscale cursor-not-allowed' : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg interactive-item'} {showPlaylistMenuId === (track.id || track.title) ? 'z-[60]' : 'hover:z-50'}"
              on:click={() => { if (!track.isBanned) playTrack(track); }}
            >
              <div class="w-8 text-center text-[12px] font-mono text-white/30 {track.isBanned ? '' : 'group-hover:hidden'}">
                {#if track.isBanned}
                  <X size={16} class="text-red-500 mx-auto" />
                {:else}
                  {i + 1}
                {/if}
              </div>
              {#if !track.isBanned}
                <div class="w-8 text-center hidden group-hover:flex items-center justify-center text-white/50">
                  <Play size={16} fill="currentColor" />
                </div>
              {/if}
              <div class="relative w-12 h-12 shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800">
                {#if track.coverUrl}
                  <img src={track.coverUrl} alt="Cover" class="w-full h-full object-cover" />
                {:else}
                  <div class="w-full h-full flex items-center justify-center text-neutral-500">
                    <Music size={20} />
                  </div>
                {/if}
              </div>
              <div class="flex flex-col flex-1 min-w-0 pr-4">
                <span class="font-bold text-[15px] truncate {isActive ? 'text-primary' : 'text-white'}">{track.title}</span>
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <span class="text-neutral-400 text-[13px] mt-0.5 truncate cursor-pointer hover:underline hover:text-white"
                     on:click={(e) => {
                        e.stopPropagation();
                        import('$lib/stores').then(m => {
                          m.currentView.set('artist');
                          m.currentArtist.set(track.artist);
                        });
                     }}
                >
                  <ArtistTag artist={track.artist} />
                </span>
              </div>
              <div class="flex items-center gap-2 {showPlaylistMenuId === (track.id || track.title) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity pr-2 relative">
                <button aria-label="Like" class="p-2 hover:bg-white/10 rounded-full transition-colors text-white" on:click={(e) => toggleLikeSearch(track, e)}>
                   {#if $likedTracks.some(t => t.title === track.title && t.artist === track.artist)}
                     <Heart size={18} fill="var(--color-primary)" class="text-primary" />
                   {:else}
                     <Heart size={18} />
                   {/if}
                </button>
                <button aria-label="Add to Playlist" class="p-2 hover:bg-white/10 rounded-full transition-colors text-white" on:click={(e) => handlePlaylistClick(e, track.id || track.title)}>
                   <Plus size={18} />
                </button>
                {#if showPlaylistMenuId === (track.id || track.title)}
                  <div class="absolute right-0 bottom-full mb-2 w-48 bg-neutral-800 rounded-xl shadow-xl border border-white/10 py-2 z-[60]">
                    <div class="px-3 pb-2 text-xs font-bold text-neutral-400 uppercase tracking-wider border-b border-white/5 mb-1">Плейлисты</div>
                    {#each $playlists as pl}
                      {@const isInPlaylist = pl.tracks && pl.tracks.some((t: any) => (t.id && t.id === track.id) || (t.title === track.title && t.artist === track.artist))}
                      <button class="w-full text-left flex items-center justify-between px-3 py-2 text-sm text-white hover:bg-white/10" on:click={(e) => isInPlaylist ? removeFromPlaylist(e, track, pl.id) : addToPlaylist(e, track, pl.id)}>
                        <span class="truncate pr-2">{pl.title}</span>
                        {#if isInPlaylist}
                          <Check size={16} class="text-primary flex-shrink-0" />
                        {/if}
                      </button>
                    {/each}
                    {#if $playlists.length === 0}
                       <div class="px-3 py-2 text-sm text-neutral-500">Нет плейлистов</div>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else if $searchQuery.trim() === ''}
      <div class="mt-4 mb-8">
        <div class="flex items-center justify-between mb-4 px-2">
          <h2 class="text-xl font-bold text-white">История поиска</h2>
          {#if $searchHistory.length > 0}
            <button class="text-xs text-neutral-400 hover:text-white transition-colors" on:click={() => searchHistory.set([])}>Очистить</button>
          {/if}
        </div>
        {#if $searchHistory.length > 0}
          <div class="flex flex-wrap gap-3 px-2">
            {#each $searchHistory as hist}
              <button 
                class="px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/20 transition-all text-sm font-medium flex items-center gap-2"
                on:click={() => { searchQuery.set(hist); handleSearch({ target: { value: hist } } as any); }}
              >
                <SearchIcon size={14} class="opacity-50" />
                {hist}
              </button>
            {/each}
          </div>
        {:else}
          <div class="py-12 text-center text-neutral-500 glass-panel mx-2">
            <SearchIcon size={32} class="mx-auto mb-3 opacity-30" />
            <p>Вы пока ничего не искали.</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
