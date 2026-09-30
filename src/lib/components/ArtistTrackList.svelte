<script lang="ts">
  import { Heart, Info, Music2 } from 'lucide-svelte';
  import { Play as PlayIcon, Pause as PauseIcon } from 'lucide';
  import { MorphIcon } from 'morphicons/svelte';
  import { tick } from 'svelte';
  import { currentTrack, isPlaying, likedTracks } from '$lib/stores';
  import { isTrackLiked, setTrackLiked } from '$lib/likes';
  import { coverUrlAtSize, coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';
  import { formatTrackDate, formatTrackDuration } from '$lib/utils/artistTracks';
  import ArtistTag from './ArtistTag.svelte';
  import TrackStatus from './TrackStatus.svelte';

  /**
   * `view` — та же пара представлений, что у любимых треков: плотный список с колонками
   * и сетка карточек. Оба рисует один компонент, потому что логика вокруг строки (лайк,
   * всплывающая справка, догрузка порциями) у них общая, и разводить её по двум файлам
   * значило бы починить всплывашку в одном месте и забыть в другом.
   */
  let { tracks, source, view = 'list', onplay, onpreview, onpreviewend }: {
    tracks: any[];
    source: string;
    view?: 'list' | 'tiles';
    onplay: (track: any, list: any[]) => void;
    onpreview: (track: any) => void;
    onpreviewend: () => void;
  } = $props();

  let visibleCount = $state(40);
  let infoTrack = $state.raw<any>(null);
  let infoPlacement = $state<'top' | 'bottom'>('bottom');
  let infoTrigger: HTMLButtonElement | undefined;
  let infoPanel = $state<HTMLDivElement>();
  const visibleTracks = $derived(tracks.slice(0, visibleCount));
  const hasPlayCounts = $derived(source !== 'yandex' && tracks.some(track => track.playbackCount != null));

  function isSameTrack(track: any, playing: any): boolean {
    return playing?.title === track.title && playing?.artist === track.artist;
  }

  /**
   * Клик по карточке. В сетке нажимают по обложке, а не по маленькой кнопке в её центре,
   * поэтому играющий трек с той же обложки должен и ставиться на паузу - иначе «плей»
   * работает по всей карточке, а «пауза» только по кнопке.
   */
  function toggleFromTile(track: any) {
    if (isSameTrack(track, $currentTrack)) {
      isPlaying.set(!$isPlaying);
      return;
    }
    onplay(track, tracks);
  }

  async function openInfo(track: any, trigger: HTMLButtonElement) {
    if (infoTrack === track) { closeInfo(); return; }
    infoTrigger = trigger;
    infoPlacement = 'bottom';
    infoTrack = track;
    await tick();
    if (infoTrack !== track || !infoPanel) return;
    const panel = infoPanel.getBoundingClientRect();
    if (panel.bottom > window.innerHeight - 12 && trigger.getBoundingClientRect().top > panel.height + 12) {
      infoPlacement = 'top';
    }
  }

  function closeInfo(restoreFocus = false) {
    infoTrack = null;
    if (restoreFocus) infoTrigger?.focus();
  }

  function dismissInfo(event: PointerEvent) {
    if (!infoTrack || !(event.target instanceof Node)) return;
    if (!infoPanel?.contains(event.target) && !infoTrigger?.contains(event.target)) closeInfo();
  }
</script>

<svelte:window onpointerdown={dismissInfo} onkeydown={(event) => {
  if (event.key === 'Escape' && infoTrack) { event.stopPropagation(); closeInfo(true); }
}} />

{#snippet infoPopover(track: any)}
  <div class="track-row-info-pop" class:is-top={infoPlacement === 'top'} class:is-bottom={infoPlacement === 'bottom'} bind:this={infoPanel} role="dialog" aria-label={`Информация о треке «${track.title}»`} tabindex="-1">
    <div class="track-row-popover">
      <p><strong>Автор:</strong> {track.artist}</p>
      {#if track.albumTitle}<p><strong>Альбом:</strong> {track.albumTitle}</p>{/if}
      <p><strong>Выпущен:</strong> {formatTrackDate(track.releaseDate)}</p>
      <p><strong>Длительность:</strong> {formatTrackDuration(track.duration)}</p>
      <p><strong>Источник:</strong> {source === 'yandex' ? 'Яндекс Музыка' : 'SoundCloud'}</p>
      {#if source !== 'yandex' && track.playbackCount != null}<p><strong>Прослушиваний SC:</strong> {track.playbackCount.toLocaleString('ru-RU')}</p>{/if}
      {#if track.genre}<p><strong>Жанр:</strong> {track.genre}</p>{/if}
    </div>
  </div>
{/snippet}

{#if view === 'tiles'}
  <!-- Классы `library-*` здесь не про экран «Моя музыка», а про сам вид карточки: это
       единственное описание этой плитки в проекте (app.css), и артист получает ровно ту
       карточку, которую человек уже знает из любимых треков. Свой набор классов означал бы
       вторую копию тех же 200 строк оформления. -->
  <div class="library-track-grid artist-track-grid" class:has-open-track-menu={infoTrack !== null}>
    {#each visibleTracks as track (track)}
      {@const isActive = isSameTrack(track, $currentTrack)}
      {@const liked = isTrackLiked($likedTracks, track)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="track-tile library-track-tile group interactive-item"
        class:is-active={isActive}
        class:is-banned={track.isBanned}
        class:has-open-menu={infoTrack === track}
        onclick={() => toggleFromTile(track)}
      >
        <div class="tile-art spec-art" class:is-active={isActive}>
          <div class="library-tile-art-clip">
            {#if track.coverUrl}
              <img src={coverUrlAtSize(coverUrlForTrack(track, $downloadedCoverCache), 400)} alt="" class="tile-cover-image" loading="lazy" decoding="async" />
            {:else}
              <div class="library-tile-art-empty"><Music2 size={34} /></div>
            {/if}

            <div class="tile-cover-overlay">
              <button
                type="button"
                class="tile-play-button"
                class:is-muted={track.isBanned}
                aria-label={isActive && $isPlaying ? `Поставить «${track.title}» на паузу` : `Воспроизвести «${track.title}»`}
                onclick={(event) => { event.stopPropagation(); toggleFromTile(track); }}
                onmouseenter={() => onpreview(track)}
                onmouseleave={onpreviewend}
              >
                <MorphIcon
                  icon={isActive && $isPlaying ? PauseIcon : PlayIcon}
                  size={20}
                  strokeWidth={2.35}
                  fill="currentColor"
                  class="play-pause-morph"
                  spring="snappy"
                  reducedMotion="user"
                />
              </button>
            </div>
          </div>

          <div class="library-tile-actions">
            <button
              type="button"
              class="library-tile-action"
              class:is-open={infoTrack === track}
              aria-label={`Информация о треке «${track.title}»`}
              aria-haspopup="dialog"
              aria-expanded={infoTrack === track}
              onclick={(event) => { event.stopPropagation(); openInfo(track, event.currentTarget); }}
            >
              <Info size={15} />
            </button>
            <button
              type="button"
              class="library-tile-action"
              class:is-liked={liked}
              aria-label={liked ? 'Убрать из любимых' : 'В любимые'}
              aria-pressed={liked}
              onclick={(event) => { event.stopPropagation(); setTrackLiked(track, !liked); }}
            >
              <Heart size={15} fill={liked ? 'currentColor' : 'none'} />
            </button>
          </div>
        </div>

        <div class="tile-meta library-tile-meta">
          <h3 class="tile-title" class:is-active={isActive} title={track.title}>{track.title}</h3>
          <div class="library-tile-caption">
            <span class="tile-sub"><ArtistTag artist={track.artist} artists={track.artists} /></span>
            <span class="tile-duration tnum">{formatTrackDuration(track.duration)}</span>
          </div>
        </div>

        {#if infoTrack === track}{@render infoPopover(track)}{/if}
      </div>
    {/each}
  </div>
  {#if visibleCount < tracks.length}
    <button type="button" class="artist-show-more" onclick={() => visibleCount += 40}>Показать ещё <span class="tnum">{Math.min(40, tracks.length - visibleCount)}</span></button>
  {/if}
{:else}
<div class="artist-track-table" class:with-plays={hasPlayCounts}>
  <div class="artist-track-columns" aria-hidden="true">
    <span>Трек</span>
    {#if hasPlayCounts}<span class="track-plays">Прослушивания</span>{/if}
    <span class="track-date">Дата выпуска</span>
    <span class="track-duration">Время</span>
    <span></span>
  </div>
  <div class="track-row-list" class:has-open-track-menu={infoTrack !== null}>
    {#each visibleTracks as track, index (track)}
      {@const isActive = isSameTrack(track, $currentTrack)}
      {@const liked = isTrackLiked($likedTracks, track)}
      <div class="track-row-card artist-track-row interactive-item" class:is-active={isActive} class:is-banned={track.isBanned} class:has-open-menu={infoTrack === track}>
        <div class="artist-track-main">
          <button type="button" class="artist-track-play" aria-label={`Слушать «${track.title}»`} onclick={() => onplay(track, tracks)} onmouseenter={() => onpreview(track)} onmouseleave={onpreviewend}>
            <span class="artist-track-number" aria-hidden="true"><TrackStatus {index} {isActive} playing={$isPlaying} banned={track.isBanned} /></span>
            <span class="track-row-art">
              {#if track.coverUrl}
                <img src={coverUrlAtSize(coverUrlForTrack(track, $downloadedCoverCache), 120)} alt="" width="46" height="46" loading="lazy" decoding="async" />
              {:else}<span class="track-row-art-empty"><Music2 size={20} /></span>{/if}
            </span>
          </button>
          <div class="track-row-copy">
            <button type="button" class="artist-track-title track-row-title" title={track.title} onclick={() => onplay(track, tracks)}>{track.title}</button>
            <span class="track-row-artist"><ArtistTag artist={track.artist} artists={track.artists} /></span>
          </div>
        </div>
        {#if hasPlayCounts}<span class="track-plays tnum">{track.playbackCount != null ? track.playbackCount.toLocaleString('ru-RU') : '-'}</span>{/if}
        <span class="track-date tnum">{formatTrackDate(track.releaseDate)}</span>
        <span class="track-duration tnum">{formatTrackDuration(track.duration)}</span>
        <div class="track-row-actions">
          <button type="button" class="track-row-action" class:is-open={infoTrack === track} aria-label={`Информация о треке «${track.title}»`} aria-haspopup="dialog" aria-expanded={infoTrack === track} onclick={(event) => openInfo(track, event.currentTarget)}><Info size={17} /></button>
          <button type="button" class="track-row-action" class:is-liked={liked} aria-label={liked ? 'Убрать из любимых' : 'В любимые'} aria-pressed={liked} onclick={() => setTrackLiked(track, !liked)}><Heart size={17} fill={liked ? 'currentColor' : 'none'} /></button>
        </div>
        {#if infoTrack === track}{@render infoPopover(track)}{/if}
      </div>
    {/each}
  </div>
  {#if visibleCount < tracks.length}
    <button type="button" class="artist-show-more" onclick={() => visibleCount += 40}>Показать ещё <span class="tnum">{Math.min(40, tracks.length - visibleCount)}</span></button>
  {/if}
</div>
{/if}

<style>
  .artist-track-table { --columns: minmax(0, 1fr) 110px 48px 72px; }
  .artist-track-table.with-plays { --columns: minmax(0, 1fr) 120px 110px 48px 72px; }
  .artist-track-columns, .artist-track-row { display: grid; grid-template-columns: var(--columns); column-gap: 18px; }
  .artist-track-columns { padding: 0 13px 12px; color: var(--color-muted, #a3a3a3); font-size: 12px; border-bottom: 1px solid rgb(255 255 255 / 8%); }
  .artist-track-columns > :first-child { padding-left: 90px; }
  .artist-track-main { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .artist-track-play { display: flex; align-items: center; gap: 10px; flex: none; border: 0; background: none; color: inherit; padding: 0; cursor: pointer; }
  .artist-track-number { position: relative; display: grid; place-items: center; width: 26px; height: 30px; }
  .artist-track-number :global(.track-status) { position: absolute; inset: 0; width: 26px; height: 30px; margin: 0; }
  .artist-track-play:hover :global(.track-status-idle), .artist-track-play:focus-visible :global(.track-status-idle) { display: none; }
  .artist-track-play:hover :global(.track-status-play), .artist-track-play:focus-visible :global(.track-status-play) { display: flex; color: var(--color-primary); }
  .artist-track-title { border: 0; background: none; padding: 3px 0; text-align: left; cursor: pointer; width: 100%; }
  .track-plays, .track-date, .track-duration { color: var(--color-muted, #a3a3a3); font-size: 12px; text-align: right; }
  .artist-track-row { cursor: default; }
  .artist-track-row :global(.track-row-action) { opacity: 1; transform: none; }
  .artist-track-row :global(.track-row-artist) { color: var(--color-muted, #a3a3a3); }
  .artist-track-row :global(.track-row-popover) { pointer-events: auto; }
  .artist-track-row :global(.track-row-popover p) { margin: 0 0 4px; overflow-wrap: anywhere; }
  .artist-track-row :global(.track-row-popover p:last-child) { margin-bottom: 0; }
  .artist-track-row :global(.track-row-popover strong) { color: #fff; }
  /* Длительность вместо площадки: на странице артиста площадка одна и уже выбрана
     переключателем в шапке, а времени в карточном виде иначе негде взяться. */
  .artist-track-grid :global(.tile-duration) { flex: 0 0 auto; color: var(--color-muted, #a3a3a3); font-size: 11px; }
  .artist-track-grid :global(.track-row-popover) { pointer-events: auto; }
  .artist-track-grid :global(.track-row-popover p) { margin: 0 0 4px; overflow-wrap: anywhere; }
  .artist-track-grid :global(.track-row-popover p:last-child) { margin-bottom: 0; }
  .artist-track-grid :global(.track-row-popover strong) { color: #fff; }
  .artist-show-more { display: block; margin: 20px auto 0; padding: 10px 18px; border: 1px solid rgb(255 255 255 / 12%); border-radius: 10px; background: rgb(255 255 255 / 4%); color: inherit; cursor: pointer; font-size: 13px; }
  .artist-show-more span { margin-left: 8px; color: var(--color-muted, #a3a3a3); }
  button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
  @container artist-content (max-width: 760px) { .artist-track-table.with-plays { --columns: minmax(0, 1fr) 100px 44px 72px; } .track-plays { display: none; } }
  @container artist-content (max-width: 600px) { .artist-track-table, .artist-track-table.with-plays { --columns: minmax(0, 1fr) 44px 72px; } .track-date { display: none; } .artist-track-columns, .artist-track-row { column-gap: 8px; } }
  @container artist-content (max-width: 430px) { .artist-track-table, .artist-track-table.with-plays { --columns: minmax(0, 1fr) 72px; } .track-duration { display: none; } .artist-track-number { display: none; } .artist-track-columns > :first-child { padding-left: 0; } }
</style>
