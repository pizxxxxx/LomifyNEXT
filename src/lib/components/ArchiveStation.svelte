<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { currentTrack, isPlaying, queue, globalVolume, likedTracks, settings } from '$lib/stores';
  import { Play, Info, ListMusic, Radio, Heart, X } from 'lucide-svelte';
  import ArtistTag from './ArtistTag.svelte';
  import PlaylistTrailer from './PlaylistTrailer.svelte';
  import { getAudioUrl } from '$lib/api';

  export let title: string = "Полка";
  export let tracks: any[] = [];
  
  let previewAudio: HTMLAudioElement | null = null;
  let hoverTimer: any = null;
  let hoveredTrack: any = null;

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
    if (hoverTimer) clearTimeout(hoverTimer);
    hoveredTrack = null;
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
  }

  $: if (previewAudio) {
    previewAudio.volume = Math.pow($globalVolume, 3);
  }

  function playTrack(track: any, index: number) {
    if ($currentTrack?.title === track.title) {
      isPlaying.update(p => !p);
      return;
    }
    
    // Set queue to the remaining tracks in this shelf
    queue.set(tracks.slice(index + 1).filter(t => !t.tracks));
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function toggleLike(e: MouseEvent, track: any) {
    e.stopPropagation();
    const isLiked = $likedTracks.some(t => t.title === track.title && t.artist === track.artist);
    if (isLiked) {
      likedTracks.update(tracks => tracks.filter(t => !(t.title === track.title && t.artist === track.artist)));
    } else {
      likedTracks.update(tracks => [track, ...tracks]);
    }
  }

  let activePreviewPlaylist: any = null;
  let expandedPlaylistId: string | null = null;
  
  function startPlaylistPreview(e: Event, pl: any) {
    e.stopPropagation();
    activePreviewPlaylist = pl;
  }
</script>

{#if tracks.length > 0}
  <div class="space-y-4">
    <!-- Shelf Header (similar to SubShelf label) -->
    <div class="flex items-center gap-3 pl-1 mb-2">
      <span class="text-xs font-bold uppercase tracking-[0.15em] text-white/60">
        {title}
      </span>
      <span class="h-px flex-1 bg-white/[0.05]"></span>
    </div>

    <!-- Grid Track List -->
    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 pb-4 pt-4 px-2" style="grid-auto-flow: dense;">
      {#each tracks as track, index}
        {#if track.tracks}
          <!-- Playlist Tile -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div class="{expandedPlaylistId === track.id ? 'col-span-full bg-black/40 backdrop-blur-xl rounded-3xl p-6 shadow-2xl border border-primary/20 flex flex-col md:flex-row gap-6 items-start' : 'col-span-2 flex flex-col'} w-full group cursor-pointer interactive-item transition-all duration-500"
               on:click={() => { expandedPlaylistId = (expandedPlaylistId === track.id ? null : track.id); }}>
            
            <div class="{expandedPlaylistId === track.id ? 'w-full md:w-64 aspect-square shrink-0' : 'w-full aspect-[2/1] mb-3 group-hover:-translate-y-1 group-hover:border-primary/30'} rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 border border-white/5 transition-all duration-500">
              {#if track.tracks && track.tracks.length > 0 && track.tracks[0].coverUrl}
                <img src={track.tracks[0].coverUrl} alt="Cover" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
              {:else}
                <div class="w-full h-full flex items-center justify-center text-neutral-500">
                  <ListMusic size={32} />
                </div>
              {/if}
              
              <!-- Hover Overlay with Wave Preview Button -->
              <div class="{expandedPlaylistId === track.id ? 'hidden' : 'absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4'}">
                <button 
                  class="bg-white/20 hover:bg-white/40 backdrop-blur-md text-white rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                  on:click|stopPropagation={(e) => startPlaylistPreview(e, track)}
                  title="Превью плейлиста"
                >
                  <Radio size={20} />
                </button>
                <button 
                  class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300 delay-75"
                  on:click|stopPropagation={() => {
                    if (track.tracks && track.tracks.length > 0) {
                      queue.set(track.tracks.slice(1));
                      currentTrack.set(track.tracks[0]);
                      isPlaying.set(true);
                    }
                  }}
                  title="Слушать"
                >
                  <Play fill="currentColor" size={20} />
                </button>
              </div>
            </div>
            
            <!-- Metadata -->
            <div class="{expandedPlaylistId === track.id ? 'flex-1 min-w-0 w-full' : 'px-1 relative w-full'} transition-all duration-500">
              <div class="flex items-center gap-3 {expandedPlaylistId === track.id ? 'mb-6' : ''}">
                <ListMusic size={expandedPlaylistId === track.id ? 28 : 14} class="text-primary shrink-0 transition-all duration-500" />
                <div class="font-bold {expandedPlaylistId === track.id ? 'text-3xl drop-shadow-md whitespace-normal' : 'text-[14px] truncate'} text-white transition-all duration-500">{track.title}</div>
              </div>
              
              {#if expandedPlaylistId === track.id}
                <div class="flex items-center gap-4 mb-6">
                  <button 
                    class="bg-primary hover:bg-primary/80 text-black px-6 py-3 rounded-full font-bold shadow-[0_0_20px_var(--color-primary)] transition-all flex items-center gap-2 transform hover:scale-105"
                    on:click|stopPropagation={() => {
                      if (track.tracks && track.tracks.length > 0) {
                        queue.set(track.tracks.slice(1));
                        currentTrack.set(track.tracks[0]);
                        isPlaying.set(true);
                      }
                    }}
                  >
                    <Play fill="currentColor" size={20} />
                    Слушать все
                  </button>
                  <button 
                    class="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
                    on:click|stopPropagation={(e) => startPlaylistPreview(e, track)}
                  >
                    <Radio size={20} />
                    Трейлер
                  </button>
                  <div class="text-white/40 text-sm ml-auto font-medium bg-black/20 px-4 py-2 rounded-xl">
                    {track.tracks?.length || 0} треков
                  </div>
                </div>
                
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[350px] overflow-y-auto custom-scrollbar pr-2">
                  {#each track.tracks as pt, i}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <div class="flex items-center gap-3 p-2 rounded-xl transition-colors group/ptrack cursor-pointer {$currentTrack?.title === pt.title ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/10'}"
                         on:click|stopPropagation={() => {
                            queue.set(track.tracks.slice(i + 1));
                            currentTrack.set(pt);
                            isPlaying.set(true);
                         }}>
                      <div class="w-10 h-10 rounded-md overflow-hidden bg-transparent shrink-0 relative shadow-md">
                        <img src={pt.coverUrl || 'lomimi.png'} alt="Cover" class="w-full h-full object-cover" />
                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/ptrack:opacity-100 flex items-center justify-center transition-opacity">
                          <Play fill="currentColor" size={16} class="text-white" />
                        </div>
                      </div>
                      <div class="flex flex-col min-w-0 flex-1">
                        <div class="text-sm font-bold truncate transition-colors {$currentTrack?.title === pt.title ? 'text-primary' : 'text-white group-hover/ptrack:text-primary'}">{pt.title}</div>
                        <div class="text-[11px] text-neutral-400 truncate">{pt.artist}</div>
                      </div>
                      <div class="opacity-0 group-hover/ptrack:opacity-100 transition-opacity">
                        <button 
                          class="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-all"
                          on:click|stopPropagation={(e) => toggleLike(e, pt)}
                        >
                          {#if $likedTracks.some(t => t.title === pt.title && t.artist === pt.artist)}
                            <Heart size={14} fill="#00e5ff" class="text-[#00e5ff]" />
                          {:else}
                            <Heart size={14} />
                          {/if}
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="text-neutral-400 text-[12px] mt-0.5">{track.tracks?.length || 0} треков</div>
              {/if}
            </div>
          </div>
        {:else}
          <!-- Normal Track Tile -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div class="w-full group interactive-item {track.isBanned ? 'opacity-40 grayscale cursor-not-allowed' : 'cursor-pointer'}"
               on:click={() => { if (!track.isBanned) playTrack(track, index); }}>
            
            <!-- Cover -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="w-full aspect-square min-w-[3rem] min-h-[3rem] rounded-xl overflow-hidden shadow-lg relative bg-transparent mb-3 border transition-all duration-300 {$currentTrack?.title === track.title ? 'border-primary shadow-[0_0_15px_var(--color-primary)] scale-105' : 'border-white/5 group-hover:border-primary/30 group-hover:-translate-y-1'}"
                 on:mouseenter={() => handleMouseEnter(track)}
                 on:mouseleave={handleMouseLeave}>
              <img src={track.coverUrl || 'lomimi.png'} alt={track.title} class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
              
              <!-- Hover Play Overlay -->
              <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <button class="{track.isBanned ? 'bg-red-500/20 text-red-500 cursor-not-allowed' : 'bg-primary text-white'} rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300">
                  {#if track.isBanned}
                    <X size={20} />
                  {:else}
                    <Play fill="currentColor" size={20} />
                  {/if}
                </button>
                <button 
                  class="absolute top-2 right-2 p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white/80 hover:text-white transition-all transform opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 duration-300 delay-75 z-10"
                  on:click={(e) => toggleLike(e, track)}
                  title="Мне нравится"
                >
                  {#if $likedTracks.some(t => t.title === track.title && t.artist === track.artist)}
                    <Heart size={16} fill="#00e5ff" class="text-[#00e5ff]" />
                  {:else}
                    <Heart size={16} />
                  {/if}
                </button>
                <!-- Hover Progress Bar -->
                {#if $settings.enableHoverPreview}
                  <div class="absolute bottom-0 left-0 h-[4px] bg-primary shadow-[0_0_8px_#00e5ff]"
                       style="width: {hoveredTrack?.title === track.title ? '100%' : '0%'}; transition: width {$settings.hoverPreviewDelay}ms linear;">
                  </div>
                {/if}
              </div>
            </div>
            
            <!-- Metadata -->
            <div class="px-1 relative group/info">
              <div class="flex justify-between items-start">
                <div class="min-w-0 flex-1 pr-1">
                  <h3 class="text-sm font-semibold truncate transition-colors {$currentTrack?.title === track.title ? 'text-primary' : 'text-white/90 group-hover:text-white'}" title={track.title}>{track.title}</h3>
                  <div class="text-xs text-white/50 mt-0.5 min-w-0 hover:underline hover:text-white transition-colors" title={track.artist}
                       on:click|stopPropagation={() => {
                          import('$lib/stores').then(m => {
                            m.currentView.set('artist');
                            m.currentArtist.set(track.artist);
                          });
                       }}>
                    <ArtistTag artist={track.artist} />
                  </div>
                </div>
                <!-- Info Button -->
                <button class="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-white transition-opacity mt-0.5" on:click|stopPropagation aria-label="Информация">
                  <Info size={16} />
                </button>
              </div>
              
              <!-- Tooltip -->
              <div class="absolute bottom-full left-0 mb-2 w-56 hidden group-hover/info:block z-50">
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
        {/if}
      {/each}
    </div>
  </div>
{/if}

{#if activePreviewPlaylist}
  <PlaylistTrailer playlist={activePreviewPlaylist} onClose={() => activePreviewPlaylist = null} />
{/if}
