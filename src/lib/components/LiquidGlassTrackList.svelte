<script lang="ts">
  import { scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Check, Ellipsis, Heart, Music2, Play, Pause, ThumbsDown, Download, Trash2, FolderDown } from 'lucide-svelte';
  import { currentTrack, isPlaying, likedTracks, dislikedTracks, playlists, listenStats, notify, settings, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  import { setTrackDisliked, isTrackDisliked } from '$lib/dislikes';
  import { isTrackLiked, setTrackLiked } from '$lib/likes';
  import { formatTrackDuration } from '$lib/utils/artistTracks';
  import { coverUrlAtSize } from '$lib/offlineCovers';
  import TrackSourceIcon from './TrackSourceIcon.svelte';
  import PlaylistMenu from './PlaylistMenu.svelte';
  import ArtistTag from './ArtistTag.svelte';
  import TrackWaveButton from './TrackWaveButton.svelte';
  let { tracks, onplay, top = false, artwork = false, indices, ondownload, onremove, onexport, isdownloaded }: { tracks: any[]; onplay: (track: any, tracks: any[]) => void; top?: boolean; artwork?: boolean; indices?: number[]; ondownload?: (track: any) => void; onremove?: (track: any) => void; onexport?: (track: any) => void; isdownloaded?: (track: any) => boolean } = $props();
  let visibleCount = $state(40);
  let menuIndex = $state<number | null>(null);
  let menuAbove = $state(false);
  let menuMotion = $state(false);
  let menuRoot: HTMLDivElement;
  const visible = $derived(tracks.slice(0, top ? 9 : visibleCount));
  const key = (track: any) => `${track.source}:${track.id || `${track.artist}:${track.title}`}`;
  const inLibrary = $derived(new Set([...$likedTracks, ...$playlists.flatMap(playlist => playlist.tracks || [])].map(key)));
  const listened = $derived(new Set(Object.values($listenStats.history).map(track => `${track.artist}:${track.title}`)));
  function play(track: any) {
    if ($currentTrack && key($currentTrack) === key(track)) isPlaying.set(!$isPlaying);
    else onplay(track, tracks);
  }
</script>
<svelte:window onpointerdown={event => { if (event.target instanceof Node && !menuRoot?.contains(event.target)) menuIndex = null; }} onkeydowncapture={event => { if (menuIndex !== null && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menuMotion = false; menuIndex = null; } }} />
<div class="lg-track-list" class:is-top={top} bind:this={menuRoot}>
  {#if !top}<div class="lg-list-head"><span>Название</span><span>Источник</span><span>Время</span><span></span></div>{/if}
  {#each visible as track, index (index)}
    {@const active = $currentTrack && key($currentTrack) === key(track)}
    <div class="lg-track-row" class:is-active={active} class:has-menu={menuIndex === index}>
      <button class="lg-track-play" aria-label={active && $isPlaying ? `Пауза: ${track.title}` : `Играть: ${track.title}`} onclick={() => play(track)}>
        <span class="lg-track-number">{#if active}<span class="lg-track-dot"></span>{:else if !listened.has(`${track.artist}:${track.title}`)}<span class="lg-track-dot is-unheard"></span>{/if}{(indices?.[index] ?? index) + 1}</span>
        {#if top}
          <span class="lg-top-track-art" aria-hidden="true">
            {#if track.coverUrl}<img class="lg-track-art" src={coverUrlAtSize(track.coverUrl, 80)} alt="" width="32" height="32" loading="lazy" decoding="async" />{:else}<Music2 size={26} />{/if}
            <span class="lg-top-track-control">{#if active && $isPlaying}<Pause size={14} fill="currentColor" />{:else}<Play size={14} fill="currentColor" />{/if}</span>
          </span>
        {:else if artwork}{#if track.coverUrl}<img class="lg-track-art" src={coverUrlAtSize(track.coverUrl, 80)} alt="" width="32" height="32" loading="lazy" decoding="async" />{:else}<Music2 size={26} />{/if}{/if}
        <span class="lg-track-title"><strong><span>{track.title}</span>{#if inLibrary.has(key(track))}<Check size={12} class="lg-library-check" aria-label="В медиатеке" />{/if}</strong>{#if top || artwork}<small>{track.artist}</small>{/if}</span>
      </button>
      <TrackSourceIcon source={track.source} />
      <span class="lg-track-duration">{formatTrackDuration(track.duration)}</span>
      <div class="lg-track-menu-root">
        <button class="lg-track-more" aria-label={`Действия с треком «${track.title}»`} aria-expanded={menuIndex === index} onclick={(event) => { event.stopPropagation(); menuMotion = event.detail > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches; menuAbove = event.currentTarget.getBoundingClientRect().top > innerHeight - 380; menuIndex = menuIndex === index ? null : index; }}><Ellipsis size={17} /></button>
        {#if menuIndex === index}<div class="lg-popover lg-track-menu lg-optical" class:is-top={menuAbove} use:glassRefraction={$effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal'} transition:scale={{ start: .96, duration: menuMotion && !$effectivePerformanceMode ? 200 : 0, easing: cubicOut }} inert={menuIndex !== index} role="dialog" aria-label={`Действия с треком «${track.title}»`}>
          <button onclick={() => setTrackLiked(track, !isTrackLiked($likedTracks, track))}><Heart size={15} />{isTrackLiked($likedTracks, track) ? 'Убрать из любимых' : 'В любимые'}</button>
          <PlaylistMenu {track} placement="bottom" buttonClass="lg-track-add" iconSize={15} label="Добавить в плейлист" />
          {#if ondownload && !isdownloaded?.(track)}<button onclick={() => ondownload?.(track)}><Download size={15} />Скачать</button>{/if}
          {#if onremove && (!isdownloaded || isdownloaded(track))}<button onclick={() => { onremove?.(track); menuIndex = null; }}><Trash2 size={15} />Удалить файл</button>{/if}
          {#if onexport}<button onclick={() => onexport?.(track)}><FolderDown size={15} />Экспортировать в файл</button>{/if}
          {#if !track.isLocal}<TrackWaveButton {track} iconSize={15} label="Волна по треку" />{/if}
          <button onclick={() => { const mark = !isTrackDisliked($dislikedTracks, track); void setTrackDisliked(track, mark); menuIndex = null; notify(mark ? 'Трек скрыт из рекомендаций.' : 'Трек возвращён в рекомендации.', 'info'); }}><ThumbsDown size={15} />{isTrackDisliked($dislikedTracks, track) ? 'Вернуть в рекомендации' : 'Не нравится'}</button>
          <p><ArtistTag artist={track.artist} artists={track.artists} /></p><p>{track.source === 'yandex' ? 'Яндекс Музыка' : track.source === 'soundcloud' ? 'SoundCloud' : 'Локальный файл'}</p>
        </div>{/if}
      </div>
    </div>
  {/each}
</div>
{#if !top && visibleCount < tracks.length}<button class="lg-load-more" onclick={() => visibleCount += 40}>Показать ещё</button>{/if}
