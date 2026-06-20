<script lang="ts">
  import { currentTrack, currentView, previousView, settings } from '$lib/stores';
  import { Maximize2, Minimize2, AlignLeft, AlignCenter, Settings2 } from 'lucide-svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onMount, onDestroy } from 'svelte';
  import Lyrics from './Lyrics.svelte';
  import ArtistTag from './ArtistTag.svelte';

  let canvas: HTMLCanvasElement;
  let unlistenFft: UnlistenFn;


  let showLyrics = $settings.showLyricsByDefault ?? true;
  let showSettings = false;

  $: {
    if (typeof window !== 'undefined' && $settings.playbackRate) {
       invoke('audio_set_playback_rate', { rate: Number($settings.playbackRate) }).catch(console.error);
    }
  }

  onMount(async () => {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      unlistenFft = await listen<number[]>('audio:fft', (event) => {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        // ensure canvas dimensions match its physical size
        if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        }

        const bins = event.payload; // 64 bins
        const width = canvas.width;
        const height = canvas.height;
        
        ctx.clearRect(0, 0, width, height);
        
        const barCount = bins.length;
        const barWidth = (width / barCount);
        
        for (let i = 0; i < barCount; i++) {
          // values are 0-255. Let's make it a nice curved visualizer at the bottom
          const v = bins[i] / 255.0;
          // Apply a slight power curve so loud beats pop more
          const intensity = Math.pow(v, 1.5);
          const barHeight = intensity * height * 0.4;
          
          const x = i * barWidth;
          const y = height - barHeight;
          
          ctx.fillStyle = `rgba(255, 255, 255, ${v * 0.4})`;
          ctx.beginPath();
          ctx.roundRect(x + 2, y, barWidth - 4, barHeight, [8, 8, 0, 0]);
          ctx.fill();
        }
      });
    }
  });

  onDestroy(() => {
    if (unlistenFft) unlistenFft();
  });
</script>

<div class="relative w-full h-full flex items-center justify-center animate-in fade-in duration-500">
  {#if $currentTrack}
    <div class="absolute inset-0 z-0 pointer-events-none overflow-hidden">
      <img src={$currentTrack.coverUrl} alt="bg" class="w-full h-full object-cover blur-[100px] scale-150 opacity-40 transition-transform duration-1000" />
      <div class="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-[var(--color-dark)]"></div>
      <canvas bind:this={canvas} class="absolute inset-0 w-full h-full opacity-60"></canvas>
    </div>
    
    <div class="absolute top-8 right-8 z-50 flex gap-4">
      <div class="relative">
        <button 
          class="w-12 h-12 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center backdrop-blur-md transition-colors {showSettings ? 'bg-white/20 text-primary' : 'text-white'}"
          on:click={() => showSettings = !showSettings}
          aria-label="Settings"
        >
          <Settings2 size={24} />
        </button>
        
        {#if showSettings}
          <div class="absolute top-14 right-0 w-64 bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl p-5 shadow-2xl flex flex-col gap-6 origin-top-right animate-in zoom-in-95 duration-200">
            <div class="flex flex-col gap-2">
              <div class="flex justify-between items-center text-sm">
                <span class="text-white/70 font-medium">Смещение текста (мс)</span>
                <div class="flex items-center gap-2">
                  <button class="text-xs text-white/40 hover:text-white transition-colors" on:click={() => $settings.lyricsOffset = 0}>сброс</button>
                  <span class="text-white font-mono bg-white/10 px-2 py-0.5 rounded">{$settings.lyricsOffset || 0}</span>
                </div>
              </div>
              <input 
                type="range" 
                min="-5000" max="5000" step="50" 
                bind:value={$settings.lyricsOffset} 
                class="w-full accent-primary"
              />
            </div>
          
            <div class="flex flex-col gap-2">
              <div class="flex justify-between items-center text-sm">
                <span class="text-white/70 font-medium">Скорость трека</span>
                <div class="flex items-center gap-2">
                  <button class="text-xs text-white/40 hover:text-white transition-colors" on:click={() => $settings.playbackRate = 1.0}>сброс</button>
                  <span class="text-white font-mono bg-white/10 px-2 py-0.5 rounded">{($settings.playbackRate || 1.0).toFixed(2)}x</span>
                </div>
              </div>
              <input 
                type="range" 
                min="0.5" max="2.0" step="0.05" 
                bind:value={$settings.playbackRate} 
                class="w-full accent-primary"
              />
              <div class="w-full relative text-[10px] text-white/40 font-mono px-1 h-4 mt-1">
                <span class="absolute left-0">0.5x</span>
                <span class="absolute left-1/3 -translate-x-1/2">1.0x</span>
                <span class="absolute right-0">2.0x</span>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <button 
        class="w-12 h-12 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center backdrop-blur-md transition-colors"
        on:click={() => { $currentView = $previousView; }}
        aria-label="Exit Fullscreen"
      >
        <Minimize2 size={24} />
      </button>
    </div>

    <div class="z-10 flex flex-row w-full max-w-6xl h-[70vh] items-center justify-center transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]" style="gap: {showLyrics ? '3rem' : '0'}">
      
      <!-- Cover side -->
      <div class="flex flex-col transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] {showLyrics ? 'w-1/2 items-end' : 'w-full items-center'}">
        <div class="relative group transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] {showLyrics ? 'w-[45vh] h-[45vh] rounded-2xl mb-8 shadow-2xl' : 'w-[55vh] h-[55vh] rounded-3xl mb-12 shadow-[0_20px_50px_rgba(0,0,0,0.5)]'} overflow-hidden">
          <img src={$currentTrack.coverUrl} alt="Cover" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
          
          <!-- Hover Overlay -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div 
            class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center backdrop-blur-sm cursor-pointer z-10"
            on:click={() => showLyrics = !showLyrics}
          >
            <div class="flex flex-col items-center gap-3 text-white transform scale-90 group-hover:scale-100 transition-transform duration-300">
              {#if showLyrics}
                <AlignCenter size={48} />
                <span class="font-bold text-xl tracking-wide">Скрыть текст</span>
              {:else}
                <AlignLeft size={48} />
                <span class="font-bold text-xl tracking-wide">Показать текст</span>
              {/if}
            </div>
          </div>
        </div>
        
        <div class="transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] flex flex-col {showLyrics ? 'w-[45vh] items-start text-left' : 'w-[60vh] items-center text-center'}">
          <h2 class="font-extrabold truncate mb-2 transition-all duration-700 w-full {showLyrics ? 'text-4xl' : 'text-5xl'}">{$currentTrack.title}</h2>
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div class="text-white/60 truncate transition-all duration-700 hover:text-white hover:underline cursor-pointer w-fit {showLyrics ? 'text-xl' : 'text-2xl'}" on:click={() => { $currentView = 'artist'; }}>
            <ArtistTag artist={$currentTrack.artist} />
          </div>
        </div>
      </div>
      
      <!-- Lyrics side -->
      <div 
        class="h-full glass-panel rounded-3xl overflow-hidden relative transition-all duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
        style="width: {showLyrics ? '50%' : '0px'}; opacity: {showLyrics ? 1 : 0}; padding: {showLyrics ? '2rem' : '0'}; transform: translateX({showLyrics ? '0' : '50px'})"
      >
        <div class="w-full h-full min-w-[400px]">
          {#if showLyrics}
            <Lyrics />
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="z-10 text-xl text-white/50">Нет активного трека</div>
  {/if}
</div>
