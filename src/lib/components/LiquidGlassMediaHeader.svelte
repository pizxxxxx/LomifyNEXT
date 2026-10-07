<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Play, Pause, Shuffle, Plus, Ellipsis, Disc3, User, Check } from 'lucide-svelte';
  import { playlists, notify, settings, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  import ArtistTag from './ArtistTag.svelte';
  let { title, cover = '', artist = '', avatar = '', genre = '', year, tracks, playing = false, verified = false, onplay, onshuffle, artwork, actions, id }: {
    title: string; cover?: string; artist?: string; avatar?: string; genre?: string; year?: number | string;
    tracks: any[]; playing?: boolean; verified?: boolean; onplay: () => void; onshuffle: () => void; artwork?: Snippet; actions?: Snippet; id?: string;
  } = $props();
  let menu = $state(false);
  let root: HTMLElement;
  const trackKey = (track: any) => `${track.source}:${track.id || `${track.artist}:${track.title}`}`;
  function add() {
    const existing = $playlists.some(playlist => playlist.title === title && playlist.tracks?.length === tracks.length && playlist.tracks.every((track: any, index: number) => trackKey(track) === trackKey(tracks[index])));
    if (existing) { notify('Эта подборка уже в медиатеке.', 'info'); return; }
    playlists.update(items => [...items, { id: `glass-${Date.now()}`, title, tracks: [...tracks] }]);
    notify('Подборка добавлена в медиатеку.', 'success');
  }
</script>
<svelte:window onpointerdown={event => { if (event.target instanceof Node && !root?.contains(event.target)) menu = false; }} onkeydowncapture={event => { if (menu && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu = false; } }} />
<header class="lg-media-header" bind:this={root}>
  <div class="lg-media-art">{#if artwork}{@render artwork()}{:else if cover}<img src={cover} alt={title} />{:else}<Disc3 size={70} />{/if}</div>
  <div class="lg-media-copy">
    <h1 {id}>{title}</h1>
    {#if artist}<div class="lg-media-artist">{#if avatar}<img src={avatar} alt="" width="22" height="22" />{:else}<User size={20} />{/if}<ArtistTag {artist} />{#if verified}<Check size={14} aria-label="Проверенный артист" />{/if}</div>{/if}
    <div class="lg-media-chips">{#if genre}<span>{genre}</span>{/if}{#if year}<span>{year}</span>{/if}<span>{tracks.length} треков</span></div>
    <div class="lg-media-actions">
      <button class="lg-pastel" disabled={!tracks.length} onclick={onplay}>{#if playing}<Pause size={15} fill="currentColor" />{:else}<Play size={15} fill="currentColor" />{/if}{playing ? 'Пауза' : 'Играть'}</button>
      <button class="lg-pastel" disabled={!tracks.length} onclick={onshuffle}><Shuffle size={15} />Вперемешку</button>
      <span class="lg-media-actions-space"></span>
      <button class="lg-pastel" disabled={!tracks.length} onclick={add}><Plus size={15} />Добавить</button>
      <button class="lg-pastel lg-media-more" aria-label="Действия с подборкой" aria-expanded={menu} onclick={() => menu = !menu}><Ellipsis size={17} /></button>
    </div>
    {#if menu}<div class="lg-popover lg-media-menu lg-optical" use:glassRefraction={$effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal'}>{#if actions}{@render actions()}{:else}<button onclick={() => { add(); menu = false; }}><Plus size={15} />В медиатеку</button>{/if}</div>{/if}
  </div>
</header>
