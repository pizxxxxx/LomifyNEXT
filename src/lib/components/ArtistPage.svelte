<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Play, Loader2, User, Info, Disc, X, ListMusic } from 'lucide-svelte';
  import { currentArtist, currentTrack, isPlaying, queue, settings, globalVolume } from '$lib/stores';
  import { performSearch, getAudioUrl, getArtistAlbums } from '$lib/api';
  import ArtistTag from './ArtistTag.svelte';

  let tracks: any[] = [];
  let isLoading = true;
  let artistAvatarUrl = '';
  let totalPlaybackCount = 0;
  
  let albums: any[] = [];
  let expandedAlbum: string | null = null;
  
  let previewAudio: HTMLAudioElement | null = null;
  let hoverTimer: any = null;
  let hoveredTrack: any = null;

  $: if (previewAudio) {
    previewAudio.volume = Math.pow($globalVolume, 3);
  }

  onMount(() => {
    previewAudio = new Audio();
  });

  onDestroy(() => {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
  });

  async function handleMouseEnter(track: any) {
    if (!$settings.enableHoverPreview) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoveredTrack = track;
    hoverTimer = setTimeout(async () => {
      if (!previewAudio) return;
      try {
        const url = await getAudioUrl(track);
        if (url && previewAudio) {
          previewAudio.src = url;
          previewAudio.volume = Math.pow($globalVolume, 3);
          const durSecs = (track.duration || 0) / 1000;
          if (durSecs > 60) {
            previewAudio.currentTime = durSecs * 0.3;
          }
          previewAudio.play().catch(() => {});
        }
      } catch(e) {}
    }, $settings.hoverPreviewDelay);
  }

  function handleMouseLeave() {
    hoveredTrack = null;
    if (hoverTimer) clearTimeout(hoverTimer);
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
  }

  // React to artist changes
  $: if ($currentArtist) {
    loadArtist($currentArtist);
  }

  async function loadArtist(artistName: string) {
    isLoading = true;
    tracks = [];
    albums = [];
    expandedAlbum = null;
    try {
      const results = await performSearch(artistName);
      tracks = results.filter((t: any) => t.artist.toLowerCase() === artistName.toLowerCase() || t.artist.toLowerCase() === artistName.toLowerCase() + " ");
      if (tracks.length === 0) {
        tracks = results;
      }

      totalPlaybackCount = tracks.reduce((sum, t) => sum + (t.playbackCount || 0), 0);

      if (tracks.length > 0 && tracks[0].artistAvatarUrl) {
        artistAvatarUrl = tracks[0].artistAvatarUrl;
      } else if (tracks.length > 0 && tracks[0].coverUrl) {
        artistAvatarUrl = tracks[0].coverUrl;
      } else {
        artistAvatarUrl = '';
      }
      
      getArtistAlbums(artistName).then(res => albums = res).catch(e => console.error("Albums fetch failed", e));
      
    } catch (err) {
      console.error(err);
    }
    isLoading = false;
  }

  function playTrack(track: any) {
    const idx = tracks.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set(tracks.slice(idx + 1));
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function playAlbum(album: any) {
    if (album.tracks && album.tracks.length > 0) {
      queue.set(album.tracks.slice(1));
      currentTrack.set(album.tracks[0]);
      isPlaying.set(true);
    }
  }
</script>

<div class="flex flex-col pt-0 px-4 md:px-8 w-full max-w-[1000px] {$settings.leftAlignTracks ? 'mr-auto ml-0' : 'mx-auto'}">
  <!-- Artist Header -->
  <div class="glass-panel p-8 rounded-3xl mb-8 flex items-center gap-8 relative mt-6 min-h-[160px] shrink-0">
    <div class="absolute inset-0 bg-[#00e5ff]/5 pointer-events-none rounded-3xl overflow-hidden"></div>
    <div class="w-32 h-32 min-w-[8rem] min-h-[8rem] aspect-square rounded-full bg-[#2a2a2f] border-4 border-[#00e5ff]/20 shadow-[0_0_30px_rgba(0,229,255,0.2)] flex items-center justify-center shrink-0 overflow-hidden relative">
      <div class="absolute inset-0 bg-gradient-to-br from-[#00e5ff]/20 to-transparent"></div>
      {#if artistAvatarUrl}
        <img src={artistAvatarUrl} alt={$currentArtist} class="w-full h-full object-cover relative z-10" />
      {:else}
        <User size={50} class="text-[#00e5ff] relative z-10" />
      {/if}
    </div>
    <div class="relative z-10 flex flex-col justify-center min-w-0 flex-1 w-full overflow-hidden">
      <div class="flex items-center gap-3 mb-2 min-w-0">
        <h1 class="text-4xl font-extrabold text-white tracking-tight uppercase drop-shadow-md truncate">
          {$currentArtist}
        </h1>
        {#if ['klimentos', 'uniquebleed', 'bleed'].includes($currentArtist.toLowerCase())}
          <span class="text-[12px] font-bold px-2 py-1 rounded bg-orange-500/20 text-orange-400 whitespace-nowrap shrink-0 border border-orange-500/30 tracking-normal normal-case shadow-[0_0_10px_rgba(249,115,22,0.3)]">
            Team Lomify
          </span>
        {/if}
      </div>
      <p class="text-white/50 text-sm font-medium tracking-wide truncate w-full">
        {tracks.length} треков
        {#if totalPlaybackCount > 0}
          • {totalPlaybackCount.toLocaleString('ru-RU')} прослушиваний
        {/if}
      </p>
    </div>
  </div>

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center text-primary">
      <Loader2 class="animate-spin" size={40} />
    </div>
  {:else if tracks.length === 0}
    <div class="flex-1 flex flex-col items-center justify-center text-neutral-400">
      <User size={56} class="mb-4 opacity-50 drop-shadow-lg" />
      <p class="text-xl font-bold">Треки не найдены</p>
    </div>
  {:else}
    
    {#if albums.length > 0}
      <div class="mb-10 w-full animate-in fade-in slide-in-from-bottom-4">
        <h2 class="text-2xl font-bold text-white mb-6 flex items-center gap-3">
          <Disc class="text-primary" /> Альбомы и EP
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {#each albums as album}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div 
              class="w-full group cursor-pointer interactive-item"
              on:click={() => expandedAlbum = expandedAlbum === album.id ? null : album.id}
            >
              <div class="w-full aspect-square min-w-[3rem] min-h-[3rem] rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 mb-3 border border-white/5 group-hover:border-primary/30 transition-all duration-300 group-hover:-translate-y-1">
                {#if album.tracks && album.tracks.length > 0 && album.tracks[0].coverUrl}
                  <img src={album.tracks[0].coverUrl} alt="Cover" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                {:else}
                  <div class="w-full h-full flex items-center justify-center text-neutral-500">
                    <ListMusic size={32} />
                  </div>
                {/if}
                <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button 
                    class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                    on:click|stopPropagation={() => playAlbum(album)}
                    title="Слушать альбом"
                  >
                    <Play fill="currentColor" size={20} />
                  </button>
                </div>
              </div>
              <div class="px-1 relative">
                <div class="font-bold text-[14px] text-white truncate">{album.title}</div>
                <div class="text-neutral-400 text-[12px] mt-0.5">{album.tracks?.length || 0} треков</div>
              </div>
            </div>
          {/each}
        </div>

        <!-- Expanded Album View -->
        {#if expandedAlbum}
          {@const al = albums.find(a => a.id === expandedAlbum)}
          {#if al}
            <div class="mt-8 glass-panel p-6 rounded-3xl border border-primary/20 relative animate-in fade-in slide-in-from-top-4">
              <button class="absolute top-6 right-6 text-neutral-500 hover:text-white transition-colors" on:click={() => expandedAlbum = null}>
                <X size={24} />
              </button>
              <div class="flex items-center justify-between mb-6">
                <h2 class="text-2xl font-bold text-white flex items-center gap-3 pr-8">
                  <Disc class="text-primary" /> {al.title}
                </h2>
              </div>
              <div class="flex flex-col gap-2">
                {#each al.tracks as track, i}
                  {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <div 
                    class="flex items-center gap-4 group/track rounded-xl p-2 transition-all w-full {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'} {track.isBanned ? 'opacity-40 grayscale cursor-not-allowed' : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg'}"
                    on:click={() => {
                       if (track.isBanned) return;
                       const idx = al.tracks.findIndex((t: any) => t.title === track.title && t.artist === track.artist);
                       if (idx !== -1) queue.set(al.tracks.slice(idx + 1));
                       currentTrack.set(track);
                       isPlaying.set(true);
                    }}
                  >
                    <div class="w-6 text-right text-[11px] font-mono text-white/30 {track.isBanned ? '' : 'group-hover/track:hidden'}">
                      {#if track.isBanned}
                        <X size={14} class="text-red-500 ml-auto" />
                      {:else if isActive && $isPlaying}
                         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary ml-auto"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg>
                      {:else}
                        {i + 1}
                      {/if}
                    </div>
                    {#if !track.isBanned}
                      <div class="w-6 text-right hidden group-hover/track:block text-white/50">
                        <Play size={14} fill="currentColor" class="ml-auto" />
                      </div>
                    {/if}
                    <div class="flex flex-col flex-1 min-w-0 pr-4">
                      <span class="font-bold text-[14px] truncate {isActive ? 'text-primary' : 'text-white'}">{track.title}</span>
                      <span class="text-neutral-400 text-[12px] mt-0.5 truncate w-fit">{track.artist}</span>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {/if}
      </div>
    {/if}

    <h2 class="text-2xl font-bold text-white mb-6 flex items-center gap-3">Популярные треки</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 p-2">
      {#each tracks as track, i}
        {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div 
          class="relative hover:z-50 flex items-center gap-4 group rounded-xl p-2 transition-all w-full {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'} {track.isBanned ? 'opacity-40 grayscale cursor-not-allowed' : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg interactive-item'}"
          on:click={() => { if (!track.isBanned) playTrack(track); }}
        >
          <div class="w-6 text-right text-[11px] font-mono text-white/30 {track.isBanned ? '' : 'group-hover:hidden'}">
            {#if track.isBanned}
              <X size={14} class="text-red-500 ml-auto" />
            {:else}
              {i + 1}
            {/if}
          </div>
          {#if !track.isBanned}
            <div class="w-6 text-right hidden group-hover:block text-white/50">
              <Play size={14} fill="currentColor" class="ml-auto" />
            </div>
          {/if}
          <div class="relative w-12 h-12 min-w-[3rem] min-h-[3rem] aspect-square shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800"
               on:mouseenter={() => handleMouseEnter(track)}
               on:mouseleave={handleMouseLeave}>
            {#if track.coverUrl}
              <img src={track.coverUrl} alt="Cover" class="w-full h-full object-cover" />
            {:else}
              <div class="w-full h-full flex items-center justify-center text-neutral-500">
                <Play size={20} />
              </div>
            {/if}
            {#if $settings.enableHoverPreview}
              <div class="absolute bottom-0 left-0 h-[3px] bg-primary shadow-[0_0_8px_#00e5ff]"
                   style="width: {hoveredTrack?.title === track.title ? '100%' : '0%'}; transition: width {$settings.hoverPreviewDelay}ms linear;">
              </div>
            {/if}
          </div>
          <div class="flex flex-col flex-1 min-w-0 pr-1">
            <span class="font-bold text-[14px] truncate {isActive ? 'text-primary' : 'text-white'}">{track.title}</span>
            <div class="text-neutral-400 text-[12px] mt-0.5 min-w-0 hover:underline hover:text-white transition-colors" title={track.artist}
                 on:click|stopPropagation={() => {
                    import('$lib/stores').then(m => {
                      m.currentView.set('artist');
                      m.currentArtist.set(track.artist);
                    });
                 }}>
              <ArtistTag artist={track.artist} />
            </div>
          </div>
          <!-- Dropdown for Info -->
          <div class="relative group/info mr-2">
            <button class="opacity-0 group-hover:opacity-100 p-2 text-neutral-400 hover:text-white rounded-full transition-all" aria-label="Информация" on:click|stopPropagation>
              <Info size={18} />
            </button>
            <div class="absolute right-0 {i >= tracks.length - 2 ? 'bottom-full mb-1' : 'top-full pt-1'} w-56 hidden group-hover/info:block z-50">
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
        </div>
      {/each}
    </div>
  {/if}
</div>
