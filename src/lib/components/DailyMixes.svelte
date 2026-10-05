<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { Play, Pause, RefreshCw, Plus, Check, X, Music2 } from 'lucide-svelte';
  import { settings, likedTracks, dislikedTracks, listenStats, playlists, playlistsReady, currentTrack, queue, isPlaying, notify, flushPlaylistStorage } from '$lib/stores';
  import { stopWave, waveActive } from '$lib/wave';
  import { whenSecretsReady } from '$lib/secretStorage';
  import { updateDailyMixes } from '$lib/dailyMixes';
  import { localMixDay, mixHash, mixTrackIdentity, type DailyMix, type DailyMixKind, type DailyMixSnapshot } from '$lib/dailyMixesCore';

  let { recommendations = [], recommendationsDay = '', releases = [], releasesDay = '', onrefresh }: {
    recommendations?: any[]; recommendationsDay?: string;
    releases?: any[]; releasesDay?: string; onrefresh?: () => Promise<void>;
  } = $props();

  let ready = $state(false);
  let day = $state(localMixDay());
  let snapshot = $state<DailyMixSnapshot | null>(null);
  let selected = $state<DailyMixKind | null>(null);
  let refreshing = $state(false);
  let saving = $state(false);
  let revision = $state(0);
  let appliedRevision = 0;
  let playingMix = $state('');
  const history = $derived($listenStats.history);
  const source = $derived($settings.searchSource === 'yandex' ? 'yandex' : 'soundcloud');
  const account = $derived(String(source === 'yandex' ? $settings.yandexUser?.uid || 'device' : $settings.scUser?.id || 'device'));
  const selectedMix = $derived(snapshot?.mixes.find((mix) => mix.kind === selected));
  const labels: Record<DailyMixKind, string> = { favorites: 'твое\nлюбимое', repeat: 'на\nповторе', discover: 'новые\nоткрытия', releases: 'свежие\nрелизы' };
  const empty: Record<DailyMixKind, string> = {
    favorites: 'Добавь песни в любимое, и здесь появится твой ежедневный микс.',
    repeat: 'Послушай несколько песен. Подборка собирается по твоей истории.',
    discover: 'Загружаем новые песни по твоему вкусу. Если сеть недоступна, попробуй обновить позже.',
    releases: 'Пока нет свежих релизов твоих исполнителей. Лайки помогают находить их точнее.'
  };

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
    try { await onrefresh?.(); revision++; }
    catch { notify('Не удалось обновить подборки. Сохранённые треки остаются доступны.', 'error'); }
    finally { refreshing = false; }
  }

  function dateLabel(value: string): string {
    return value === day ? 'Сегодня' : new Date(`${value}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }
  function countLabel(count: number): string {
    return `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'трек' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'трека' : 'треков'}`;
  }
  function mixKey(mix: DailyMix): string { return `${source}:${account}:${mix.kind}:${mix.day}`; }
  function savedId(mix: DailyMix): string { return `daily_${mix.kind}_${mix.day}_${mixHash(`${source}:${account}`).toString(36)}`; }
  function isCurrentMix(mix: DailyMix): boolean {
    return !$waveActive && playingMix === mixKey(mix) && Boolean($currentTrack && mix.tracks.some((track) => mixTrackIdentity(track) === mixTrackIdentity($currentTrack)));
  }
  function play(mix: DailyMix, index = 0, toggle = true) {
    const track = mix.tracks[index];
    if (!track) return;
    if (toggle && isCurrentMix(mix)) { isPlaying.update((value) => !value); return; }
    stopWave();
    playingMix = mixKey(mix);
    queue.set(mix.tracks.slice(index + 1));
    currentTrack.set(track);
    isPlaying.set(true);
  }
  async function save(mix: DailyMix) {
    if (saving || !mix.tracks.length) return;
    const id = savedId(mix);
    if (get(playlists).some((playlist) => playlist.id === id)) { notify('Эта подборка уже в медиатеке.', 'info'); return; }
    saving = true;
    try {
      const date = new Date(`${mix.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      playlists.update((value) => [...value, { id, title: `${mix.title} - ${date}`, tracks: mix.tracks.map((track) => ({ ...track })), coverUrl: mix.tracks[0].coverUrl, createdAt: Date.now() }]);
      await flushPlaylistStorage();
      notify('Подборка сохранена в медиатеку. Её треки останутся после следующего обновления.', 'success');
    } catch {
      playlists.update((value) => value.filter((playlist) => playlist.id !== id));
      notify('Не удалось сохранить подборку. Повтори сохранение.', 'error');
    }
    finally { saving = false; }
  }
</script>

