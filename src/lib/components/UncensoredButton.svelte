<script lang="ts">
  import { tick } from 'svelte';
  import { AudioLines, Loader2, Play, X, Music2 } from 'lucide-svelte';
  import { scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { searchSoundCloud } from '$lib/api';
  import { currentTrack, isPlaying, effectivePerformanceMode, settings } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  import { stopWave } from '$lib/wave';
  import { rankUncensored, uncensoredQueries, type UncensoredTrack } from '$lib/uncensoredCore';

  let { track, compact = false, search = searchSoundCloud }: { track: { id?: string; source: string; title: string; artist: string; artists?: string[]; duration?: number }; compact?: boolean; search?: typeof searchSoundCloud } = $props();
  let open = $state(false);
  let loading = $state(false);
  let message = $state('');
  let results = $state.raw<{ track: UncensoredTrack; marked: boolean }[]>([]);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let panel = $state<HTMLDivElement>();
  let controller: AbortController | undefined;
  const identity = $derived(`${track.source}:${track.id}:${track.title}`);
  const motion = $derived(!$effectivePerformanceMode && !(typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches));

  $effect(() => {
    identity;
    open = false;
    results = [];
    message = '';
    return () => controller?.abort();
  });
  $effect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(true); } };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape); };
  });
  function close(restoreFocus = false) {
    open = false;
    controller?.abort();
    if (restoreFocus) trigger?.focus();
  }
  async function find() {
    if (open) { close(); return; }
    const origin = track;
    const requested = identity;
    const pending = new AbortController();
    controller?.abort();
    controller = pending;
    results = [];
    message = '';
    loading = true;
    open = true;
    await tick();
    panel?.focus();
    const timeout = setTimeout(() => pending.abort(), 20000);
    let abortWait: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abortWait = () => reject(new DOMException('Search cancelled', 'AbortError'));
      pending.signal.addEventListener('abort', abortWait, { once: true });
    });
    try {
      const responses = await Promise.race([Promise.allSettled(uncensoredQueries(origin).map(query => search(query, 30, true, pending.signal))), cancelled]);
      if (pending.signal.aborted || requested !== identity || !open) {
        if (requested === identity && open) message = 'SoundCloud не ответил вовремя. Попробуй ещё раз.';
        return;
      }
      const fulfilled = responses.filter(result => result.status === 'fulfilled');
      if (!fulfilled.length) { message = 'Не удалось связаться с SoundCloud. Проверь соединение и повтори поиск.'; return; }
      results = rankUncensored(origin, fulfilled.flatMap(result => result.value));
      if (!results.length) message = 'Подходящих версий пока не найдено.';
    } catch {
      if (requested === identity && open) message = 'SoundCloud не ответил вовремя. Попробуй ещё раз.';
    } finally {
      clearTimeout(timeout);
      pending.signal.removeEventListener('abort', abortWait!);
      if (controller === pending) loading = false;
    }
  }
  function play(candidate: UncensoredTrack) {
    stopWave();
    close();
    // Keep the following queue, replacing only the currently selected edition.
    currentTrack.set({ ...candidate, id: String(candidate.id), playbackSource: 'soundcloud' });
    isPlaying.set(true);
  }
</script>

