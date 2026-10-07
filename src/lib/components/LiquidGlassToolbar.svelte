<script lang="ts">
  import { scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Ellipsis, ChevronLeft, ChevronRight, PanelLeft, ListMusic, Mic2, Settings, Sliders, Plus } from 'lucide-svelte';
  import { currentView, currentTrack, queue, navHistory, navFuture, settings, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  const quality = $derived($effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal');
  import { glassSidebarOpen, glassQueueOpen, glassPanelMode, showGlassLyrics, toggleGlassQueue } from '$lib/liquidGlass';
  import PlaylistMenu from './PlaylistMenu.svelte';
  let { back, forward }: { back: () => void; forward: () => void } = $props();
  let menu = $state(false);
  let menuMotion = $state(false);
  let root: HTMLDivElement;
</script>
<svelte:window onpointerdown={event => { if (event.target instanceof Node && !root?.contains(event.target)) menu = false; }} onkeydowncapture={event => { if (menu && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menuMotion = false; menu = false; } }} />
<div class="lg-toolbar" data-tauri-drag-region bind:this={root}>
  <div class="lg-toolbar-left">
    <button class="lg-circle lg-optical" use:glassRefraction={quality} aria-label="Меню приложения" aria-expanded={menu} onclick={event => { menuMotion = event.detail > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches; menu = !menu; }}><Ellipsis size={17} /></button>
    <div class="lg-capsule lg-optical" use:glassRefraction={quality}><button aria-label="Назад" disabled={!$navHistory.length} onclick={back}><ChevronLeft size={18} /></button><button aria-label="Вперёд" disabled={!$navFuture.length} onclick={forward}><ChevronRight size={18} /></button></div>
    <button class="lg-circle lg-optical" use:glassRefraction={quality} aria-label="Показать или скрыть сайдбар" aria-pressed={$glassSidebarOpen} onclick={() => $glassSidebarOpen = !$glassSidebarOpen}><PanelLeft size={16} /></button>
  </div>
  <div class="lg-capsule lg-toolbar-right lg-optical" use:glassRefraction={quality}>
    {#if $currentTrack}<PlaylistMenu track={$currentTrack} buttonClass="lg-toolbar-add" placement="bottom" />{:else}<button aria-label="Добавить трек в плейлист" disabled><Plus size={16} /></button>{/if}
    <button aria-label="Текст песни" title="Текст песни" aria-pressed={$glassQueueOpen && $glassPanelMode === 'lyrics'} onclick={showGlassLyrics}><Mic2 size={16} /></button>
    <button class="lg-queue-toggle" aria-label="Показать или скрыть очередь" aria-pressed={$glassQueueOpen && $glassPanelMode === 'queue'} onclick={toggleGlassQueue}><ListMusic size={17} />{#if $queue.length}<span class="lg-notification-dot"></span>{/if}</button>
  </div>
  {#if menu}<div class="lg-popover lg-toolbar-menu lg-optical" use:glassRefraction={quality} transition:scale={{ start: .96, duration: menuMotion && !$effectivePerformanceMode ? 200 : 0, easing: cubicOut }} inert={!menu}><button onclick={() => { currentView.set('settings'); menu = false; }}><Settings size={15} />Настройки</button><button onclick={() => { currentView.set('equalizer'); menu = false; }}><Sliders size={15} />Эквалайзер</button></div>{/if}
</div>
