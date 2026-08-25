<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { X, Play, Heart, Music } from 'lucide-svelte';
  import { fade, slide } from 'svelte/transition';
  import { getAudioUrl } from '$lib/api';
  import { currentTrack, queue, isPlaying, currentView, playlists, globalVolume } from '$lib/stores';
  import { invoke } from '@tauri-apps/api/core';
  import ArtistTag from './ArtistTag.svelte';

  export let playlist: any;
  export let onClose: () => void;

  let activeSnippetIndex = 0;
  let previewAudio: HTMLAudioElement;
  let progress = 0; // 0 to 100 for the 10s snippet
  let progressInterval: any;
  let isSnippetPlaying = false;
  let needsManualPlay = false;

  $: tracks = playlist.tracks || [];
  $: currentSnippetTrack = tracks[activeSnippetIndex];

  $: if (previewAudio) {
    previewAudio.volume = Math.pow($globalVolume, 3);
  }

  function stopSnippet() {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
    clearInterval(progressInterval);
    isSnippetPlaying = false;
    progress = 0;
  }

  async function playSnippet(index: number) {
    if (!tracks[index]) return;
    activeSnippetIndex = index;
    stopSnippet();

    const track = tracks[index];
    try {
      const url = await getAudioUrl(track, { silent: true });
      if (url) {
        previewAudio.src = url;
        previewAudio.volume = Math.pow($globalVolume, 3);
        const durSecs = (track.duration || 0) / 1000;
        // Start at 30% of the track (simulated drop)
        if (durSecs > 30) {
          previewAudio.currentTime = durSecs * 0.3;
        } else {
          previewAudio.currentTime = 0;
        }

        try {
          await previewAudio.play();
          isSnippetPlaying = true;
          needsManualPlay = false;
          
          let elapsed = 0;
          progressInterval = setInterval(() => {
            elapsed += 100; // 100ms
            progress = (elapsed / 10000) * 100; // 10s max
            
            if (elapsed >= 10000) {
              // Move to next snippet
              if (activeSnippetIndex < tracks.length - 1) {
                playSnippet(activeSnippetIndex + 1);
              } else {
                stopSnippet(); // end of playlist
              }
            }
          }, 100);
        } catch (playError) {
          console.error("Autoplay blocked:", playError);
          needsManualPlay = true;
          isSnippetPlaying = false;
        }
      }
    } catch (e) {
      console.error("Snippet failed", e);
      // Skip to next on error
      if (activeSnippetIndex < tracks.length - 1) {
        playSnippet(activeSnippetIndex + 1);
      }
    }
  }

  onMount(() => {
    previewAudio = new Audio();
    // Pause main player if it's playing
    if ($isPlaying) {
      invoke('audio_pause').catch(() => {});
      isPlaying.set(false);
    }
    playSnippet(0);
  });

  onDestroy(() => {
    stopSnippet();
  });

  function playFull() {
    stopSnippet();
    if (tracks.length > 0) {
      queue.set(tracks.slice(1));
      currentTrack.set(tracks[0]);
      isPlaying.set(true);
    }
    onClose();
  }

  function goToPlaylist() {
    stopSnippet();
    // In Library.svelte we can listen to this or we just set global state
    // Setting active view to library
    currentView.set('library');
    onClose();
  }

  // Переход на автора из трейлера: сам переход делает ArtistTag, здесь только гасим
  // превью и закрываем модалку, чтобы страница профиля не открылась под ней.
  function leaveForArtist() {
    stopSnippet();
    onClose();
  }

  function formatDuration(ms: number) {
    if (!ms) return "0:00";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md" transition:fade={{duration: 200}}>
  <!-- Modal Content -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="bg-[#1a1a1f] w-full max-w-md rounded-3xl overflow-hidden shadow-2xl border border-white/10 flex flex-col max-h-[85vh]" on:click|stopPropagation>
    
    <!-- Header -->
    <div class="p-6 pb-4 flex items-start gap-4 relative">
      <button class="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 text-white transition-colors z-10" on:click={onClose}>
        <X size={20} />
      </button>
      
      <div class="w-24 h-24 rounded-xl overflow-hidden bg-neutral-800 shrink-0 shadow-lg relative">
        {#if tracks[0]?.coverUrl}
          <img src={tracks[0].coverUrl} alt="Cover" class="w-full h-full object-cover" />
        {:else}
          <div class="w-full h-full flex items-center justify-center text-neutral-500">
            <Music size={32} />
          </div>
        {/if}
        <!-- Snippet Indicator overlay -->
        {#if isSnippetPlaying}
          <div class="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none">
            <div class="flex gap-1 items-end h-6">
              <div class="w-1.5 bg-white animate-[bounce_1s_infinite] h-full" style="animation-delay: 0s;"></div>
              <div class="w-1.5 bg-white animate-[bounce_1s_infinite] h-2/3" style="animation-delay: 0.2s;"></div>
              <div class="w-1.5 bg-white animate-[bounce_1s_infinite] h-4/5" style="animation-delay: 0.4s;"></div>
            </div>
          </div>
        {/if}
        {#if needsManualPlay}
          <button class="absolute inset-0 bg-black/60 hover:bg-black/80 flex items-center justify-center transition-colors group/play" on:click={() => {
            previewAudio.play().then(() => {
              needsManualPlay = false;
              isSnippetPlaying = true;
              let elapsed = 0;
              progressInterval = setInterval(() => {
                elapsed += 100;
                progress = (elapsed / 10000) * 100;
                if (elapsed >= 10000) {
                  if (activeSnippetIndex < tracks.length - 1) {
                    playSnippet(activeSnippetIndex + 1);
                  } else {
                    stopSnippet();
                  }
                }
              }, 100);
            }).catch(e => console.error("Manual play failed", e));
          }}>
            <Play fill="currentColor" size={32} class="text-white transform group-hover/play:scale-110 transition-transform" />
          </button>
        {/if}
      </div>
      
      <div class="flex flex-col pt-2 pr-6">
        <h3 class="text-white/60 font-bold text-sm uppercase tracking-wider mb-1">Трейлер плейлиста</h3>
        <h2 class="text-white font-extrabold text-2xl leading-tight line-clamp-2">{playlist.title}</h2>
      </div>
    </div>

    <!-- Tracklist (Scrollable) -->
    <div class="flex-1 overflow-y-auto px-2 pb-2 custom-scrollbar">
      {#each tracks as track, i}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="flex items-center gap-3 p-2 rounded-xl transition-colors cursor-pointer {i === activeSnippetIndex ? 'bg-white/10' : 'hover:bg-white/5'}" on:click={() => playSnippet(i)}>
          <div class="w-10 h-10 rounded-md overflow-hidden bg-neutral-800 shrink-0 relative">
            {#if track.coverUrl}
              <img src={track.coverUrl} alt="Cover" class="w-full h-full object-cover {i === activeSnippetIndex ? 'opacity-50' : ''}" />
            {:else}
              <div class="w-full h-full flex items-center justify-center text-neutral-500">
                <Music size={16} />
              </div>
            {/if}
            {#if i === activeSnippetIndex}
              <div class="absolute inset-0 flex items-center justify-center text-white">
                <Play fill="currentColor" size={14} />
              </div>
            {/if}
          </div>
          <div class="flex flex-col flex-1 min-w-0">
            <span class="text-sm font-bold truncate {i === activeSnippetIndex ? 'text-primary' : 'text-white'}">{track.title}</span>
            <span class="text-xs text-neutral-400 min-w-0">
              <ArtistTag artist={track.artist} artists={track.artists} onNavigate={leaveForArtist} />
            </span>
          </div>
          <div class="text-xs tnum text-neutral-500 w-12 text-right pr-2 flex items-center justify-end gap-2">
            <Heart size={14} class="opacity-50" />
            {formatDuration(track.duration)}
          </div>
        </div>
      {/each}
    </div>

    <!-- Progress bar for snippet.
         Полоса едет масштабом, а не шириной: ширина — это раскладка, и при `width` браузер
         пересчитывал её на каждом тике прогресса (то есть непрерывно, всё превью).
         `scaleX` от левого края даёт ту же картинку целиком на композиторе. -->
    <div class="h-1 bg-white/5 w-full relative overflow-hidden">
      <div
        class="h-full w-full bg-primary origin-left transition-transform duration-100 ease-linear"
        style="transform: scaleX({progress / 100})"
      ></div>
    </div>

    <!-- Footer Actions -->
    <div class="p-4 bg-white/5 flex gap-3">
      <button class="flex-1 py-3 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold flex items-center justify-center gap-2 transition-colors" on:click={playFull}>
        <Play fill="currentColor" size={16} />
        Слушать полностью
      </button>
      <button class="flex-1 py-3 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-white font-bold transition-colors" on:click={goToPlaylist}>
        Перейти
      </button>
    </div>
  </div>
  <!-- Click outside to close -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="absolute inset-0 z-[-1]" on:click={onClose}></div>
</div>

<style>
  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
  .custom-scrollbar:hover::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
  }
</style>
