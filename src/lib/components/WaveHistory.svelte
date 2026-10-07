<script lang="ts">
  import { onMount } from 'svelte';
  import { scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { History, Search, X, Play, Music2 } from 'lucide-svelte';
  import { waveListeningHistory } from '$lib/waveHistory';
  import { stopWave } from '$lib/wave';
  import { currentTrack, queue, isPlaying, settings, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  import { coverUrlAtSize } from '$lib/offlineCovers';
  import { normalizeSearchText } from '$lib/utils/searchText';
  import TrackSourceIcon from './TrackSourceIcon.svelte';
  let { onclose }: { onclose: () => void } = $props();
  let query = $state('');
  let panel: HTMLDivElement;
  const motion = !$effectivePerformanceMode && !matchMedia('(prefers-reduced-motion: reduce)').matches && document.body.dataset.inputMode !== 'keyboard';
  const results = $derived($waveListeningHistory.filter(entry => normalizeSearchText(`${entry.track.title} ${entry.track.artist}`).includes(normalizeSearchText(query))));
  function play(index: number) {
    stopWave(); queue.set(results.slice(index + 1).map(entry => entry.track));
    currentTrack.set({ ...results[index].track, audioUrl: results[index].track.audioUrl || '' }); isPlaying.set(true); onclose();
  }
  function time(value: number) { return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy: () => node.remove() }; }
  onMount(() => panel.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }));
</script>
<svelte:window onpointerdown={event => { if (event.target instanceof Element && !event.target.closest('.lg-wave-history, .wave-history-trigger')) onclose(); }} onkeydowncapture={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onclose(); } }} />
<div class="lg-wave-history lg-optical" bind:this={panel} use:portal use:glassRefraction={$effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal'} transition:scale={{ start: .94, duration: motion ? 220 : 0, easing: cubicOut }} role="dialog" aria-label="История моей волны" tabindex="-1">
  <header><div><History size={18}/><h2>История моей волны</h2></div><button onclick={onclose} aria-label="Закрыть историю волны"><X size={18}/></button></header>
  <p>Последние 200 прослушиваний. Учитываются 60 секунд или 80% короткого трека.</p>
  <label class="lg-wave-history-search"><Search size={16}/><input type="search" bind:value={query} aria-label="Найти в истории волны" placeholder="Название или исполнитель"/></label>
  <div class="lg-wave-history-list">
    {#each results as entry, index}
      <button class="lg-wave-history-row" onclick={() => play(index)} aria-label={`Играть: ${entry.track.title}`}>
        {#if entry.track.coverUrl}<img src={coverUrlAtSize(entry.track.coverUrl, 80)} alt="" width="36" height="36" loading="lazy" decoding="async"/>{:else}<Music2 size={28}/>{/if}
        <span><strong>{entry.track.title}</strong><small>{entry.track.artist}</small></span><TrackSourceIcon source={entry.track.source}/><time>{time(entry.playedAt)}</time><Play size={14}/>
      </button>
    {:else}<div class="lg-wave-history-empty"><History size={28}/><h3>{query ? 'Совпадений нет' : 'Здесь появится музыка из волны'}</h3><p>{query ? 'Попробуй другое название или исполнителя.' : 'Слушай волну в Lomify. История начнёт сохраняться с этого обновления.'}</p></div>{/each}
  </div>
</div>
