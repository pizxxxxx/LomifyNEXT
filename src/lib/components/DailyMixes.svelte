<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { RefreshCw, Plus, Check } from 'lucide-svelte';
  import { settings, likedTracks, dislikedTracks, listenStats, playlists, playlistsReady, notify } from '$lib/stores';
  import { whenSecretsReady } from '$lib/secretStorage';
  import { updateDailyMixes } from '$lib/dailyMixes';
  import { localMixDay, mixTrackIdentity, type DailyMix, type DailyMixSnapshot } from '$lib/dailyMixesCore';

  import DailyMixCover from './DailyMixCover.svelte';
  import MusicServiceIcon from './MusicServiceIcon.svelte';
  import { mixSelection, mixCountLabel, savedMixId, savingDailyMix, saveDailyMix, type DailyMixSelection } from '$lib/dailyMixActions';

  let { recommendations = [], recommendationsDay = '', releases = [], releasesDay = '', onrefresh, onopen }: {
    recommendations?: any[]; recommendationsDay?: string;
    releases?: any[]; releasesDay?: string; onrefresh?: () => Promise<void>; onopen: (selection: DailyMixSelection) => void;
  } = $props();

  let ready = $state(false);
  let day = $state(localMixDay());
  let snapshot = $state.raw<DailyMixSnapshot | null>(null);
  let refreshing = $state(false);
  let revision = $state(0);
  let appliedRevision = 0;
  const history = $derived($listenStats.history);
  const source = $derived($settings.searchSource === 'yandex' ? 'yandex' : 'soundcloud');
  const account = $derived(String(source === 'yandex' ? $settings.yandexUser?.uid || 'device' : $settings.scUser?.id || 'device'));

  $effect(() => {
    if (!ready) return;
    const force = revision !== appliedRevision;
    appliedRevision = revision;
    snapshot = updateDailyMixes({
      day, now: Date.now(), source, account, likes: $likedTracks, disliked: $dislikedTracks,
      history, playlists: $playlists, recommendations, recommendationsDay, releases, releasesDay
    }, force);
  });

  onMount(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      const midnight = new Date();
      midnight.setHours(24, 0, 1, 0);
      timer = setTimeout(checkDay, Math.max(1000, midnight.getTime() - Date.now()));
    }
    function checkDay() {
      const today = localMixDay();
      if (today !== day) { day = today; void refresh(); }
      clearTimeout(timer);
      schedule();
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') checkDay(); };
    void Promise.all([whenSecretsReady(), playlistsReady]).then(() => {
      if (!disposed) {
        ready = true;
        checkDay();
        if ((recommendationsDay && recommendationsDay !== day) || (releasesDay && releasesDay !== day)) void refresh();
      }
    });
    window.addEventListener('focus', checkDay);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener('focus', checkDay); document.removeEventListener('visibilitychange', onVisibility); };
  });

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const previous = new Set(snapshot?.mixes.flatMap(mix => mix.tracks.map(track => `${mix.kind}:${mixTrackIdentity(track)}`)) || []);
    try {
      await onrefresh?.(); revision++; await tick();
      const next = new Set(snapshot?.mixes.flatMap(mix => mix.tracks.map(track => `${mix.kind}:${mixTrackIdentity(track)}`)) || []);
      const added = [...next].filter(id => !previous.has(id)).length;
      notify(added ? `Подборки обновлены. Новых треков: ${added}.` : 'Новых вариантов пока нет. Подборки сохранены; попробуй обновить позже.', added ? 'success' : 'info');
    }
    catch { notify('Не удалось обновить подборки. Сохранённые треки остаются доступны.', 'error'); }
    finally { refreshing = false; }
  }

  function selection(mix: DailyMix) { return mixSelection(mix, source, account); }
</script>

