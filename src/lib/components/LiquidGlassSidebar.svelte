<script lang="ts">
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Home, Search, Radio, ChevronRight, ChevronDown, Library, Heart, Plus, Folder, User, Settings, Sliders, Music2, ThumbsDown, Mic2 } from 'lucide-svelte';
  import { currentView, activeLibraryTab, searchQuery, playlists, settings, effectivePerformanceMode, type LibraryTab } from '$lib/stores';
  import { glassLibraryRequest, glassSidebarOpen, glassPanelMode, glassQueueOpen, showGlassLyrics } from '$lib/liquidGlass';
  let libraryOpen = $state(true);
  let query = $state('');
  const playlistsOpen = $derived(!$settings.glassPlaylistsCollapsed);
  function sectionDuration() {
    return $effectivePerformanceMode || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.inputMode === 'keyboard' ? 0 : 200;
  }
  function library(tab: LibraryTab, playlistId?: string, create = false) {
    activeLibraryTab.set(tab);
    glassLibraryRequest.set(playlistId || create ? { playlistId, create } : null);
    currentView.set('library');
  }
  const name = $derived($settings.scUser?.username || $settings.yandexUser?.displayName || $settings.customProfileName || 'Мой профиль');
  const avatar = $derived($settings.scUser?.avatarUrl || $settings.yandexUser?.avatarUrl);
</script>
{#if $glassSidebarOpen}
  <aside class="lg-sidebar" aria-label="Навигация">
    <form class="lg-sidebar-search" onsubmit={event => { event.preventDefault(); searchQuery.set(query.trim()); currentView.set('search'); }}>
      <input aria-label="Поиск музыки" placeholder="Поиск" bind:value={query} />
      <button type="submit" aria-label="Найти музыку"><Search size={14} /></button>
    </form>
    <nav aria-label="Музыка">
      <button class:active={$currentView === 'home'} onclick={() => currentView.set('home')}><Home size={16} />Главная</button>
      <button class:active={$currentView === 'search'} onclick={() => currentView.set('search')}><Search size={16} />Поиск</button>
      <button class:active={$currentView === 'wave'} onclick={() => currentView.set('wave')}><Radio size={16} />Моя волна</button>
      <button class:active={$glassQueueOpen && $glassPanelMode === 'lyrics'} onclick={showGlassLyrics}><Mic2 size={16} />Текст песни</button>
      <button class="lg-sidebar-heading" aria-expanded={libraryOpen} aria-controls="lg-sidebar-library" onclick={() => libraryOpen = !libraryOpen}>Медиатека <ChevronDown size={13} class="lg-section-chevron" /></button>
      {#if libraryOpen}
        <div id="lg-sidebar-library" class="lg-sidebar-group" inert={!libraryOpen} transition:slide={{ duration: sectionDuration(), easing: cubicOut }}>
        <button onclick={() => library('liked')}><Heart size={16} />Любимые треки</button>
        <button onclick={() => library('artists')}><User size={16} />Артисты</button>
        <button onclick={() => library('local')}><Music2 size={16} />Локальные файлы</button>
        <button onclick={() => library('disliked')}><ThumbsDown size={16} />Скрытые треки</button>
        </div>
      {/if}
      <button class="lg-sidebar-heading" aria-expanded={playlistsOpen} aria-controls="lg-sidebar-playlists" onclick={() => settings.update(s => ({ ...s, glassPlaylistsCollapsed: !s.glassPlaylistsCollapsed }))}>Плейлисты <ChevronDown size={13} class="lg-section-chevron" /></button>
      {#if playlistsOpen}<div id="lg-sidebar-playlists" class="lg-sidebar-group" inert={!playlistsOpen} transition:slide={{ duration: sectionDuration(), easing: cubicOut }}>
      <button onclick={() => library('playlists', undefined, true)}><Plus size={16} />Создать</button>
      <button onclick={() => library('playlists')}><Library size={16} />Все плейлисты</button>
      <button onclick={() => library('liked')}><Heart size={16} />Любимые треки</button>
      {#each $playlists as playlist (playlist.id)}<button title={playlist.title} onclick={() => library('playlists', playlist.id)}><Folder size={16} /><span>{playlist.title}</span><ChevronRight size={12} /></button>{/each}
      </div>{/if}
      <span class="lg-sidebar-heading">Управление</span>
      <button class:active={$currentView === 'settings'} onclick={() => currentView.set('settings')}><Settings size={16} />Настройки</button>
      <button onclick={() => currentView.set('equalizer')}><Sliders size={16} />Эквалайзер</button>
      <button class:active={$glassQueueOpen && $glassPanelMode === 'support'} aria-expanded={$glassQueueOpen && $glassPanelMode === 'support'} onclick={() => { glassPanelMode.set('support'); glassQueueOpen.set(true); }}><Heart size={16}/>Поддержать</button>
    </nav>
    <button class="lg-sidebar-profile" class:active={$currentView === 'profile'} aria-current={$currentView === 'profile' ? 'page' : undefined} onclick={() => currentView.set('profile')}>
      {#if avatar}<img src={avatar} alt="" width="28" height="28" />{:else}<User size={20} />{/if}<span>{name}</span>
    </button>
  </aside>
{/if}
