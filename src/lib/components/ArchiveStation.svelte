<script lang="ts">
  import { onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { currentTrack, isPlaying, queue, globalVolume, likedTracks, settings, playlists, notify } from '$lib/stores';
  import { Play, Pause, Info, ListMusic, Radio, Heart } from 'lucide-svelte';
  import { Plus as PlusIcon, Check as CheckIcon } from 'lucide';
  import { MorphIcon } from 'morphicons/svelte';
  import ArtistTag from './ArtistTag.svelte';
  import PlaylistTrailer from './PlaylistTrailer.svelte';
  import { getAudioUrl } from '$lib/api';
  import { toggleTrackLike } from '$lib/likes';
  import { withCount } from '$lib/utils/plural';

  export let title: string = "Полка";
  export let tracks: any[] = [];
  /**
   * Полки, где в поле автора лежит подпись, а не аккаунт (например «Похожие авторы»),
   * ставят false — иначе имя выглядит ссылкой, а ведёт на пустой профиль.
   */
  export let artistLinks = true;
  
  let previewAudio: HTMLAudioElement | null = null;
  let hoverTimer: any = null;
  let hoveredTrack: any = null;
  let previewGeneration = 0;

  function trackKey(track: any, index = 0) {
    if (track?.id != null && `${track.id}` !== '') return `${track.source || 'track'}:${track.id}:${index}`;
    return `${track?.title || 'track'}\u0000${track?.artist || ''}\u0000${index}`;
  }

  function likedKey(track: any) {
    return `${track?.title || ''}\u0000${track?.artist || ''}`;
  }

  // isTrackLiked делает линейный проход. На полке это было по два прохода на каждую
  // карточку при любом обновлении стора; Set оставляет ту же семантику, но O(1) на плитку.
  $: likedKeys = new Set(($likedTracks || []).map(likedKey));
  function isLiked(track: any) {
    return likedKeys.has(likedKey(track));
  }

  /**
   * Карточке шириной ~200px не всегда нужна 500px-текстура. SoundCloud и Яндекс умеют
   * отдавать один и тот же арт в нескольких размерах; srcset разрешает WebView выбрать
   * меньший на обычном DPI, не ухудшая резкость на плотном экране.
   */
  function coverSrcSet(url: string | undefined) {
    if (!url) return '';
    const small = url
      .replace(/t500x500|t400x400/g, 't300x300')
      .replace(/([/_-])400x400(?=\b|[./_-])/g, '$1' + '300x300');
    return small === url ? '' : `${small} 300w, ${url} 500w`;
  }

  function isPlaylistSaved(playlist: any, library: any[]) {
    return library.some(item => item.title === playlist.title || item.id === playlist.id);
  }

  onDestroy(() => {
    stopHoverPreview();
  });

  async function handleMouseEnter(track: any) {
    // Performance mode must not quietly keep a second decoder/network stream alive just
    // because the pointer rested on an artwork.
    if ($settings.perfMode || !$settings.enableHoverPreview) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoveredTrack = track;
    const generation = ++previewGeneration;
    hoverTimer = setTimeout(async () => {
      try {
        const url = await getAudioUrl(track, { silent: true });
        if (generation !== previewGeneration || hoveredTrack !== track || !url || $settings.perfMode) return;
        if (!previewAudio) previewAudio = new Audio();
        if (previewAudio) {
          previewAudio.src = url;
          previewAudio.volume = Math.pow($globalVolume, 3);
          const durSecs = (track.duration || 0) / 1000;
          if (durSecs > 60) {
            previewAudio.currentTime = durSecs * 0.3;
          }
          previewAudio.play().catch(() => {});
        }
      } catch(e) {}
    }, $settings.hoverPreviewDelay);
  }

  function stopHoverPreview() {
    previewGeneration += 1;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    hoveredTrack = null;
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
  }

  function handleMouseLeave() {
    stopHoverPreview();
  }

  $: if ($settings.perfMode) stopHoverPreview();

  $: if (previewAudio) {
    previewAudio.volume = Math.pow($globalVolume, 3);
  }

  /**
   * `isBanned` здесь тоже перестал быть запретом (разбор — в `playTrackList` из
   * Library.svelte). На полках это почти незаметно: `getHomeFeed` в api.ts и так отсеивает
   * недоступные треки, поэтому помеченные сюда попадают редко — но когда попадали, плитка
   * не отвечала на клик вообще.
   */
  function playTrack(track: any, index: number) {
    if (!track) return;
    if ($currentTrack?.title === track.title) {
      isPlaying.update(p => !p);
      return;
    }
    if (track.isBanned) {
      notify('Этот источник недавно не отвечал. Пробую запустить трек ещё раз.', 'info');
    }

    // Set queue to the remaining tracks in this shelf
    queue.set(tracks.slice(index + 1).filter(t => !t.tracks));
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function toggleLike(e: MouseEvent, track: any) {
    e.stopPropagation();
    // Через `$lib/likes`: отметка уезжает в аккаунт Яндекса, а снятая не возвращается сверкой.
    toggleTrackLike(track);
  }

  let activePreviewPlaylist: any = null;
  let expandedPlaylistId: string | null = null;
  
  function startPlaylistPreview(e: Event, pl: any) {
    e.stopPropagation();
    activePreviewPlaylist = pl;
  }
</script>

{#if tracks.length > 0}
  <div class="space-y-4">
    <!-- Shelf Header (similar to SubShelf label) -->
    <div class="flex items-center gap-3 pl-1 mb-2">
      <span class="text-xs font-bold uppercase tracking-[0.15em] text-white/60">
        {title}
      </span>
      <span class="h-px flex-1 bg-white/[0.05]"></span>
    </div>

    <!-- Grid Track List -->
    <div class="track-collection grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 pb-4 pt-4 px-2" style="grid-auto-flow: dense;">
      {#each tracks as track, index (trackKey(track, index))}
        {#if track.tracks}
          {@const isOpen = expandedPlaylistId === track.id}
          <!-- Playlist Tile -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <!-- Геометрия обоих состояний переехала в `.pl-tile` (app.css) — там же разбор,
               почему смена `grid-column` остаётся мгновенной, а плавным делается только
               содержимое раскрытой панели.

               `interactive-item` есть только у сложенной плитки, и это ровно то, о чём
               просили: класс — корень 3D-наклона (`CARD_ROOT` в `$lib/utils/tilt`), скрипт
               вешает на него `data-tilt`, а правило `[data-tilt] .art-glow` наклоняет
               обложку. На раскрытой панели наклон и подъём не нужны: панель во всю ширину,
               с матовым стеклом, и любое её движение под курсором — это перерисовка
               `backdrop-filter` вместе со всем, что под ним. -->
          <div class="pl-tile {isOpen ? 'is-open' : 'interactive-item'} group"
               on:click={() => { expandedPlaylistId = isOpen ? null : track.id; }}>

            <div class="{isOpen ? 'pl-tile-art-open' : 'w-full aspect-[2/1] mb-3 spec-art art-glow'} rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 border border-white/5">
              {#if track.tracks && track.tracks.length > 0 && track.tracks[0].coverUrl}
                <img
                  src={track.tracks[0].coverUrl}
                  srcset={coverSrcSet(track.tracks[0].coverUrl)}
                  sizes="(min-width: 1280px) 220px, (min-width: 768px) 25vw, 50vw"
                  alt="Cover"
                  loading="lazy"
                  decoding="async"
                  width="500"
                  height="500"
                  class="w-full h-full object-cover {isOpen ? '' : 'transition-transform duration-500 group-hover:scale-105'}"
                />
              {:else}
                <div class="w-full h-full flex items-center justify-center text-neutral-500">
                  <ListMusic size={32} />
                </div>
              {/if}

              <!-- Hover Overlay with Wave Preview Button -->
              <div class="{isOpen ? 'hidden' : 'absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4'}">
                <button
                  class="bg-white/20 hover:bg-white/40 backdrop-blur-md text-white rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                  on:click|stopPropagation={(e) => startPlaylistPreview(e, track)}
                  title="Превью плейлиста"
                >
                  <Radio size={20} />
                </button>
                <button
                  class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300 delay-75"
                  on:click|stopPropagation={() => {
                    if (track.tracks && track.tracks.length > 0) {
                      queue.set(track.tracks.slice(1));
                      currentTrack.set(track.tracks[0]);
                      isPlaying.set(true);
                    }
                  }}
                  title="Слушать"
                >
                  <Play fill="currentColor" size={20} />
                </button>
              </div>
            </div>

            <!-- Metadata.
                 Здесь на трёх узлах подряд стоял `transition-all duration-500`, и вместе с
                 раскрытием менялись как раз те свойства, которые `all` под собой прячет:
                 кегль заголовка (14px ↔ `display-title`), обрезка, отступы, размер иконки.
                 Пол секунды браузер пересчитывал текст и раскладку на каждом кадре — это и
                 был «лаг» при открытии плейлиста, причём ровно в тот момент, когда рядом
                 достраивался список треков. Ни один из этих переходов не был виден как
                 анимация: они читались только как задержка. -->
            <div class="{isOpen ? 'flex-1 min-w-0 w-full' : 'px-1 relative w-full'}">
              <div class="flex items-center gap-3 {isOpen ? 'mb-6' : ''}">
                <ListMusic size={isOpen ? 28 : 14} class="text-primary shrink-0" />
                <div class="{isOpen ? 'display-title whitespace-normal' : 'text-[14px] font-medium truncate text-white'}">{track.title}</div>
              </div>

              {#if isOpen}
                <!-- Содержимое въезжает `opacity` + `transform`: это единственные два
                     свойства, которые браузер отдаёт композитору, поэтому анимация идёт
                     мимо пересчёта раскладки — той самой, что уже случилась мгновенно
                     кадром раньше. Только на вход: обратно панель складывается сразу, и
                     уезжающий текст в двухколоночной плитке выглядел бы как мусор. -->
                <div in:fly={{ y: 10, duration: 260, easing: cubicOut }}>
                <div class="flex items-center gap-4 mb-6">
                  <button
                    class="bg-primary hover:bg-primary/80 text-black px-6 py-3 rounded-full font-bold shadow-[0_0_20px_var(--color-primary)] transition-all flex items-center gap-2 transform hover:scale-105"
                    on:click|stopPropagation={() => {
                      if (track.tracks && track.tracks.length > 0) {
                        queue.set(track.tracks.slice(1));
                        currentTrack.set(track.tracks[0]);
                        isPlaying.set(true);
                      }
                    }}
                  >
                    <Play fill="currentColor" size={20} />
                    Слушать все
                  </button>
                  <button
                    class="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
                    on:click|stopPropagation={(e) => startPlaylistPreview(e, track)}
                  >
                    <Radio size={20} />
                    Трейлер
                  </button>
                  <button
                    class={isPlaylistSaved(track, $playlists)
                      ? 'bg-green-500/20 border border-green-500/30 text-green-400 px-6 py-3 rounded-full font-bold transition-colors flex items-center gap-2'
                      : 'bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-full font-bold transition-colors flex items-center gap-2'}
                    aria-pressed={isPlaylistSaved(track, $playlists)}
                    aria-label={isPlaylistSaved(track, $playlists) ? `Убрать «${track.title}» из медиатеки` : `Добавить «${track.title}» в медиатеку`}
                    on:click|stopPropagation={() => {
                      if (isPlaylistSaved(track, $playlists)) {
                        playlists.update(p => p.filter(pl => pl.title !== track.title && pl.id !== track.id));
                        notify(`Трек «${track.title}» убран из медиатеки.`, 'info');
                      } else {
                        playlists.update(p => [...p, {
                          id: track.id || Date.now().toString(),
                          title: track.title,
                          tracks: track.tracks || [],
                          coverUrl: track.coverUrl || (track.tracks && track.tracks[0]?.coverUrl) || ''
                        }]);
                        notify(`Трек «${track.title}» добавлен в медиатеку.`, 'success');
                      }
                    }}
                  >
                    <MorphIcon
                      icon={isPlaylistSaved(track, $playlists) ? CheckIcon : PlusIcon}
                      size={20}
                      spring="snappy"
                      reducedMotion="user"
                    />
                    {isPlaylistSaved(track, $playlists) ? 'В медиатеке' : 'Добавить'}
                  </button>
                  <div class="text-white/40 text-sm ml-auto font-medium bg-black/20 px-4 py-2 rounded-xl">
                    {withCount(track.tracks?.length || 0, 'трек', 'трека', 'треков')}
                  </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[350px] overflow-y-auto custom-scrollbar pr-2">
                  {#each track.tracks as pt, i (trackKey(pt, i))}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <!-- `pl-open-track` (app.css) снимает с невидимых строк отрисовку: в
                         плейлисте бывает пятьдесят треков, а в окно списка влезает шесть. -->
                    <div class="pl-open-track flex items-center gap-3 p-2 rounded-xl transition-colors group/ptrack cursor-pointer {$currentTrack?.title === pt.title ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/10'}"
                         on:click|stopPropagation={() => {
                            queue.set(track.tracks.slice(i + 1));
                            currentTrack.set(pt);
                            isPlaying.set(true);
                         }}>
                      <div class="w-10 h-10 rounded-md overflow-hidden bg-transparent shrink-0 relative shadow-md">
                        <img
                          src={pt.coverUrl || 'lomimi.png'}
                          srcset={coverSrcSet(pt.coverUrl)}
                          sizes="40px"
                          alt="Cover"
                          loading="lazy"
                          decoding="async"
                          width="40"
                          height="40"
                          class="w-full h-full object-cover"
                        />
                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/ptrack:opacity-100 flex items-center justify-center transition-opacity">
                          <Play fill="currentColor" size={16} class="text-white" />
                        </div>
                      </div>
                      <div class="flex flex-col min-w-0 flex-1">
                        <div class="text-sm font-bold truncate transition-colors {$currentTrack?.title === pt.title ? 'text-primary' : 'text-white group-hover/ptrack:text-primary'}">{pt.title}</div>
                        <div class="text-[11px] text-neutral-400 min-w-0">
                          <ArtistTag artist={pt.artist} artists={pt.artists} linkable={artistLinks} />
                        </div>
                      </div>
                      <div class="opacity-0 group-hover/ptrack:opacity-100 transition-opacity">
                        <button
                          class="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-all"
                          on:click|stopPropagation={(e) => toggleLike(e, pt)}
                        >
                          {#if isLiked(pt)}
                            <Heart size={14} fill="#00e5ff" class="text-[#00e5ff]" />
                          {:else}
                            <Heart size={14} />
                          {/if}
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
                </div>
              {:else}
                <div class="text-neutral-400 text-[12px] mt-0.5">{withCount(track.tracks?.length || 0, 'трек', 'трека', 'треков')}</div>
              {/if}
            </div>
          </div>
        {:else}
          <!-- Normal Track Tile -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
               class="track-tile w-full group interactive-item cursor-pointer rounded-[1.25rem] {track.isBanned ? 'opacity-60' : ''}"
               class:is-active={$currentTrack?.title === track.title}
               on:click={() => playTrack(track, index)}>
            
            <!-- Cover. `spec-art` — глянцевая поверхность: по ней ходит отражение света,
                 положение которого считается из наклона обложки (`$lib/utils/tilt`).
                 Бегущей полосы здесь нет намеренно — один блик на поверхность. -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="tile-art spec-art" class:is-active={$currentTrack?.title === track.title}
                 on:mouseenter={() => handleMouseEnter(track)}
                 on:mouseleave={handleMouseLeave}>
              <img
                src={track.coverUrl || 'lomimi.png'}
                srcset={coverSrcSet(track.coverUrl)}
                sizes="(min-width: 1280px) 220px, (min-width: 768px) 25vw, 50vw"
                alt={track.title}
                loading="lazy"
                decoding="async"
                width="500"
                height="500"
                class="tile-cover-image"
              />
              
              <!-- Hover Play Overlay -->
              <div class="tile-cover-overlay">
                <button
                  type="button"
                  class="tile-play-button {track.isBanned ? 'is-muted' : ''}"
                  aria-label={$currentTrack?.title === track.title && $isPlaying ? `Поставить «${track.title}» на паузу` : `Воспроизвести «${track.title}»`}
                >
                  {#if $currentTrack?.title === track.title && $isPlaying}
                    <Pause fill="currentColor" size={20} />
                  {:else}
                    <Play fill="currentColor" size={20} />
                  {/if}
                </button>
                <button 
                  type="button"
                  class="tile-like-button"
                  class:is-liked={isLiked(track)}
                  on:click={(e) => toggleLike(e, track)}
                  title="Мне нравится"
                  aria-label={`Отметить «${track.title}» как понравившийся`}
                >
                  {#if isLiked(track)}
                    <Heart size={16} fill="currentColor" />
                  {:else}
                    <Heart size={16} />
                  {/if}
                </button>
                <!-- Hover Progress Bar -->
                {#if $settings.enableHoverPreview && !$settings.perfMode}
                  <div
                    class="tile-preview-progress"
                    class:is-previewing={hoveredTrack?.title === track.title}
                    style={`--preview-duration: ${$settings.hoverPreviewDelay}ms`}
                  >
                  </div>
                {/if}
              </div>
            </div>
            
            <!-- Metadata -->
            <div class="tile-meta group/info">
              <div class="flex justify-between items-start gap-1">
                <div class="min-w-0 flex-1">
                  <h3 class="tile-title" class:is-active={$currentTrack?.title === track.title} title={track.title}>{track.title}</h3>
                  <div class="tile-sub">
                    <ArtistTag artist={track.artist} artists={track.artists} linkable={artistLinks} />
                  </div>
                </div>
                <!-- Info Button -->
                <button class="tile-info-btn shrink-0" on:click|stopPropagation aria-label="Информация">
                  <Info size={15} />
                </button>
              </div>

              <!-- Tooltip: описание трека — это список «свойство → значение», поэтому
                   и разметка списочная: подписи гаснут, значения читаются. -->
              <div class="absolute bottom-full left-0 mb-2 w-60 hidden group-hover/info:block z-50">
                <dl class="tile-tip pointer-events-none">
                  <dt>Автор</dt>
                  <dd>{track.artist}</dd>
                  {#if track.playbackCount != null}
                    <dt>Прослушиваний SC</dt>
                    <dd class="tnum">{track.playbackCount.toLocaleString('ru-RU')}</dd>
                  {/if}
                  {#if track.releaseDate}
                    <dt>Выпущен</dt>
                    <dd class="tnum">{new Date(track.releaseDate).toLocaleDateString('ru-RU')}</dd>
                  {/if}
                  {#if track.genre}
                    <dt>Жанр</dt>
                    <dd>{track.genre}</dd>
                  {/if}
                </dl>
              </div>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}

{#if activePreviewPlaylist}
  <PlaylistTrailer playlist={activePreviewPlaylist} onClose={() => activePreviewPlaylist = null} />
{/if}