<section class="daily-mixes" aria-labelledby="daily-mixes-title">
  <div class="mixes-heading">
    <div><h2 id="daily-mixes-title">Подборки для тебя</h2><p aria-live="polite">{refreshing ? 'Собираем подборки...' : 'Новый день - новая музыка по твоему вкусу'}</p></div>
    <button class="refresh-mixes" onclick={refresh} disabled={refreshing} aria-label="Обновить персональные подборки"><RefreshCw size={15} /> <span>Обновить</span></button>
  </div>
  <div class="mix-grid">
    {#each snapshot?.mixes || [] as mix (mix.kind)}
      <article class="mix-card" data-kind={mix.kind}>
        <button class="mix-cover" onclick={() => selected = selected === mix.kind ? null : mix.kind} aria-expanded={selected === mix.kind} aria-controls="daily-mix-details" aria-label={`Открыть подборку ${mix.title}`}>
          <svg class="mix-art" viewBox="0 0 280 280" aria-hidden="true">
            {#if mix.kind === 'favorites'}
              <path d="M140 240C30 173 17 90 70 73c30-10 54 9 70 31 17-22 41-41 71-31 52 17 39 100-71 167Z" fill="currentColor" />
              <path d="M140 214C61 166 47 108 85 96c22-7 40 7 55 23 15-16 33-30 55-23 38 12 24 70-55 118Z" fill="none" stroke="currentColor" stroke-width="2" />
            {:else if mix.kind === 'repeat'}
              {#each [44, 68, 92, 116, 140, 164] as radius}<circle cx="230" cy="55" r={radius} fill="none" stroke="currentColor" stroke-width="2" />{/each}
              <path d="m77 17 19 3-7 19M185 251l-19-3 7-19" fill="none" stroke="currentColor" stroke-width="3" />
            {:else if mix.kind === 'discover'}
              <path d="m160 18 23 68 73 21-68 23-21 74-24-68-73-22 68-24Z" fill="currentColor" />
              <circle cx="105" cy="188" r="110" fill="none" stroke="currentColor" stroke-width="1.5" />
              <circle cx="105" cy="188" r="84" fill="none" stroke="currentColor" stroke-width="1.5" />
            {:else}
              {#each [0, 1, 2, 3, 4] as index}<path d={`M${80 + index * 28} -20Q${190 - index * 28} 115 ${80 + index * 28} 300`} fill="none" stroke="currentColor" stroke-width="13" />{/each}
            {/if}
          </svg>
          <span class="mix-poster-top">{mix.tracks.length ? dateLabel(mix.day) : 'Твоя музыка'}</span>
          <span class="mix-poster-title">{labels[mix.kind]}</span>
          <span class="mix-poster-brand">LOMIFY</span>
        </button>
        <div class="mix-caption"><h3>{mix.title}</h3><p>{mix.tracks.length ? `${countLabel(mix.tracks.length)} · ${mix.day === day ? 'обновлено сегодня' : dateLabel(mix.day)}` : mix.kind === 'favorites' ? 'Собирается из твоих лайков' : mix.kind === 'repeat' ? 'Собирается из истории' : 'Ждём музыку из сети'}</p></div>
        <div class="mix-actions">
          <button class="mix-play" onclick={() => play(mix)} disabled={!mix.tracks.length} aria-label={`${isCurrentMix(mix) && $isPlaying ? 'Приостановить' : 'Слушать'} подборку ${mix.title}`}>
            {#if isCurrentMix(mix) && $isPlaying}<Pause size={14} fill="currentColor" />{:else}<Play size={14} fill="currentColor" />{/if}<span>{isCurrentMix(mix) && $isPlaying ? 'Пауза' : 'Слушать'}</span>
          </button>
          <button class="mix-save" onclick={() => save(mix)} disabled={!mix.tracks.length || saving || $playlists.some((playlist) => playlist.id === savedId(mix))} aria-label={`Сохранить подборку ${mix.title} в медиатеку`}>
            {#if $playlists.some((playlist) => playlist.id === savedId(mix))}<Check size={16} />{:else}<Plus size={16} />{/if}
          </button>
        </div>
      </article>
    {/each}
  </div>
  {#if selectedMix}
    <div class="mix-details" id="daily-mix-details">
      <div class="mix-details-heading"><div><h3>{selectedMix.title}</h3><p>{selectedMix.description}</p></div><button onclick={() => selected = null} aria-label="Закрыть список треков"><X size={18} /></button></div>
      {#if selectedMix.tracks.length}
        <ol class="mix-track-list">
          {#each selectedMix.tracks as track, index (mixTrackIdentity(track))}
            <li><button class="mix-track" onclick={() => play(selectedMix!, index, false)} aria-label={`Слушать ${track.title}, ${track.artist}`}>
              <span class="mix-track-number">{index + 1}</span>
              <span class="mix-track-cover">{#if track.coverUrl}<img src={track.coverUrl} alt="" loading="lazy" decoding="async" width="42" height="42" />{:else}<Music2 size={18} />{/if}</span>
              <span class="mix-track-text"><strong>{track.title}</strong><span>{track.artist}</span></span><Play size={13} />
            </button></li>
          {/each}
        </ol>
      {:else}<p class="mix-empty">{empty[selectedMix.kind]}</p>{/if}
    </div>
  {/if}
</section>

<style>
  .daily-mixes { width: 100%; container-type: inline-size; }
  .mixes-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.25rem; }
  .mixes-heading h2 { font-size: 1.55rem; font-weight: 750; letter-spacing: -.035em; line-height: 1.15; }
  .mixes-heading p { margin-top: .4rem; color: #a5a8ac; font-size: .8rem; }
  .refresh-mixes { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: #c2c6ca; padding: .55rem .7rem; border-radius: .65rem; }
  .refresh-mixes:hover { background: #ffffff0b; color: white; }
  .mix-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1.25rem; }
  .mix-card { min-width: 0; --poster-start: #db4b68; --poster-end: #86243e; --poster-ink: white; }
  .mix-card[data-kind="repeat"] { --poster-start: #686bb7; --poster-end: #353861; }
  .mix-card[data-kind="discover"] { --poster-start: #299190; --poster-end: #164e61; }
  .mix-card[data-kind="releases"] { --poster-start: #c2d887; --poster-end: #8bb299; --poster-ink: #1e3c2d; }
  .mix-cover { position: relative; display: block; overflow: hidden; width: 100%; aspect-ratio: 1; border-radius: 1.15rem; text-align: left; color: var(--poster-ink); background: linear-gradient(135deg, var(--poster-start), var(--poster-end)); box-shadow: inset 0 0 0 1px #ffffff12; }
  .mix-cover:hover { box-shadow: inset 0 0 0 2px #ffffff50; }
  .mix-cover[aria-expanded="true"] { box-shadow: inset 0 0 0 3px var(--poster-ink); }
  .mix-cover:active { opacity: .85; }
  .mix-art { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .2; }
  .mix-poster-top { position: absolute; top: 9%; left: 9%; font-size: .7rem; font-weight: 650; letter-spacing: .02em; }
  .mix-poster-title { position: absolute; left: 9%; right: 7%; bottom: 20%; font-size: clamp(1.8rem, 4.2cqi, 3.7rem); font-weight: 850; line-height: .95; letter-spacing: -.06em; white-space: pre-line; }
  .mix-poster-brand { position: absolute; bottom: 8%; left: 9%; font-size: .6rem; font-weight: 750; letter-spacing: .15em; opacity: .75; }
  .mix-caption { margin-top: .8rem; }
  .mix-caption h3 { font-size: .95rem; font-weight: 650; letter-spacing: -.015em; }
  .mix-caption p { margin-top: .3rem; font-size: .72rem; color: #a5a8ac; line-height: 1.5; min-height: 2.2em; }
  .mix-actions { display: flex; align-items: center; gap: .45rem; margin-top: .5rem; }
  .mix-play, .mix-save { display: flex; align-items: center; justify-content: center; height: 2rem; gap: .45rem; border-radius: .6rem; background: #ffffff09; border: 1px solid #ffffff10; color: #eceff0; }
  .mix-play { flex: 1; font-size: .75rem; font-weight: 550; }
  .mix-save { width: 2.1rem; flex-shrink: 0; }
  .mix-play:hover, .mix-save:hover { background: #ffffff15; }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 4px; }
  .mix-details { margin-top: 1.5rem; border: 1px solid #ffffff12; border-radius: 1rem; padding: 1.25rem; background: #ffffff04; }
  .mix-details-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
  .mix-details-heading h3 { font-size: 1.25rem; font-weight: 700; letter-spacing: -.03em; }
  .mix-details-heading p { color: #a5a8ac; font-size: .78rem; margin-top: .35rem; max-width: 40rem; }
  .mix-details-heading button { padding: .4rem; color: #a5a8ac; border-radius: .5rem; }
  .mix-details-heading button:hover { color: white; background: #ffffff0c; }
  .mix-track-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .15rem 1.5rem; max-height: 28rem; overflow: auto; }
  .mix-track { display: flex; width: 100%; text-align: left; align-items: center; gap: .65rem; padding: .45rem .3rem; border-radius: .6rem; }
  .mix-track:hover { background: #ffffff09; }
  .mix-track-number { width: 1.3rem; flex-shrink: 0; color: #969da3; font-size: .75rem; text-align: center; }
  .mix-track-cover { display: flex; align-items: center; justify-content: center; width: 42px; height: 42px; flex-shrink: 0; border-radius: .45rem; background: #ffffff0c; overflow: hidden; color: #90969a; }
  .mix-track-cover img { width: 100%; height: 100%; object-fit: cover; }
  .mix-track-text { flex: 1; min-width: 0; }
  .mix-track-text strong, .mix-track-text > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mix-track-text strong { font-size: .82rem; font-weight: 550; }
  .mix-track-text > span { margin-top: .2rem; font-size: .74rem; color: #a5a8ac; }
  .mix-track :global(svg) { flex-shrink: 0; }
  .mix-empty { color: #a5a8ac; font-size: .84rem; padding: .75rem 0; }
  @container (max-width: 720px) { .mix-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .mix-poster-title { font-size: clamp(2rem, 7cqi, 3.7rem); } .mix-track-list { grid-template-columns: 1fr; } }
  @container (max-width: 440px) { .mix-grid { gap: .8rem; } .mixes-heading h2 { font-size: 1.25rem; } .refresh-mixes span { display: none; } .mixes-heading p { font-size: .73rem; } .mix-details { padding: .8rem; } }
</style>