<div class="uncensored-root" class:is-compact={compact} bind:this={root}>
  <button bind:this={trigger} type="button" data-press-late class="uncensored-trigger sheen-art" aria-label="Uncensored: найти версию без цензуры на SoundCloud" title="Найти версию без цензуры на SoundCloud" aria-expanded={open} aria-controls="uncensored-results" onclick={find}><span class="trigger-content"><AudioLines size={16} /><span>Uncensored</span></span></button>
  {#if open}
    <div id="uncensored-results" class="uncensored-panel" class:lg-optical={$settings.design === 'liquid-glass'} use:glassRefraction={$settings.design === 'liquid-glass' && !$effectivePerformanceMode ? $settings.glassQuality || 'normal' : 'off'} role="dialog" aria-label="Версии трека на SoundCloud" tabindex="-1" bind:this={panel} transition:scale={{ start: .96, duration: motion ? 160 : 0, easing: cubicOut }} onkeydown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(true); } }}>
      <div class="panel-heading"><div><strong>Без цензуры</strong><span>Альтернативы на SoundCloud</span></div><button class="close glass-button" aria-label="Закрыть поиск версий" onclick={() => close(true)}><X size={17} /></button></div>
      <p class="song-name">{track.artist} · {track.title}</p>
      <div aria-live="polite">
        {#if loading}<p class="status"><Loader2 size={16} class="animate-spin" />Ищем версии...</p>
        {:else if message}<p class="status">{message}</p><button class="retry glass-button sheen-art" onclick={() => { close(); void find(); }}>Повторить поиск</button>
        {:else}<p class="hint">Метки указаны авторами загрузок. Выбери версию для прослушивания.</p><ul>{#each results as result (result.track.id)}<li><button class="candidate interactive-item rounded-xl" onclick={() => play(result.track)}>{#if result.track.coverUrl}<img src={result.track.coverUrl} alt="" width="40" height="40" />{:else}<span class="placeholder"><Music2 size={18} /></span>{/if}<span class="candidate-copy"><strong>{result.track.title}</strong><span>{result.track.artist}</span><small>{result.marked ? 'Указано: без цензуры' : 'Цензура не отмечена'}</small></span><Play size={15} /></button></li>{/each}</ul>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .uncensored-root { position: relative; flex-shrink: 0; }
  .is-compact .uncensored-trigger { display: grid; place-items: center; width: 22px; height: var(--uncensored-button-height, 24px); min-width: 22px; min-height: var(--uncensored-button-height, 24px); padding: 0; border-radius: 8px; color: inherit; }
  .is-compact .trigger-content { justify-content: center; gap: 0; }
  .is-compact .trigger-content :global(svg) { display: block; width: var(--uncensored-icon-size, 14px); height: var(--uncensored-icon-size, 14px); }
  .is-compact .trigger-content > span { display: none; }
  .uncensored-trigger { display: flex; align-items: center; min-height: 30px; padding: .4rem .6rem; border: 0; border-radius: 999px; background: transparent; font-size: .65rem; font-weight: 650; color: #aaaeb5; transition: background-color var(--duration-quick), color var(--duration-quick); }
  .trigger-content { display: flex; align-items: center; gap: .35rem; transition: transform var(--duration-micro) var(--ease-smooth-out); }
  .uncensored-trigger:hover, .uncensored-trigger[aria-expanded="true"] { color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
  .uncensored-trigger:active .trigger-content { transform: scale(.94); }
  .uncensored-panel { position: absolute; bottom: calc(100% + 1.1rem); left: 0; width: min(350px, calc(100vw - 3rem)); max-height: min(450px, calc(100vh - 160px)); overflow: auto; padding: 1rem; border: 1px solid #ffffff18; border-radius: 1rem; background: #121519f5; box-shadow: 0 18px 60px #0009; z-index: 60; transform-origin: bottom left; outline: none; }
  .panel-heading { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
  .panel-heading strong { display: block; font-size: .9rem; }
  .panel-heading span, .song-name, .status, .hint { font-size: .72rem; line-height: 1.5; color: #a5a8ac; }
  .panel-heading span { display: block; margin-top: .15rem; }
  .close { display: grid; place-items: center; width: 28px; height: 28px; border-radius: .6rem; }
  .song-name { margin: .65rem 0; overflow-wrap: anywhere; }
  .status { display: flex; gap: .5rem; align-items: center; padding: .75rem 0; }
  .hint { margin-bottom: .5rem; }
  .retry { font-size: .72rem; padding: .5rem .75rem; border-radius: .6rem; }
  .candidate { display: flex; align-items: center; gap: .65rem; width: 100%; padding: .6rem .35rem; text-align: left; border-radius: .65rem; }
  .candidate:hover { background: #ffffff0a; }
  .candidate img, .placeholder { width: 40px; height: 40px; border-radius: .45rem; object-fit: cover; flex-shrink: 0; }
  .placeholder { display: grid; place-items: center; background: #ffffff0a; }
  .candidate-copy { min-width: 0; flex: 1; }
  .candidate-copy strong, .candidate-copy > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .75rem; }
  .candidate-copy > span { color: #a5a8ac; font-size: .7rem; margin-top: .1rem; }
  .candidate-copy small { color: var(--color-primary); font-size: .65rem; }
  @media (max-width: 1050px) { .trigger-content > span { display: none; } }
  @media (prefers-reduced-motion: reduce) { .status :global(.animate-spin) { animation: none; } .trigger-content { transition: none; transform: none !important; } }
  :global(body[data-perf="light"]) .trigger-content { transition: none; transform: none !important; }
</style>
