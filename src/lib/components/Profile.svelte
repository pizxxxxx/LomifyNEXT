<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listenStats, currentTrack, isPlaying, settings } from '$lib/stores';
  import { Clock, Play, Headphones, Trophy, Music, Edit2, Check } from '@lucide/svelte';

  let osUsername = 'Пользователь';
  $: scUsername = $settings.scUser?.username || ''; // Для SoundCloud интеграции
  let isEditing = false;
  let editValue = '';
  
  $: displayUsername = scUsername || $settings.customProfileName || osUsername;
  $: initial = displayUsername.charAt(0).toUpperCase();
  let totalHours = 0;
  let topTracks: any[] = [];

  onMount(async () => {
    try {
      if (window && '__TAURI_INTERNALS__' in window) {
        osUsername = await invoke('get_os_username');
      }
    } catch (e) {
      console.warn("Could not get OS username", e);
    }
  });

  function startEdit() {
    if (scUsername) return;
    isEditing = true;
    editValue = displayUsername;
  }

  function saveEdit() {
    $settings.customProfileName = editValue;
    isEditing = false;
  }

  $: {
    totalHours = Number(($listenStats.listenSeconds / 3600).toFixed(1));
    
    // Sort history by count descending
    topTracks = Object.values($listenStats.history)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  function playTrack(track: any) {
    if ($currentTrack?.title === track.title && $currentTrack?.artist === track.artist) {
      $isPlaying = !$isPlaying;
    } else {
      $currentTrack = track;
      $isPlaying = true;
    }
  }

  function formatTime(seconds: number) {
    if (seconds < 60) return `${seconds} сек`;
    const m = Math.floor(seconds / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h} ч ${m % 60} мин`;
    return `${m} мин`;
  }
</script>

<div class="h-full w-full p-8 overflow-y-auto space-y-12 pb-32">
  
  <!-- Header / Profile Badge -->
  <div class="flex items-center gap-8 bg-white/5 p-8 rounded-[2rem] border border-white/10 backdrop-blur-xl relative overflow-hidden group interactive-item">
    <div class="absolute -inset-24 bg-gradient-to-tr from-primary/20 to-blue-500/20 blur-3xl opacity-50 pointer-events-none"></div>
    
    <div class="w-32 h-32 rounded-full shadow-2xl flex items-center justify-center text-5xl font-black text-white relative z-10 overflow-hidden shrink-0 bg-gradient-to-br from-primary to-blue-600">
      {#if $settings.scUser?.avatarUrl}
        <img src={$settings.scUser.avatarUrl} alt="Avatar" class="w-full h-full object-cover" />
      {:else}
        {initial}
      {/if}
      <div class="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
    </div>
    
    <div class="z-10">
      <div class="text-sm font-bold tracking-widest text-primary mb-2 uppercase">Профиль Слушателя</div>
      
      {#if isEditing}
        <div class="flex items-center gap-3">
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" bind:value={editValue} class="bg-black/20 border border-white/20 rounded-xl px-4 py-2 text-3xl font-black text-white focus:outline-none focus:border-primary" on:keydown={(e) => e.key === 'Enter' && saveEdit()} autofocus />
          <button class="p-3 bg-primary text-black rounded-xl hover:scale-105 transition-transform" on:click={saveEdit}>
            <Check size={20} />
          </button>
        </div>
      {:else}
        <div class="flex items-center gap-4 group/name flex-wrap">
          <h1 class="text-5xl font-black text-white drop-shadow-lg flex items-center gap-4">
            {displayUsername}
            {#if ['klimentos', 'uniquebleed', 'bleed'].includes(displayUsername.toLowerCase())}
              <span class="text-[14px] font-bold px-2.5 py-1 rounded bg-orange-500/20 text-orange-400 whitespace-nowrap shrink-0 border border-orange-500/30 tracking-normal normal-case shadow-[0_0_10px_rgba(249,115,22,0.3)]">
                Team Lomify
              </span>
            {/if}
            {#if ['pizxx'].includes(displayUsername.toLowerCase())}
              <span class="text-[14px] font-bold px-2.5 py-1 rounded bg-green-500/20 text-green-400 whitespace-nowrap shrink-0 border border-green-500/30 tracking-normal normal-case shadow-[0_0_10px_rgba(34,197,94,0.3)]">
                Developer
              </span>
            {/if}
            {#if $settings.scUser?.permalink}
              <a href={$settings.scUser.permalink} target="_blank" rel="noreferrer" class="bg-[#ff5500] text-white text-sm font-bold px-3 py-1 rounded-lg flex items-center gap-1 shadow-lg hover:bg-[#ff5500]/80 transition-colors">
                SoundCloud
              </a>
            {/if}
          </h1>
          {#if !scUsername}
            <button class="opacity-0 group-hover/name:opacity-100 text-neutral-400 hover:text-white transition-opacity p-2 bg-white/5 rounded-full" on:click={startEdit}>
              <Edit2 size={18} />
            </button>
          {/if}
        </div>
      {/if}
      
      <p class="text-neutral-400 mt-2 text-lg">Добро пожаловать в вашу музыкальную статистику.</p>
    </div>
  </div>

  <!-- Stats Grid -->
  <div class="grid grid-cols-2 gap-6">
    <div class="bg-white/5 p-6 rounded-3xl border border-white/10 flex flex-col gap-2 interactive-item">
      <Clock class="text-primary mb-2" size={28} />
      <div class="text-neutral-400 text-sm font-medium">Время прослушивания</div>
      <div class="text-3xl font-black text-white">{formatTime($listenStats.listenSeconds)}</div>
    </div>
    <div class="bg-white/5 p-6 rounded-3xl border border-white/10 flex flex-col gap-2 interactive-item">
      <Headphones class="text-primary mb-2" size={28} />
      <div class="text-neutral-400 text-sm font-medium">Всего треков включено</div>
      <div class="text-3xl font-black text-white">{$listenStats.tracksPlayed}</div>
    </div>
  </div>

  <!-- Top Tracks -->
  <div>
    <div class="flex items-center gap-3 mb-6">
      <Trophy class="text-yellow-500" size={24} />
      <h2 class="text-2xl font-bold text-white">Самые прослушиваемые треки</h2>
    </div>

    {#if topTracks.length === 0}
      <div class="bg-white/5 border border-white/10 rounded-3xl p-10 flex flex-col items-center justify-center text-center gap-4">
        <Music size={48} class="text-neutral-600" />
        <h3 class="text-xl font-bold text-white">Вы пока ничего не слушали</h3>
        <p class="text-neutral-400">Идите слушать прекрасную музыку, и статистика появится здесь!</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each topTracks as track, i}
          {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
          <div class="flex items-center gap-4 p-3 rounded-2xl transition-colors group {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/10'}">
            <div class="text-neutral-500 font-bold w-6 text-center">{i + 1}</div>
            
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            {#if track.coverUrl}
              <img src={track.coverUrl} class="w-12 h-12 rounded-lg object-cover shadow-md cursor-pointer hover:scale-105 transition" alt="Cover" on:click={() => playTrack(track)} />
            {:else}
              <div class="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center cursor-pointer hover:scale-105 transition" on:click={() => playTrack(track)}>
                <Music size={20} class="text-neutral-400" />
              </div>
            {/if}
            
            <div class="flex-1 min-w-0">
              <div class="font-bold truncate text-base {isActive ? 'text-primary' : 'text-white'}">{track.title}</div>
              <div class="text-sm text-neutral-400 truncate">{track.artist}</div>
            </div>
            
            <div class="text-sm font-medium text-neutral-500 bg-black/20 px-3 py-1 rounded-full">
              Включено: <span class="text-primary">{track.count}</span> раз
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
