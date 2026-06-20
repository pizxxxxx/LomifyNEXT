<script lang="ts">
  import { onMount } from 'svelte';
  import { Home, Search, Library, Settings, Sliders, User } from '@lucide/svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { currentView, settings } from '$lib/stores';

  let osUsername = 'User';
  $: scUsername = $settings.scUser?.username || '';
  
  $: displayUsername = scUsername || $settings.customProfileName || osUsername;

  onMount(async () => {
    try {
      if (window && '__TAURI_INTERNALS__' in window) {
        osUsername = await invoke('get_os_username');
      }
    } catch (e) {
      console.error(e);
    }
  });
</script>

<aside 
  class="w-64 {$settings.uiStyle === 'style3' ? 'border-white/10' : ($settings.uiStyle === 'style1' ? 'bg-white/10 border-white/20' : 'bg-black/40 border-white/10')} backdrop-blur-xl flex flex-col py-8 px-5 z-10 transition-colors duration-[400ms] mx-6 mt-8 mb-32 rounded-[2rem] relative overflow-hidden interactive-item group shadow-2xl border">
  <div class="text-[32px] font-extrabold tracking-tight mb-10 px-1 flex flex-col items-center justify-center whitespace-nowrap w-full relative">
    <img src="/lomimi.png?v=2" alt="Logo" class="w-28 h-28 object-contain drop-shadow-xl z-0" />
    <span class="flex items-center -mt-5 z-10 drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)]">Lomify<span class="text-white/40">NEXT</span></span>
  </div>

  <nav class="flex-1 space-y-3">
    <button 
      class="w-full flex items-center gap-4 px-4 py-3 rounded-2xl font-medium transition-all duration-300 relative group/btn {$currentView === 'home' ? 'bg-white/10 text-white shadow-inner' : 'text-neutral-400 hover:text-white hover:bg-white/5'}"
      on:click={() => currentView.set('home')}
    >
      {#if $currentView === 'home'}
        <div class="absolute left-2 top-1/2 -translate-y-1/2 w-1.5 h-1/2 bg-primary rounded-full shadow-[0_0_8px_var(--color-primary)]"></div>
      {/if}
      <Home size={20} class="group-hover/btn:scale-110 transition-transform" />
      Главная
    </button>
    
    <button 
      class="w-full flex items-center gap-4 px-4 py-3 rounded-2xl font-medium transition-all duration-300 relative group/btn {$currentView === 'search' ? 'bg-white/10 text-white shadow-inner' : 'text-neutral-400 hover:text-white hover:bg-white/5'}"
      on:click={() => currentView.set('search')}
    >
      {#if $currentView === 'search'}
        <div class="absolute left-2 top-1/2 -translate-y-1/2 w-1.5 h-1/2 bg-primary rounded-full shadow-[0_0_8px_var(--color-primary)]"></div>
      {/if}
      <Search size={20} class="group-hover/btn:scale-110 transition-transform" />
      Поиск
    </button>
    
    <button 
      class="w-full flex items-center gap-4 px-4 py-3 rounded-2xl font-medium transition-all duration-300 relative group/btn {$currentView === 'library' ? 'bg-white/10 text-white shadow-inner' : 'text-neutral-400 hover:text-white hover:bg-white/5'}"
      on:click={() => currentView.set('library')}
    >
      {#if $currentView === 'library'}
        <div class="absolute left-2 top-1/2 -translate-y-1/2 w-1.5 h-1/2 bg-primary rounded-full shadow-[0_0_8px_var(--color-primary)]"></div>
      {/if}
      <Library size={20} class="group-hover/btn:scale-110 transition-transform" />
      Медиатека
    </button>
  </nav>

  <div class="mt-auto flex flex-col gap-2">
    <button 
      class="w-full flex items-center gap-4 px-4 py-3 rounded-2xl font-medium transition-all duration-300 relative group/btn {$currentView === 'equalizer' ? 'bg-white/10 text-white shadow-inner' : 'text-neutral-400 hover:text-white hover:bg-white/5'}"
      on:click={() => currentView.set('equalizer')}
    >
      {#if $currentView === 'equalizer'}
        <div class="absolute left-2 top-1/2 -translate-y-1/2 w-1.5 h-1/2 bg-primary rounded-full shadow-[0_0_8px_var(--color-primary)]"></div>
      {/if}
      <Sliders size={20} class="group-hover/btn:scale-110 transition-transform" />
      Эквалайзер
    </button>
    <button 
      class="w-full flex items-center gap-4 px-4 py-3 rounded-2xl font-medium transition-all duration-300 relative group/btn {$currentView === 'settings' ? 'bg-white/10 text-white shadow-inner' : 'text-neutral-400 hover:text-white hover:bg-white/5'}"
      on:click={() => currentView.set('settings')}
    >
      {#if $currentView === 'settings'}
        <div class="absolute left-2 top-1/2 -translate-y-1/2 w-1.5 h-1/2 bg-primary rounded-full shadow-[0_0_8px_var(--color-primary)]"></div>
      {/if}
      <Settings size={20} class="group-hover/btn:scale-110 transition-transform" />
      Настройки
    </button>
    
    <div class="mt-4 pt-4 border-t border-white/10 flex justify-center">
      <button 
        class="w-14 h-14 rounded-full bg-gradient-to-br from-primary to-green-600 text-black font-bold text-2xl flex items-center justify-center shadow-lg hover:scale-110 transition-transform overflow-hidden {$currentView === 'profile' ? 'ring-4 ring-primary/50' : ''}"
        on:click={() => currentView.set('profile')}
        title="Профиль ({displayUsername})"
      >
        {#if $settings.scUser?.avatarUrl}
          <img src={$settings.scUser.avatarUrl} alt="Avatar" class="w-full h-full object-cover" />
        {:else}
          {displayUsername.charAt(0).toUpperCase()}
        {/if}
      </button>
    </div>
  </div>
</aside>
