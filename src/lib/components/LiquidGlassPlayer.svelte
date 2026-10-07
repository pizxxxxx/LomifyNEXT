<script lang="ts">
  import { Shuffle, SkipBack, SkipForward, Repeat, Play, Pause, Heart, ListMusic, Volume2, Maximize2, Minimize2, Share2, Music2, Settings2 } from 'lucide-svelte';
  import { currentTrack, currentView, isPlaying, globalVolume, likedTracks, settings, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  import { glassQueueOpen, glassPanelMode, toggleGlassQueue, playbackShuffle, playbackRepeat, glassScreenSettings } from '$lib/liquidGlass';
  import { isTrackLiked } from '$lib/likes';
  import { coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';
  import PlaylistMenu from './PlaylistMenu.svelte';
  import ArtistTag from './ArtistTag.svelte';
  import TrackSourceIcon from './TrackSourceIcon.svelte';
  import LiquidGlassOutput from './LiquidGlassOutput.svelte';
  import UncensoredButton from './UncensoredButton.svelte';
  import { volumeAfterWheel } from '$lib/utils/wheelVolume';
  let { elapsed, total, onseek, onvolume, onprev, onnext, onlike, onfullscreen, onshare }: {
    elapsed: number; total: number; onseek: (seconds: number) => void; onvolume: (ratio: number) => void;
    onprev: () => void; onnext: () => void; onlike: () => void; onfullscreen: () => void; onshare: () => void;
  } = $props();
  const cover = $derived(coverUrlForTrack($currentTrack, $downloadedCoverCache));
  const liked = $derived(isTrackLiked($likedTracks, $currentTrack));
  let scrub = $state<number | null>(null);
  const position = $derived(scrub ?? elapsed);
  const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
  function changeVolume(event: WheelEvent) {
    if (event.ctrlKey || (event.target as Element).closest('.lg-popover, .pl-menu-pop')) return;
    event.preventDefault();
    onvolume(volumeAfterWheel($globalVolume, event.deltaY, event.deltaMode));
  }
  function toggleScreenSettings(event: MouseEvent) {
    glassScreenSettings.update(state => ({
      open: !state.open,
      motion: event.detail > 0 && !$effectivePerformanceMode && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    }));
  }
</script>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="lg-player lg-optical" class:is-fullscreen={$currentView === 'fullscreen'} onwheel={changeVolume} use:glassRefraction={$effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal'}>
  <div class="lg-player-progress"><span>{time(position)}</span><input type="range" min="0" max={total || 1} step="0.1" value={Math.min(position, total)} disabled={!total} style={`--played: ${total ? Math.min(100, position / total * 100) : 0}%`} aria-label="Позиция воспроизведения" oninput={event => scrub = Number(event.currentTarget.value)} onchange={event => { onseek(Number(event.currentTarget.value)); scrub = null; }} /><span>-{time(total - position)}</span></div>
  <div class="lg-player-bottom">
    <div class="lg-player-controls">
      <button aria-label="Перемешивание" aria-pressed={$playbackShuffle} class:is-active={$playbackShuffle} onclick={() => $playbackShuffle = !$playbackShuffle}><Shuffle size={15} /></button>
      <button aria-label="Предыдущий трек" onclick={onprev}><SkipBack size={18} /></button>
      <button class="lg-player-play" aria-label={$isPlaying ? 'Пауза' : 'Играть'} disabled={!$currentTrack} onclick={() => isPlaying.set(!$isPlaying)}>{#if $isPlaying}<Pause size={24} fill="currentColor" />{:else}<Play size={24} fill="currentColor" />{/if}</button>
      <button aria-label="Следующий трек" onclick={onnext}><SkipForward size={18} /></button>
      <button aria-label={`Повтор: ${$playbackRepeat === 0 ? 'выключен' : $playbackRepeat === 1 ? 'всё' : 'один трек'}`} class:is-active={$playbackRepeat > 0} onclick={() => $playbackRepeat = ($playbackRepeat + 1) % 3}><Repeat size={15} />{#if $playbackRepeat === 2}<small>1</small>{/if}</button>
      <button aria-label={liked ? 'Убрать из любимых' : 'В любимые'} aria-pressed={liked} class:lg-liked={liked} disabled={!$currentTrack} onclick={onlike}><Heart size={15} fill={liked ? 'currentColor' : 'none'} /></button>
      {#if $currentTrack}<PlaylistMenu track={$currentTrack} iconSize={15} star={true} placement="top" buttonClass="lg-player-favourite" />{/if}
      <button aria-label="Очередь" aria-pressed={$glassQueueOpen && $glassPanelMode === 'queue'} onclick={toggleGlassQueue}><ListMusic size={15} /></button>
      {#if $currentTrack?.source === 'yandex'}{#key $currentTrack.id}<UncensoredButton track={$currentTrack} compact={true} />{/key}{/if}
      {#if $currentView === 'fullscreen'}<span class="lg-player-inline-time">{time(position)} / -{time(total - position)}</span>{/if}
    </div>
    <div class="lg-player-track">
      {#if $currentTrack}
        {#if cover}<img src={cover} alt="" width="26" height="26" />{/if}
        <div class="lg-player-track-copy"><strong>{$currentTrack.title}</strong><span><ArtistTag artist={$currentTrack.artist} artists={$currentTrack.artists} /></span></div>
        <div class="lg-player-track-tools"><TrackSourceIcon source={$currentTrack.source} size={10} /><button aria-label="Поделиться треком" onclick={onshare}><Share2 size={10} /></button></div>
      {:else}<Music2 size={23} aria-hidden="true" /><span class="lg-player-placeholder" aria-hidden="true"><i></i><i></i></span><span class="sr-only">Нет текущего трека</span>{/if}
    </div>
    <div class="lg-player-output"><Volume2 size={14} /><input type="range" min="0" max="1" step="0.01" value={$globalVolume} aria-label="Громкость" oninput={event => onvolume(Number(event.currentTarget.value))} /><LiquidGlassOutput />
      {#if $currentView === 'fullscreen'}<button class="lg-screen-settings-trigger" class:is-active={$glassScreenSettings.open} aria-label="Настройки полноэкранного режима" aria-expanded={$glassScreenSettings.open} aria-controls="fullscreen-settings-pop" disabled={!$currentTrack} onclick={toggleScreenSettings}><Settings2 size={16} /></button>{/if}
      <button aria-label={$currentView === 'fullscreen' ? 'Выйти из полного экрана' : 'Полный экран'} onclick={onfullscreen}>{#if $currentView === 'fullscreen'}<Minimize2 size={16} />{:else}<Maximize2 size={16} />{/if}</button></div>
  </div>
</div>
