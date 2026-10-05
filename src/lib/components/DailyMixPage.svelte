<script lang="ts">
  import { onMount } from 'svelte';
  import { Play, Pause, Plus, Check, Music2, ArrowLeft, Share2, Heart } from 'lucide-svelte';
  import DailyMixCover from './DailyMixCover.svelte';
  import MusicServiceIcon from './MusicServiceIcon.svelte';
  import { currentTrack, isPlaying, playlists, likedTracks } from '$lib/stores';
  import { waveActive } from '$lib/wave';
  import { mixTrackIdentity, withoutLikedDailyTracks } from '$lib/dailyMixesCore';
  import { mixCountLabel, playingDailyMix, savingDailyMix, savedMixId, playDailyMix, saveDailyMix, type DailyMixSelection } from '$lib/dailyMixActions';

  import { copyMusicLink } from '$lib/shareLinks';
  import { mixShareLink, trackShareLink } from '$lib/shareLinksCore';
  import { toggleTrackLike, isTrackLiked } from '$lib/likes';
  import { notify } from '$lib/stores';

  let { selection, onback }: { selection: DailyMixSelection; onback: () => void } = $props();
  let entered = $state(false);
  const value = $derived({ ...selection, mix: { ...selection.mix, tracks: selection.sharedTrack ? selection.mix.tracks : withoutLikedDailyTracks(selection.mix.tracks, $likedTracks) } });
  const saved = $derived($playlists.some(playlist => playlist.id === savedMixId(value)));
  const current = $derived(!$waveActive && $playingDailyMix === value.id && Boolean($currentTrack && value.mix.tracks.some(track => mixTrackIdentity(track) === mixTrackIdentity($currentTrack))));
  const date = $derived(new Date(`${value.mix.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }));
  onMount(() => {
    const frame = requestAnimationFrame(() => entered = true);
    return () => cancelAnimationFrame(frame);
  });
  async function share() {
    try { await copyMusicLink(value.sharedTrack ? trackShareLink(value.mix.tracks[0]) : mixShareLink(value)); }
    catch (error) { notify(error instanceof Error ? error.message : 'Не удалось создать ссылку.', 'error'); }
  }
  function time(duration = 0) { const seconds = Math.floor(duration / 1000); return seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''; }
</script>

<section class="daily-mix-page" class:entered aria-labelledby="daily-mix-heading">
  <button class="mix-back mix-action-button sheen-art" onclick={onback}><ArrowLeft size={16} /><span>К подборкам</span></button>
  <header class="mix-hero">
    <div class="hero-cover interactive-item track-tile"><span class="cover-tilt-surface spec-art">{#if value.sharedTrack}<div class="shared-track-cover"><Music2 size={80} /></div>{:else}<DailyMixCover mix={value.mix} id={value.id} />{/if}</span></div>
    <div class="hero-copy reveal"><span class="hero-eyebrow">{value.sharedTrack ? 'ПРИСЛАННЫЙ ТРЕК' : value.shared ? 'ПРИСЛАННАЯ ПОДБОРКА' : 'ТВОЯ ЕЖЕДНЕВНАЯ ПОДБОРКА'}</span><h1 id="daily-mix-heading" tabindex="-1">{value.mix.title}</h1><p class="hero-description">{value.mix.description}</p><p class="hero-meta"><MusicServiceIcon service={value.source} size={16} />{value.source === 'yandex' ? 'Яндекс Музыка' : 'SoundCloud'}{#if !value.sharedTrack}<span>·</span>{date}<span>·</span>{mixCountLabel(value.mix.tracks.length)}{/if}</p>
      <div class="hero-actions">
        <button class="hero-play mix-action-button mix-action-primary sheen-art" onclick={() => playDailyMix(value, 0, current)} disabled={!value.mix.tracks.length}><span class="action-content">{#if current && $isPlaying}<Pause size={18} fill="currentColor" />{:else}<Play size={18} fill="currentColor" />{/if}{current && $isPlaying ? 'Пауза' : 'Слушать'}</span></button>
        {#if value.sharedTrack}<button class="mix-action-button sheen-art" onclick={() => toggleTrackLike(value.mix.tracks[0])}><span class="action-content"><Heart size={18} fill={isTrackLiked($likedTracks, value.mix.tracks[0]) ? 'currentColor' : 'none'} />{isTrackLiked($likedTracks, value.mix.tracks[0]) ? 'В любимом' : 'В любимое'}</span></button>{:else}<button class="hero-save mix-action-button sheen-art" class:saved onclick={() => saveDailyMix(value)} disabled={saved || Boolean($savingDailyMix) || !value.mix.tracks.length}><span class="action-content">{#if saved}<Check size={18} />{:else}<Plus size={18} />{/if}{saved ? 'В медиатеке' : $savingDailyMix === value.id ? 'Сохраняем...' : 'В медиатеку'}</span></button>{/if}
        <button data-press-late class="mix-action-button sheen-art" onclick={share} disabled={!value.mix.tracks.length}><span class="action-content"><Share2 size={17} />Поделиться</span></button>
      </div>
    </div>
  </header>
  <div class="mix-track-section reveal">
    <div class="track-heading"><h2>Треки</h2>{#if !value.sharedTrack}<span>Без песен из лайков</span>{/if}</div>
    {#if value.mix.tracks.length}
      <ol class="mix-track-list">
        {#each value.mix.tracks as track, index (mixTrackIdentity(track))}
          {@const active = current && mixTrackIdentity(track) === mixTrackIdentity($currentTrack)}
          <li class="track-reveal" style={`--row-delay: ${Math.min(index, 5) * 30}ms`}><button class="mix-track interactive-item sheen-art rounded-xl" class:active onclick={() => playDailyMix(value, index, active)} aria-label={`${active && $isPlaying ? 'Приостановить' : 'Слушать'} ${track.title}, ${track.artist}`}>
            <span class="mix-track-number">{#if active && $isPlaying}<span class="equalizer" aria-hidden="true"><i></i><i></i><i></i></span>{:else}{index + 1}{/if}</span>
            <span class="mix-track-cover">{#if track.coverUrl}<img src={track.coverUrl} alt="" loading="lazy" decoding="async" width="48" height="48" />{:else}<Music2 size={20} />{/if}</span>
            <span class="mix-track-text"><strong>{track.title}</strong><span>{track.artist}</span></span><span class="track-duration">{time(track.duration)}</span><span class="track-play action-content">{#if active && $isPlaying}<Pause size={16} fill="currentColor" />{:else}<Play size={16} fill="currentColor" />{/if}</span>
          </button></li>
        {/each}
      </ol>
    {:else}<p class="mix-empty">Пока нет подходящих треков. Вернись на главную и обнови подборки. Треки из лайков исключены.</p>{/if}
  </div>
</section>

<style>
  .daily-mix-page { width: min(100%, 960px); margin: 0 auto; padding-top: .75rem; }
  .mix-back { display: flex; align-items: center; gap: .5rem; padding: .55rem .7rem; border-radius: .65rem; color: #a5a8ac; font-size: .8rem; margin-bottom: 1.5rem; }
  .mix-back:hover { color: white; background: #ffffff0b; }
  .mix-hero { display: flex; flex-direction: column; align-items: center; text-align: center; }
  .hero-cover { width: clamp(180px, 24vw, 220px); aspect-ratio: 1; padding: 0; border: 0; border-radius: 1.15rem; }
  .shared-track-cover { display: grid; place-items: center; aspect-ratio: 1; border-radius: 1.15rem; color: var(--color-primary); background: #ffffff09; }
  .hero-copy { margin-top: 1.5rem; max-width: min(38rem, 100%); }
  .hero-eyebrow { color: #a5a8ac; font-size: .65rem; font-weight: 650; letter-spacing: .14em; }
  h1 { font-size: clamp(1.9rem, 4vw, 2.8rem); font-weight: 800; letter-spacing: -.05em; line-height: 1.12; margin-top: .5rem; outline: none; }
  #daily-mix-heading:focus-visible { outline: none; }
  .hero-description { color: #adb2b8; font-size: .85rem; line-height: 1.65; margin-top: .75rem; }
  .hero-meta { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: .45rem; color: #91999f; font-size: .73rem; margin-top: .75rem; }
  .hero-actions { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: .65rem; margin-top: 1.25rem; }
  .hero-actions button { padding: .7rem 1.1rem; border-radius: .8rem; font-weight: 600; font-size: .82rem; }
  .hero-actions .hero-play { color: var(--color-dark, #111014); background: var(--color-primary); border-color: transparent; min-width: 130px; }
  .hero-actions .saved { color: var(--color-primary); opacity: 1; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -3px; }
  .action-content { display: flex; align-items: center; justify-content: center; gap: .5rem; transition: transform var(--duration-micro) var(--ease-smooth-out); }
  button:active:not(:disabled) .action-content { transform: scale(.94); }
  .mix-track-section { margin-top: 2.5rem; }
  .track-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0 .65rem .85rem; border-bottom: 1px solid #ffffff10; }
  .track-heading h2 { font-weight: 650; font-size: 1rem; }
  .track-heading > span { font-size: .72rem; color: #91999f; }
  .mix-track-list { padding-top: .5rem; }
  .mix-track { display: flex; width: 100%; align-items: center; text-align: left; gap: .85rem; padding: .55rem .65rem; border-radius: .75rem; }
  .mix-track:hover { background: #ffffff08; }
  .mix-track:active { transform: none; }
  .mix-track.active { color: var(--color-primary); background: #ffffff06; }
  .mix-track-number { width: 1.5rem; flex-shrink: 0; font-size: .75rem; color: #91999f; text-align: center; }
  .mix-track-cover { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; flex-shrink: 0; border-radius: .55rem; background: #ffffff0c; overflow: hidden; color: #90969a; }
  .mix-track-cover img { width: 100%; height: 100%; object-fit: cover; }
  .mix-track-text { flex: 1; min-width: 0; }
  .mix-track-text strong, .mix-track-text > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mix-track-text strong { font-size: .86rem; font-weight: 550; }
  .mix-track-text > span { margin-top: .25rem; font-size: .76rem; color: #a5a8ac; }
  .track-duration { color: #91999f; font-size: .75rem; }
  .track-play { color: #a5a8ac; padding: .35rem; }
  .equalizer { height: 14px; display: flex; align-items: center; justify-content: center; gap: 2px; color: var(--color-primary); }
  .equalizer i { width: 3px; height: 12px; border-radius: 2px; background: currentColor; }
  .equalizer i:nth-child(2) { height: 7px; } .equalizer i:nth-child(3) { height: 10px; }
  .mix-empty { color: #a5a8ac; font-size: .85rem; padding: 1.5rem .65rem; }
  .reveal, .track-reveal { opacity: 0; transform: translateY(10px); transition: opacity var(--duration-quick) var(--ease-smooth-out), transform var(--duration-quick) var(--ease-smooth-out); }
  .hero-copy { transition-delay: 80ms; }
  .mix-track-section { transition-delay: 120ms; }
  .track-reveal { transition-delay: calc(120ms + var(--row-delay)); }
  .entered .reveal, .entered .track-reveal { opacity: 1; transform: translateY(0); }
  @media (prefers-reduced-motion: reduce) { .reveal, .track-reveal { opacity: 1; transform: none; transition: none; } .action-content { transition: none; transform: none !important; } }
  :global(body[data-perf="light"]) .reveal, :global(body[data-perf="light"]) .track-reveal { opacity: 1; transform: none; transition: none; }
  :global(body[data-perf="light"]) .action-content { transition: none; transform: none !important; }
  @media (max-width: 850px) { .track-duration { display: none; } .hero-cover { width: 200px; } }
</style>
