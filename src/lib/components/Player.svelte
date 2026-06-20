<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Volume2, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Maximize2, Minimize2, Mic2, Radio, Heart, Share2, Download, Check, Plus } from 'lucide-svelte';
  import { currentTrack, isPlaying, progress, duration as durationStore, currentView, previousView, settings, equalizerBands, listenStats, queue, likedTracks, trackHistory, currentArtist, notify, playlists, globalVolume } from '$lib/stores';
  import { getAudioUrl, getTrackInfo, getLyrics } from '$lib/api';
  import { getTracks, saveTrack } from '$lib/db';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { get } from 'svelte/store';
  import ArtistTag from './ArtistTag.svelte';
  
  $: isLiked = $currentTrack ? $likedTracks.some(t => t.title === $currentTrack.title && t.artist === $currentTrack.artist) : false;
  let currentTime = 0;
  let duration = 0;
  let currentTrackListenTime = 0;
  let currentTrackCounted = false;

  async function handleShare() {
    if (!$currentTrack || $currentTrack.source !== 'soundcloud') {
       notify('Ссылка недоступна для этого трека', 'error');
       return;
    }
    
    let url = $currentTrack.permalinkUrl;
    
    if (!url && $currentTrack.id) {
       const info = await getTrackInfo($currentTrack.id);
       if (info && info.permalink_url) {
           url = info.permalink_url;
           // save it back to current track
           $currentTrack.permalinkUrl = url;
       }
    }
    
    if (!url) {
       url = `https://soundcloud.com/search?q=${encodeURIComponent($currentTrack.artist + ' ' + $currentTrack.title)}`;
    }
    
    const text = `${url}\ni use Lomify btw`;
    try {
       await navigator.clipboard.writeText(text);
       notify('Ссылка скопирована!', 'success');
    } catch (e) {
       console.error(e);
       notify('Ошибка при копировании', 'error');
    }
  }
  let isRadioMode = false;
  let repeatMode = 0; // 0: off, 1: all, 2: one
  let statInterval: any;
  let unlistenTick: UnlistenFn;
  let unlistenEnded: UnlistenFn;
  let unlistenMediaPlay: UnlistenFn;
  let unlistenMediaPause: UnlistenFn;
  let unlistenMediaToggle: UnlistenFn;
  let unlistenMediaNext: UnlistenFn;
  let unlistenMediaPrev: UnlistenFn;
  let unlistenTray: UnlistenFn;
  let currentTargetId: string | null = null;
  let loadingTrackId: string | null = null;
  let isShuffle = false;
  let showPlaylistMenu = false;

  function toggleLike() {
    if (!$currentTrack) return;
    const current = get(likedTracks);
    const idx = current.findIndex(t => t.title === $currentTrack.title && t.artist === $currentTrack.artist);
    if (idx !== -1) {
      likedTracks.set([...current.slice(0, idx), ...current.slice(idx + 1)]);
      notify('Удалено из любимых', 'info');
    } else {
      likedTracks.set([$currentTrack, ...current]);
      notify('Добавлено в любимые', 'success');
    }
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
  }

  function removeFromPlaylist(e: Event, track: any, playlistId: string) {
    e.stopPropagation();
    playlists.update(p => {
      const idx = p.findIndex(pl => pl.id === playlistId);
      if (idx !== -1 && p[idx].tracks) {
        const updatedPl = { ...p[idx] };
        updatedPl.tracks = updatedPl.tracks.filter((t: any) => t.id !== track.id && !(t.title === track.title && t.artist === track.artist));
        const newP = [...p];
        newP[idx] = updatedPl;
        return newP;
      }
      return p;
    });
    notify(`Удалено из плейлиста`, 'info');
  }

  let isDownloaded = false;
  let isDownloading = false;

  async function checkIsDownloaded() {
    if (!$currentTrack) return;
    try {
      const trackIdStr = $currentTrack.id ? $currentTrack.id : `${$currentTrack.title}-${$currentTrack.artist}`;
      const urn = `lomify:${$currentTrack.source}:${trackIdStr}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');
      isDownloaded = await invoke('track_is_cached', { urn });
    } catch (e) {
      isDownloaded = false;
    }
  }

  $: if ($currentTrack) {
     checkIsDownloaded();
  }

  async function handleDownload() {
    if (!$currentTrack || isDownloaded || isDownloading) return;
    isDownloading = true;
    notify('Начинаю скачивание...', 'info');
    try {
       const url = await getAudioUrl($currentTrack);
       if (!url) throw new Error("No URL");
       const trackIdStr = $currentTrack.id ? $currentTrack.id : `${$currentTrack.title}-${$currentTrack.artist}`;
       const urn = `lomify:${$currentTrack.source}:${trackIdStr}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');
       const request = {
         urn,
         url,
         urls: [url],
         hq: false,
         durationMs: $currentTrack.duration ? $currentTrack.duration : null
       };
       await invoke('track_ensure_cached', { request });
       isDownloaded = true;
       notify('Трек скачан', 'success');
    } catch (e) {
       console.error(e);
       notify('Ошибка скачивания', 'error');
    } finally {
       isDownloading = false;
    }
  }

  async function handleTrackEnded() {
    if (repeatMode === 2) {
      invoke('audio_seek', { position: 0 });
      invoke('audio_play').catch(() => {});
      return;
    }

    const currentQueue = get(queue);
    if (currentQueue && currentQueue.length > 0) {
      let nextIndex = isShuffle && currentQueue.length > 1 ? Math.floor(Math.random() * currentQueue.length) : 0;
      const nextTrack = currentQueue[nextIndex];
      const newQueue = [...currentQueue.slice(0, nextIndex), ...currentQueue.slice(nextIndex + 1)];
      
      if (repeatMode === 1 && $currentTrack) {
        queue.set([...newQueue, $currentTrack]);
      } else {
        queue.set(newQueue);
      }
      
      if ($currentTrack) {
        const hist = get(trackHistory);
        trackHistory.set([...hist, $currentTrack]);
      }
      currentTrack.set(nextTrack);
      isPlaying.set(true);
    } else if ($currentTrack) {
      import('$lib/api').then(async api => {
        const trending = await api.getRelatedTracks($currentTrack);
        if (trending && trending.length > 0) {
          const nextTrack = trending[Math.floor(Math.random() * trending.length)];
          currentTrack.set(nextTrack);
        } else {
          $isPlaying = false;
        }
      });
    } else {
      $isPlaying = false;
    }
  }

  function playNext() {
    handleTrackEnded();
  }

  function doPlayPrev() {
    // If we have history, maybe go back? For now, let's just seek to 0 if > 3s, else pop history
    if (currentTime > 3) {
      invoke('audio_seek', { position: 0 });
    } else {
      const hist = get(trackHistory);
      if (hist.length > 0) {
        const prevTrack = hist[hist.length - 1];
        trackHistory.set(hist.slice(0, -1));
        const currentQueue = get(queue);
        if ($currentTrack) {
          queue.set([$currentTrack, ...currentQueue]);
        }
        currentTrack.set(prevTrack);
        isPlaying.set(true);
      } else {
        invoke('audio_seek', { position: 0 });
      }
    }
  }

  function playPrev() {
    doPlayPrev();
  }

  onMount(async () => {
    unlistenTick = await listen('audio:tick', (event) => {
      currentTime = event.payload as number;
      progress.set(currentTime);
    });

    unlistenEnded = await listen('audio:ended', () => {
      handleTrackEnded();
    });

    unlistenMediaPlay = await listen('media:play', () => isPlaying.set(true));
    unlistenMediaPause = await listen('media:pause', () => isPlaying.set(false));
    unlistenMediaToggle = await listen('media:toggle', () => isPlaying.update(p => !p));
    unlistenMediaNext = await listen('media:next', () => playNext());
    unlistenMediaPrev = await listen('media:prev', () => playPrev());
    
    unlistenTray = await listen('tray-action', (event) => {
      const id = event.payload;
      if (id === 'play_pause') isPlaying.update(p => !p);
      else if (id === 'next') playNext();
      else if (id === 'prev') playPrev();
    });

    statInterval = setInterval(async () => {
      if ($isPlaying) {
        listenStats.update(s => ({ ...s, listenSeconds: s.listenSeconds + 1 }));
        
        if ($currentTrack) {
          currentTrackListenTime++;
          if (!currentTrackCounted && duration > 0) {
            let threshold = duration < 60 ? duration * 0.8 : 60;
            if (currentTrackListenTime >= threshold) {
              currentTrackCounted = true;
              listenStats.update(s => {
                const historyObj = s.history || {};
                const trackId = $currentTrack.title + '-' + $currentTrack.artist;
                const currentHistory = historyObj[trackId] || { count: 0, title: $currentTrack.title, artist: $currentTrack.artist, coverUrl: $currentTrack.coverUrl };
                return {
                  ...s,
                  tracksPlayed: (s.tracksPlayed || 0) + 1,
                  history: { ...historyObj, [trackId]: { ...currentHistory, count: currentHistory.count + 1 } }
                };
              });
            }
          }
        }
      }
    }, 1000);
  });

  onDestroy(() => {
    if (unlistenTick) unlistenTick();
    if (unlistenEnded) unlistenEnded();
    if (unlistenMediaPlay) unlistenMediaPlay();
    if (unlistenMediaPause) unlistenMediaPause();
    if (unlistenMediaToggle) unlistenMediaToggle();
    if (unlistenMediaNext) unlistenMediaNext();
    if (unlistenMediaPrev) unlistenMediaPrev();
    if (unlistenTray) unlistenTray();
    clearInterval(statInterval);
  });

  // React to track changes
  $: {
    const trackId = $currentTrack ? `${$currentTrack.source}-${$currentTrack.title}-${$currentTrack.artist}` : null;
    if ($currentTrack && trackId !== currentTargetId) {
      currentTargetId = trackId;
      loadingTrackId = trackId;
      currentTrackListenTime = 0;
      currentTrackCounted = false;
    duration = 0;
    currentTime = 0;
    progress.set(0);
    durationStore.set(0);
    invoke('audio_stop').catch(() => {});
    
    (async () => {
      const currentTrackObj = $currentTrack;
      const trackIdStr = currentTrackObj.id ? currentTrackObj.id : `${currentTrackObj.title}-${currentTrackObj.artist}`;
      const urn = `lomify:${currentTrackObj.source}:${trackIdStr}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');

      let isLocalFile = false;
      let localPath = "";
      if (currentTrackObj.isLocal || currentTrackObj.source === 'Локальный') {
        isLocalFile = true;
        localPath = currentTrackObj.audioUrl;
      }

      let isCached = false;
      if (!isLocalFile) {
        try {
          isCached = await invoke<boolean>('track_is_cached', { urn });
        } catch(e) {}
      }

      let url: string | null = null;
      if (isCached || isLocalFile) {
        url = currentTrackObj.audioUrl || "dummy://url";
      } else {
        try {
          url = await getAudioUrl(currentTrackObj);
        } catch (e) {
          console.error("getAudioUrl failed", e);
        }
      }

      if (currentTargetId !== trackId) return; // FIX RACE CONDITION

      if (!url && !isLocalFile && !isCached) {
        console.warn("No URL found for track", currentTrackObj);
        if (loadingTrackId === trackId) loadingTrackId = null;
        
        (currentTrackObj as any).isBanned = true;
        if (currentTrackObj.id) {
           getTracks().then(ts => {
             const dbTrack = ts.find((t: any) => t.id === currentTrackObj.id);
             if (dbTrack) {
               dbTrack.isBanned = true;
               saveTrack(dbTrack);
             }
           });
           likedTracks.update(ts => ts.map(t => t.id === currentTrackObj.id ? { ...t, isBanned: true } : t));
        }

        notify("Трек недоступен (возможно, заблокирован в регионе). Пропуск...", "error");
        setTimeout(() => playNext(), 1500);
        return;
      }

      const safeUrl = url || "dummy://url";

      // Background fetch lyrics
      getLyrics(currentTrackObj.title, currentTrackObj.artist).catch(() => {});
      
      let loadPromise;
      if (!isLocalFile) {
        try {
           const request = {
             urn: urn,
             url: safeUrl,
             urls: [safeUrl],
             hq: false,
             durationMs: currentTrackObj.duration ? currentTrackObj.duration : null
           };
           
           if (isCached) {
              const cached = await invoke<any>('track_ensure_cached', { request });
              loadPromise = invoke('audio_load_file', { path: cached.path, cacheKey: null, startPaused: false });
           } else {
              // Stream immediately for instant playback
              loadPromise = invoke('audio_load_url', { 
                url: safeUrl, 
                sessionId: null, 
                cachePath: null, 
                cacheKey: null, 
                startPaused: false 
              }).catch(e => {
                console.error("Playback failed:", e);
                notify("Ошибка воспроизведения. Переключаем...", "error");
                setTimeout(playNext, 1500);
                throw e;
              });
              
              // Cache in the background if enabled
              if ($settings.autoCache) {
                invoke('track_ensure_cached', { request }).catch(e => console.error("Background cache failed", e));
              }
           }
        } catch(e) {
           console.error("Playback prep failed", e);
           return;
        }
      } else {
         loadPromise = invoke('audio_load_file', { path: localPath, cacheKey: null, startPaused: false });
      }

      loadPromise.then((res: any) => {
        if (loadingTrackId === trackId) loadingTrackId = null;
        duration = res.duration || res.durationSecs || res.duration_secs || (currentTrackObj.duration ? currentTrackObj.duration / 1000 : 0);
        durationStore.set(duration);
        $isPlaying = true;
        invoke('audio_play').catch(() => {});
        
        invoke('audio_set_metadata', {
          title: currentTrackObj.title,
          artist: currentTrackObj.artist,
          coverUrl: currentTrackObj.coverUrl,
          durationSecs: duration
        }).catch(() => {});
      }).catch(e => {
        if (loadingTrackId === trackId) loadingTrackId = null;
        console.error("Load error", e);
        setTimeout(() => {
          playNext();
        }, 1500);
      });
    })();
    }
  }

  // React to play/pause state
  $: {
    if ($isPlaying && loadingTrackId === null) {
      invoke('audio_play').catch(e => console.error(e));
      invoke('audio_set_playback_state', { playing: true }).catch(e => console.error(e));
    } else if (!$isPlaying) {
      invoke('audio_pause').catch(e => console.error(e));
      invoke('audio_set_playback_state', { playing: false }).catch(e => console.error(e));
    }
  }

  // Apply volume
  $: if ($currentTrack) {
    invoke('audio_set_volume', { volume: Math.pow($globalVolume, 3) }).catch(e => console.error(e));
  }

  // Apply EQ
  $: if ($equalizerBands) {
    invoke('audio_set_eq', { enabled: true, gains: $equalizerBands }).catch(e => console.error(e));
  }

  // Discord RPC updates
  function updateDiscordRpc() {
    if ($settings.enableDiscordRpc === false) {
      invoke('discord_clear_activity').catch(() => {});
      return;
    }
    invoke('discord_set_activity', {
      track: {
        title: $currentTrack?.title || "Неизвестный трек",
        artist: $currentTrack?.artist || "Неизвестный исполнитель",
        artwork_url: $currentTrack?.coverUrl || "lomify_logo",
        track_url: null,
        duration_secs: duration ? Math.floor(duration) : null,
        elapsed_secs: currentTime ? Math.floor(currentTime) : null,
        is_playing: $isPlaying,
        mode: "track",
        show_button: false
      }
    }).catch(e => console.warn("Discord RPC error:", e));
  }

  $: triggerDiscordRpc($currentTrack, $isPlaying, duration);
  function triggerDiscordRpc(track: any, playing: boolean, dur: number) {
    if (track !== undefined) {
      updateDiscordRpc();
    }
  }

  function formatTime(s: number) {
    if (!s || isNaN(s)) return "0:00";
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
  }

  function handleSeek(e: MouseEvent) {
    if (!duration) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const newTime = Math.max(0, Math.min(duration - 0.1, pos * duration));
    invoke('audio_seek', { position: newTime }).catch(e => console.error(e));
    currentTime = newTime;
    progress.set(currentTime);
    updateDiscordRpc();
  }
  
  function handleVolume(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    $globalVolume = pos;
  }
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.deltaY < 0) {
      $globalVolume = Math.min(1, $globalVolume + 0.05);
    } else if (e.deltaY > 0) {
      $globalVolume = Math.max(0, $globalVolume - 0.05);
    }
  }
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="px-4 pb-4 bg-transparent pointer-events-none">
  <div
    class="pointer-events-auto h-[90px] flex items-center px-6 justify-between transition-colors {$currentView === 'fullscreen' ? 'bg-transparent border-t border-white/5' : ($settings.uiStyle === 'style3' ? 'border border-white/10 shadow-2xl rounded-[2.5rem]' : ($settings.uiStyle === 'style1' ? 'bg-white/10 backdrop-blur-3xl border border-white/20 shadow-2xl rounded-2xl' : 'bg-black/40 backdrop-blur-3xl border border-white/10 shadow-2xl rounded-2xl'))}"
    on:wheel={handleWheel}
  >
  
  <!-- Track Info -->
  <div class="flex items-center gap-4 w-[30%] min-w-[180px]">
      {#if $currentTrack}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div 
          class="relative group cursor-pointer overflow-hidden rounded-xl shadow-md w-14 h-14 bg-neutral-800 flex-shrink-0"
          on:click={() => { 
            if ($currentView !== 'fullscreen') { 
              $previousView = $currentView; 
              $currentView = 'fullscreen'; 
            } else {
              $currentView = $previousView;
            }
          }}
        >
          {#if $currentTrack.coverUrl}
            <img src={$currentTrack.coverUrl} alt="Cover" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-[400ms]" />
          {:else}
            <div class="w-full h-full bg-gradient-to-br from-neutral-700 to-neutral-900"></div>
          {/if}
          <div class="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            {#if $currentView === 'fullscreen'}
              <Minimize2 size={16} class="text-white" />
            {:else}
              <Maximize2 size={16} class="text-white" />
            {/if}
          </div>
        </div>
        <div class="flex flex-col min-w-0">
          <div class="font-semibold text-white text-sm hover:underline cursor-pointer truncate">{$currentTrack.title}</div>
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div 
            class="text-xs text-neutral-400 hover:underline cursor-pointer mt-0.5 min-w-0"
            on:click={() => { $currentArtist = $currentTrack.artist; $previousView = $currentView; $currentView = 'artist'; }}
          >
            <ArtistTag artist={$currentTrack.artist} />
          </div>
        </div>
        <div class="flex items-center gap-2 ml-2 relative">
          <button aria-label="Like track" class="interactive-item text-neutral-400 hover:text-white" on:click={toggleLike}>
            <Heart size={18} fill={isLiked ? "var(--color-primary)" : "none"} color={isLiked ? "var(--color-primary)" : "currentColor"} />
          </button>
          <!-- Dropdown for Playlists -->
          <div class="relative group/dropdown">
            <button aria-label="Add to Playlist" class="interactive-item text-neutral-400 hover:text-white py-2" on:click={(e) => e.stopPropagation()}>
              <Plus size={18} />
            </button>
            <div class="absolute left-0 bottom-[100%] pb-2 w-48 hidden group-hover/dropdown:block z-50">
              <div class="bg-neutral-800 border border-white/10 rounded-xl shadow-xl overflow-hidden py-2">
                <div class="px-3 pb-2 text-xs font-bold text-neutral-400 uppercase tracking-wider border-b border-white/5 mb-1">Плейлисты</div>
                {#if $playlists.length > 0}
                  {#each $playlists as pl}
                    {@const isInPlaylist = pl.tracks && pl.tracks.some((t: any) => (t.id && t.id === $currentTrack.id) || (t.title === $currentTrack.title && t.artist === $currentTrack.artist))}
                    <button class="w-full text-left flex items-center justify-between px-3 py-2 text-sm text-white hover:bg-white/10" on:click|stopPropagation={(e) => isInPlaylist ? removeFromPlaylist(e, $currentTrack, pl.id) : addToPlaylist(e, $currentTrack, pl.id)}>
                      <span class="truncate pr-2">{pl.title}</span>
                      {#if isInPlaylist}
                        <Check size={16} class="text-primary flex-shrink-0" />
                      {/if}
                    </button>
                  {/each}
                {:else}
                  <div class="w-full text-left px-3 py-2 text-sm text-neutral-500">
                    Нет плейлистов
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </div>
      {:else}
        <div class="w-14 h-14 bg-white/5 rounded-xl flex-shrink-0"></div>
        <div class="flex flex-col gap-2 w-full max-w-[120px]">
          <div class="w-full h-3 bg-white/5 rounded-full"></div>
          <div class="w-2/3 h-2 bg-white/5 rounded-full"></div>
        </div>
      {/if}
    </div>

    <!-- Controls -->
    <div class="flex flex-col items-center justify-center w-[40%] max-w-[600px] px-4">
      <div class="flex items-center gap-6 mb-2">
        <button 
          aria-label="Shuffle" 
          class="transition {isShuffle ? 'text-primary' : 'text-neutral-400 hover:text-white'}"
          on:click={() => isShuffle = !isShuffle}
        >
          <Shuffle size={18} />
        </button>
        <button aria-label="Skip Back" class="text-neutral-200 hover:text-white interactive-item" on:click={playPrev}><SkipBack size={20} /></button>
        
        <!-- Play Button -->
        <button 
          aria-label="Play or Pause"
          class="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center interactive-item hover:scale-105 active:scale-95 shadow-md disabled:opacity-50 relative group/play"
          on:click={() => $isPlaying = !$isPlaying}
          disabled={!$currentTrack}
        >
          <div class="absolute inset-0 rounded-full bg-primary/40 blur-md opacity-0 group-hover/play:opacity-100 transition-opacity pointer-events-none"></div>
          {#if $isPlaying}
            <Pause size={16} fill="black" class="z-10" />
          {:else}
            <Play size={16} fill="black" class="ml-1 z-10" />
          {/if}
        </button>

        <button aria-label="Skip Forward" class="text-neutral-200 hover:text-white interactive-item" on:click={playNext}><SkipForward size={20} /></button>
        <button 
          aria-label="Repeat" 
          class="interactive-item transition {repeatMode > 0 ? 'text-primary' : 'text-neutral-400 hover:text-white'} relative"
          on:click={() => repeatMode = (repeatMode + 1) % 3}
        >
          <Repeat size={18} />
          {#if repeatMode === 2}
            <span class="absolute -top-1 -right-1 text-[8px] font-bold bg-primary text-black w-3 h-3 flex items-center justify-center rounded-full">1</span>
          {/if}
        </button>
      </div>
      
      <!-- Progress Bar -->
      <div class="w-full flex items-center gap-3 text-[11px] font-mono text-neutral-400">
        <span class="w-10 text-right">{formatTime(currentTime)}</span>
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="group flex-1 h-5 flex items-center cursor-pointer relative py-1" on:click={handleSeek}>
          <div class="w-full h-[4px] bg-white/10 rounded-full overflow-hidden relative">
            <div 
              class="h-full bg-white rounded-full group-hover:bg-primary transition-colors pointer-events-none"
              style="width: {duration ? (currentTime / duration) * 100 : 0}%"
            ></div>
          </div>
          <!-- Hover Dot -->
          <div 
            class="absolute h-3.5 w-3.5 bg-white rounded-full opacity-0 group-hover:opacity-100 shadow-md pointer-events-none transition-opacity top-1/2 -translate-y-1/2 -ml-[7px]"
            style="left: {duration ? (currentTime / duration) * 100 : 0}%"
          ></div>
        </div>
        <span class="w-10">{formatTime(duration)}</span>
      </div>
    </div>

    <!-- Right Controls -->
    <div class="w-[30%] flex justify-end items-center gap-4 text-neutral-400 pr-2 min-w-[180px]">
      {#if !isDownloaded}
        <button aria-label="Download" class="interactive-item hover:text-white transition-colors" on:click={handleDownload} title="Скачать" disabled={isDownloading}>
          {#if isDownloading}
            <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          {:else}
            <Download size={18} />
          {/if}
        </button>
      {:else}
        <div class="interactive-item text-primary transition-colors cursor-default flex items-center justify-center" title="Скачан">
          <Check size={18} />
        </div>
      {/if}

      <button aria-label="Share" class="interactive-item hover:text-white transition-colors" on:click={handleShare} title="Поделиться">
        <Share2 size={18} />
      </button>
      
      <div class="flex items-center gap-2 group w-24 py-2 group/vol">
        <Volume2 size={18} class="group-hover:text-white transition" />
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="w-full flex items-center cursor-pointer h-6 relative" on:click={handleVolume} on:wheel={handleWheel}>
            <div class="w-full h-[4px] bg-white/10 rounded-full relative pointer-events-none group-hover/vol:bg-white/20 transition-colors">
              <div 
                class="absolute left-0 top-0 h-full bg-white rounded-full group-hover:bg-primary transition-colors" 
                style="width: {$globalVolume * 100}%"
              ></div>
              <!-- Volume Hover Dot -->
              <div 
                class="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none -ml-1.5"
                style="left: {$globalVolume * 100}%"
              ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