<section class="daily-mixes" aria-labelledby="daily-mixes-title">
  <div class="mixes-heading">
    <div><h2 id="daily-mixes-title">Подборки для тебя</h2><p aria-live="polite">{refreshing ? 'Собираем подборки...' : 'Каждый день новая музыка без треков из лайков'}</p><span class="mix-source"><MusicServiceIcon service={source} size={13} />{source === 'yandex' ? 'Яндекс Музыка' : 'SoundCloud'}</span></div>
    <button class="refresh-mixes mix-action-button sheen-art" onclick={refresh} disabled={refreshing} aria-label="Обновить персональные подборки"><span class:refreshing><RefreshCw size={15} /></span> <span>Обновить</span></button>
  </div>
  <div class="mix-grid">
    {#each snapshot?.mixes || [] as mix (mix.kind)}
      {@const value = selection(mix)}
      {@const saved = $playlists.some(playlist => playlist.id === savedMixId(value))}
      <article class="mix-card track-tile interactive-item">
        <div class="mix-cover-frame">
          <button class="mix-cover cover-tilt-frame" onclick={() => onopen(value)} aria-label={`Открыть подборку ${mix.title}`}><span class="cover-tilt-surface spec-art"><span class="cover-surface"><DailyMixCover {mix} id={value.id} /></span></span></button>
          <button class="mix-save sheen-art" class:saved onclick={() => saveDailyMix(value)} disabled={!mix.tracks.length || Boolean($savingDailyMix) || saved} aria-label={saved ? 'Подборка сохранена в медиатеку' : `Сохранить подборку ${mix.title} в медиатеку`}><span class="action-content">{#if saved}<Check size={18} />{:else}<Plus size={18} />{/if}</span></button>
        </div>
        <div class="mix-caption tile-label-frame"><div class="tile-label-surface"><h3>{mix.title}</h3><p>{mix.tracks.length ? mixCountLabel(mix.tracks.length) : 'Ждём музыку из выбранного сервиса'}</p></div></div>
      </article>
    {/each}
  </div>
</section>

<style>
  .daily-mixes { width: 100%; container-type: inline-size; }
  .mixes-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.25rem; }
  .mixes-heading h2 { font-size: 1.55rem; font-weight: 750; letter-spacing: -.035em; line-height: 1.15; }
  .mixes-heading p { margin-top: .4rem; color: #a5a8ac; font-size: .8rem; }
  .mix-source { display: flex; align-items: center; gap: .4rem; margin-top: .5rem; font-size: .7rem; color: #a5a8ac; }
  .refresh-mixes { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: #c2c6ca; padding: .55rem .7rem; border-radius: .65rem; }
  .refresh-mixes:hover { background: #ffffff0b; color: white; }
  .refreshing { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .mix-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1.25rem; }
  .mix-card { min-width: 0; padding: 0; border: 0; }
  .mix-cover-frame { position: relative; aspect-ratio: 1; }
  .mix-cover { position: relative; display: block; width: 100%; aspect-ratio: 1; border-radius: 1.15rem; border: 0; background: transparent; overflow: visible; isolation: isolate; }
  .cover-surface { display: block; transition: transform var(--duration-quick, 250ms) var(--ease-smooth-out); }
  .mix-cover:focus-visible { outline: none; }
  .mix-cover:focus-visible .cover-tilt-surface { outline: 2px solid var(--color-primary); outline-offset: -4px; }
  .mix-cover:active .cover-surface { transform: scale(.97); transition-duration: var(--duration-micro); }
  .mix-caption { margin-top: .8rem; }
  .mix-caption h3 { font-size: .95rem; font-weight: 650; letter-spacing: -.015em; }
  .mix-caption p { margin-top: .3rem; font-size: .72rem; color: #a5a8ac; line-height: 1.5; min-height: 2.2em; }
  .mix-save { position: absolute; bottom: .75rem; right: .75rem; display: grid; place-items: center; width: 2.75rem; height: 2.75rem; border-radius: 50%; background: #080b12a6; border: 0; color: white; backdrop-filter: blur(12px); z-index: 10; transition: background-color var(--duration-quick), color var(--duration-quick); }
  .action-content { display: flex; align-items: center; gap: .45rem; transition: transform var(--duration-micro) var(--ease-smooth-out); }
  .mix-save:hover { background: #080b12e0; }
  .mix-save.saved { color: var(--color-primary); opacity: 1; }
  .mix-save:active:not(:disabled) .action-content { transform: scale(.86); }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -3px; }
  @media (hover: hover) and (pointer: fine) {
    .mix-cover:hover .cover-surface { transform: scale(1.025); }
    .mix-cover:active .cover-surface { transform: scale(.97); }
  }
  @media (prefers-reduced-motion: reduce) { .cover-surface, .action-content { transition: none; transform: none !important; } .refreshing { animation: none; } }
  :global(body[data-perf="light"]) .cover-surface, :global(body[data-perf="light"]) .action-content { transition: none; transform: none !important; }
  @container (max-width: 720px) { .mix-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @container (max-width: 440px) { .mix-grid { gap: .8rem; } .mixes-heading h2 { font-size: 1.25rem; } .refresh-mixes > span:last-child { display: none; } .mixes-heading p { font-size: .73rem; } }
</style>
