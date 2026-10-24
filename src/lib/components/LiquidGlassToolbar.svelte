<script lang="ts">
  import { tick } from 'svelte';
  import { scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Ellipsis, ChevronLeft, ChevronRight, PanelLeft, ListMusic, Mic2, Settings, Sliders, Plus } from 'lucide-svelte';
  import { currentView, currentTrack, queue, navHistory, navFuture, settings, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  const quality = $derived($effectivePerformanceMode || $settings.glassMaterial === 'matte' ? 'off' : $settings.glassQuality || 'normal');
  import { glassSidebarOpen, glassQueueOpen, glassPanelMode, showGlassLyrics, toggleGlassQueue } from '$lib/liquidGlass';
  import PlaylistMenu from './PlaylistMenu.svelte';
  let { back, forward }: { back: () => void; forward: () => void } = $props();
  let menu = $state(false);
  let menuMotion = $state(false);
  let root: HTMLDivElement;
  let menuTrigger: HTMLButtonElement;
  let menuRoot = $state<HTMLDivElement>();
  function closeMenu(restoreFocus = false) {
    menu = false;
    if (restoreFocus) menuTrigger?.focus({ preventScroll: true });
  }
  async function toggleMenu(event: MouseEvent) {
    menuMotion = event.detail > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    menu = !menu;
    if (menu && event.detail === 0) {
      await tick();
      menuRoot?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }
</script>
<svelte:window onpointerdown={event => { if (event.target instanceof Node && !root?.contains(event.target)) closeMenu(); }} onkeydowncapture={event => { if (menu && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menuMotion = false; closeMenu(true); } }} />
<div class="lg-toolbar" data-tauri-drag-region bind:this={root}>
  <div class="lg-toolbar-left">
    <button bind:this={menuTrigger} class="lg-circle lg-optical" use:glassRefraction={quality} aria-label="Меню приложения" title="Меню приложения" aria-expanded={menu} aria-controls="lg-app-menu" onclick={toggleMenu}><Ellipsis size={17} /></button>
    <div class="lg-capsule lg-optical" use:glassRefraction={quality}><button aria-label="Назад" title="Назад" disabled={!$navHistory.length} onclick={back}><ChevronLeft size={18} /></button><button aria-label="Вперёд" title="Вперёд" disabled={!$navFuture.length} onclick={forward}><ChevronRight size={18} /></button></div>
    <button class="lg-circle lg-optical" use:glassRefraction={quality} aria-label="Показать или скрыть боковое меню" title={$glassSidebarOpen ? 'Скрыть боковое меню' : 'Показать боковое меню'} aria-pressed={$glassSidebarOpen} onclick={() => $glassSidebarOpen = !$glassSidebarOpen}><PanelLeft size={16} /></button>
  </div>
  <div class="lg-capsule lg-toolbar-right lg-optical" use:glassRefraction={quality}>
    {#if $currentTrack}<PlaylistMenu track={$currentTrack} buttonClass="lg-toolbar-add" placement="bottom" />{:else}<button aria-label="Добавить трек в плейлист" disabled><Plus size={16} /></button>{/if}
    <button aria-label="Текст песни" title="Текст песни" aria-pressed={$glassQueueOpen && $glassPanelMode === 'lyrics'} onclick={showGlassLyrics}><Mic2 size={16} /></button>
    <button class="lg-queue-toggle" aria-label="Показать или скрыть очередь" title={$glassQueueOpen && $glassPanelMode === 'queue' ? 'Скрыть очередь' : 'Показать очередь'} aria-pressed={$glassQueueOpen && $glassPanelMode === 'queue'} onclick={toggleGlassQueue}><ListMusic size={17} />{#if $queue.length}<span class="lg-notification-dot" aria-hidden="true"></span>{/if}</button>
  </div>
  {#if menu}<div id="lg-app-menu" bind:this={menuRoot} class="lg-popover lg-toolbar-menu lg-optical" use:glassRefraction={quality} transition:scale={{ start: .96, duration: menuMotion && !$effectivePerformanceMode ? 200 : 0, easing: cubicOut }} inert={!menu}><button onclick={() => { closeMenu(true); currentView.set('settings'); }}><Settings size={15} />Настройки</button><button onclick={() => { closeMenu(true); currentView.set('equalizer'); }}><Sliders size={15} />Эквалайзер</button></div>{/if}
</div>
