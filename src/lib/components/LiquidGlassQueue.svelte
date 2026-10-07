<script lang="ts">
  import { fade, fly, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { ListMusic, Shuffle, Repeat, Infinity as InfinityIcon, Moon, History, Music2, X } from 'lucide-svelte';
  import { currentTrack, queue, settings, trackHistory, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  import { glassQueueOpen, glassPanelMode, playbackShuffle, playbackRepeat, sleepDeadline, playQueueItem, glassQueueContext } from '$lib/liquidGlass';
  import { stopWave } from '$lib/wave';
  import { coverUrlAtSize, coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';
  import LiquidGlassOutput from './LiquidGlassOutput.svelte';
  import TrackSourceIcon from './TrackSourceIcon.svelte';
  import Lyrics from './Lyrics.svelte';
  import LiquidGlassPanelResize from './LiquidGlassPanelResize.svelte';
  import LiquidGlassSupport from './LiquidGlassSupport.svelte';
  let timerOpen = $state(false);
  let timerRoot = $state<HTMLDivElement>();
  let now = $state(Date.now());
  let visibleCount = $state(40);
  const visibleQueue = $derived($queue.slice(0, visibleCount));
  const minutes = $derived($sleepDeadline === null ? 0 : Math.max(1, Math.ceil(($sleepDeadline - now) / 60000)));
  const timerLabel = $derived(minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`);
  function motionDuration(duration = 200) {
    return $effectivePerformanceMode || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.inputMode === 'keyboard' ? 0 : duration;
  }
  $effect(() => {
    const timer = setInterval(() => now = Date.now(), 15000);
    return () => clearInterval(timer);
  });
  $effect(() => { if ($glassPanelMode !== 'queue') timerOpen = false; });
  function setTimer(minutes: number) { now = Date.now(); sleepDeadline.set(minutes ? now + minutes * 60000 : null); timerOpen = false; }
  function toggleContinuation() {
    const enabled = $settings.waveContinuation === false;
    settings.update(s => ({ ...s, waveContinuation: enabled }));
    if (!enabled) stopWave();
  }
</script>
<svelte:window onpointerdown={event => { if (event.target instanceof Node && !timerRoot?.contains(event.target)) timerOpen = false; }} onkeydowncapture={event => { if (timerOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); timerOpen = false; } }} />
{#if $glassQueueOpen}
  <aside id="lomify-side-panel" class="lg-queue" class:is-lyrics={$glassPanelMode === 'lyrics'} aria-label={$glassPanelMode === 'support' ? 'Поддержка LomifyNEXT' : $glassPanelMode === 'lyrics' ? 'Текст песни' : 'Очередь воспроизведения'} inert={!$glassQueueOpen} in:fly={{ x: 12, duration: motionDuration(), easing: cubicOut }} out:fade={{ duration: motionDuration(150) }}>
    <LiquidGlassPanelResize />
    {#if $glassPanelMode === 'support'}
      <div class="lg-panel-support-content" inert={$glassPanelMode !== 'support'} in:fly={{ x: 12, duration: motionDuration(), easing: cubicOut }} out:fade={{ duration: motionDuration(150) }}>
        <div class="lg-panel-heading"><button class="lg-circle" aria-label="Вернуться к очереди" onclick={() => glassPanelMode.set('queue')}><ListMusic size={15}/></button><h2>Поддержать</h2><button class="lg-circle" aria-label="Закрыть боковую панель" onclick={() => glassQueueOpen.set(false)}><X size={15}/></button></div>
        <LiquidGlassSupport />
      </div>
    {:else if $glassPanelMode === 'lyrics'}
      <div class="lg-panel-lyrics-content" inert={$glassPanelMode !== 'lyrics'} in:fly={{ x: 12, duration: motionDuration(), easing: cubicOut }} out:fade={{ duration: motionDuration(150) }}>
      <div class="lg-panel-heading"><button class="lg-circle" aria-label="Вернуться к очереди" onclick={() => glassPanelMode.set('queue')}><ListMusic size={15} /></button><h2>Текст песни</h2><button class="lg-circle" aria-label="Закрыть боковую панель" onclick={() => glassQueueOpen.set(false)}><X size={15} /></button></div>
      <div class="lg-panel-lyrics">{#if $currentTrack}<Lyrics letterSync={false} />{:else}<p class="lg-queue-empty">Включи трек, чтобы открыть текст.</p>{/if}</div>
      </div>
    {:else}
    <div class="lg-panel-queue-content" inert={$glassPanelMode !== 'queue'} in:fly={{ x: 12, duration: motionDuration(), easing: cubicOut }} out:fade={{ duration: motionDuration(150) }}>
    <div class="lg-queue-tools">
      <button class="lg-circle" aria-label="Скрыть очередь" onclick={() => glassQueueOpen.set(false)}><ListMusic size={15} /></button>
      <div class="lg-capsule">
        <button aria-label="Перемешивание" aria-pressed={$playbackShuffle} class:is-active={$playbackShuffle} onclick={() => $playbackShuffle = !$playbackShuffle}><Shuffle size={14} /></button>
        <LiquidGlassOutput />
        <button aria-label={`Повтор: ${$playbackRepeat === 0 ? 'выключен' : $playbackRepeat === 1 ? 'всё' : 'один трек'}`} class:is-active={$playbackRepeat > 0} onclick={() => $playbackRepeat = ($playbackRepeat + 1) % 3}><Repeat size={14} />{#if $playbackRepeat === 2}<small>1</small>{/if}</button>
        <button aria-label="Волна продолжит" aria-pressed={$settings.waveContinuation !== false} class:is-active={$settings.waveContinuation !== false} onclick={toggleContinuation}><InfinityIcon size={14} /></button>
      </div>
      <span class="lg-count">{$queue.length + ($currentTrack ? 1 : 0)} элементов</span>
    </div>
    <div class="lg-queue-heading"><h2>Сейчас играет</h2><span class="lg-count" title="Треков в истории текущего сеанса"><History size={11} />{$trackHistory.length}</span></div>
    {#if $currentTrack}
      <div class="lg-queue-current">
        {#if $currentTrack.coverUrl}<img src={coverUrlAtSize(coverUrlForTrack($currentTrack, $downloadedCoverCache), 80)} alt="" width="36" height="36" />{:else}<Music2 size={28} />{/if}
        <div><strong>{$currentTrack.title}</strong><span>{$currentTrack.artist}</span></div><TrackSourceIcon source={$currentTrack.source} />
      </div>
    {:else}<p class="lg-queue-empty">Выбери трек для воспроизведения.</p>{/if}
    <div class="lg-queue-next-head"><div class="lg-queue-heading"><h2>Далее</h2><span>{#if $glassQueueContext}{Math.max(1, $glassQueueContext.total - $queue.length)} из {$glassQueueContext.total}{:else}{$queue.length} в очереди{/if}</span></div>
      {#if $glassQueueContext}<div class="lg-queue-origin"><p>Из {$glassQueueContext.title}</p>{#if $glassQueueContext.cover}<img src={coverUrlAtSize($glassQueueContext.cover, 50)} alt="" width="25" height="25" />{/if}</div>{/if}
    </div>
    <div class="lg-queue-list">
      {#each visibleQueue as track, index (index)}
        <button class="lg-queue-row" onclick={() => playQueueItem(index)} aria-label={`Воспроизвести «${track.title}»`}>
          <span class="lg-queue-number">{index + 1}</span>
          {#if track.coverUrl}<img src={coverUrlAtSize(coverUrlForTrack(track, $downloadedCoverCache), 80)} alt="" width="32" height="32" loading="lazy" />{:else}<Music2 size={24} />{/if}
          <span class="lg-queue-copy"><strong>{track.title}</strong><span>{track.artist}</span></span><TrackSourceIcon source={track.source} size={11} />
        </button>
      {/each}
      {#if visibleCount < $queue.length}<button class="lg-load-more" onclick={() => visibleCount += 40}>Показать ещё</button>{/if}
      {#if !$queue.length}<p class="lg-queue-empty">Следующие треки появятся здесь.</p>{/if}
    </div>
    <div class="lg-queue-bottom" bind:this={timerRoot}>
      <button class="lg-wave-continuation" aria-pressed={$settings.waveContinuation !== false} onclick={toggleContinuation}><InfinityIcon size={18} /><span><strong>Волна продолжит</strong><small>{$settings.waveContinuation === false ? 'Автоподбор выключен' : 'Похожая музыка после очереди'}</small></span></button>
      <button class="lg-sleep-pill" aria-expanded={timerOpen} onclick={() => timerOpen = !timerOpen}><Moon size={14} />{#if $sleepDeadline}{timerLabel} · {new Date($sleepDeadline).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}{:else}Таймер сна{/if}</button>
      {#if timerOpen}<div class="lg-popover lg-timer-pop lg-optical" use:glassRefraction={$effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal'} transition:scale={{ start: .96, duration: motionDuration(), easing: cubicOut }} inert={!timerOpen} role="dialog" aria-label="Таймер сна"><strong>Остановить музыку через</strong>{#each [15, 30, 60, 90] as minutes}<button onclick={() => setTimer(minutes)}>{minutes} мин</button>{/each}{#if $sleepDeadline}<button onclick={() => setTimer(0)}>Отменить таймер</button>{/if}</div>{/if}
    </div>
    </div>
    {/if}
  </aside>
{/if}
