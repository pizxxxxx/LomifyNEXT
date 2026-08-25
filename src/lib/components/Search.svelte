<script lang="ts">
  import { onMount } from 'svelte';
  import { Search as SearchIcon, Play, Loader2, Music, Heart, Plus, ListMusic, Check, Radio } from 'lucide-svelte';
  import { performSearch, getSoundCloudPlaylists } from '$lib/api';
  import { currentTrack, isPlaying, settings, searchQuery, searchResults, searchPlaylists, queue, searchHistory, likedTracks, playlists, notify } from '$lib/stores';
  import { getTracks } from '$lib/db';
  import ArtistTag from './ArtistTag.svelte';
  import PlaylistMenu from './PlaylistMenu.svelte';
  import TrackStatus from './TrackStatus.svelte';
  import PlaylistTrailer from './PlaylistTrailer.svelte';
  import { get } from 'svelte/store';
  import { withCount } from '$lib/utils/plural';
  import { isTrackLiked, toggleTrackLike } from '$lib/likes';

  let isLoading = false;
  let timeout: any;
  // `clearTimeout` only cancels a request that has not fired yet — it cannot abort an
  // async body that is already awaiting the network. So a slow query for "kli" could
  // resolve *after* the fast query for "klimentos" and overwrite the correct results:
  // you saw the right thing first and then it jumped to something else entirely. Every
  // run takes a generation number and only the newest one is allowed to publish.
  let searchGeneration = 0;
  let expandedPlaylistId: string | null = null;
  let activePreviewPlaylist: any = null;

  function startPlaylistPreview(e: Event, pl: any) {
    e.stopPropagation();
    activePreviewPlaylist = pl;
  }

  onMount(() => {
    if ($searchQuery.trim() !== '' && $searchResults.length === 0) {
      handleSearch({ target: { value: $searchQuery } } as any);
    }
  });

  function handleSearch(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    searchQuery.set(val);
    clearTimeout(timeout);
    // Anything still in flight is stale from here on.
    const generation = ++searchGeneration;

    if (val.trim() === '') {
      searchResults.set([]);
      searchPlaylists.set([]);
      isLoading = false;
      return;
    }

    isLoading = true;
    timeout = setTimeout(async () => {
      // Capture the query this run belongs to: `$searchQuery` keeps changing while we await.
      const query = val;
      const lowerQuery = query.toLowerCase();
      try {
        // Fetch local tracks first
        const localTracks = await getTracks();
        const filteredLocal = localTracks.filter(t =>
          t.title.toLowerCase().includes(lowerQuery) ||
          t.artist.toLowerCase().includes(lowerQuery)
        ).map(t => ({ ...t, source: 'Локальный' }));

        // Local matches show up immediately — no reason to stare at a spinner while
        // SoundCloud thinks. Still gated on the generation so a stale run stays quiet.
        if (generation === searchGeneration && filteredLocal.length > 0) {
          searchResults.set(filteredLocal);
        }

        const [onlineResults, onlinePlaylists] = await Promise.all([
          performSearch(query).catch(() => [] as any[]),
          $settings.searchSource === 'soundcloud'
            ? getSoundCloudPlaylists(query, 4).catch(() => [] as any[])
            : Promise.resolve([] as any[]),
        ]);

        if (generation !== searchGeneration) return;

        // Combine local and online results
        searchResults.set([...filteredLocal, ...(onlineResults || [])]);
        searchPlaylists.set(onlinePlaylists || []);
        isLoading = false;

        // Update history
        searchHistory.update(h => {
          const lower = lowerQuery.trim();
          if (lower) {
            const filtered = h.filter(q => q !== lower);
            return [lower, ...filtered].slice(0, 20);
          }
          return h;
        });
      } catch (err) {
        console.error('[Search] запрос не удался', err);
        if (generation === searchGeneration) isLoading = false;
      }
    }, 380);
  }

  /**
   * Флаг `isBanned` больше не глушит клик: в обработчике стояло `if (!track.isBanned)`, и
   * помеченная строка не отвечала ничем. Пометку же ставил плеер при любой неудаче с
   * получением ссылки, включая сетевую. Подробный разбор — в `playTrackList` (Library.svelte).
   */
  function playTrack(track: any) {
    if (!track) return;
    if (track.isBanned) {
      notify('Источник считал трек недоступным. Пробую ещё раз', 'info');
    }
    const idx = $searchResults.findIndex((t: any) => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set($searchResults.slice(idx + 1));
    } else {
      queue.set([]);
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function playPlaylist(pl: any) {
    if (pl.tracks && pl.tracks.length > 0) {
      queue.set(pl.tracks.slice(1));
      currentTrack.set(pl.tracks[0]);
      isPlaying.set(true);
    }
  }

  function toggleLikeSearch(track: any, e: Event) {
    e.stopPropagation();
    // Через `$lib/likes`: отметка уезжает в аккаунт Яндекса, а снятая не возвращается сверкой.
    const liked = toggleTrackLike(track);
    notify(liked ? 'Добавил в любимые' : 'Убрал из любимых', liked ? 'success' : 'info');
  }

  /**
   * Какая строка держит открытое меню плейлистов. Само меню теперь живёт в `PlaylistMenu` и
   * состояние сообщает событием — здесь оно нужно ровно для двух вещей: поднять строку по
   * z-index и не гасить ряд кнопок, пока меню на экране (иначе меню исчезало вместе с рядом,
   * стоило курсору съехать со строки).
   */
  let showPlaylistMenuId: string | null = null;
</script>

<div class="max-w-6xl mx-auto py-8 px-4 w-full flex flex-col">
  <div class="relative group mb-8 flex-shrink-0">
    <div class="absolute inset-y-0 left-4 flex items-center pointer-events-none text-neutral-400 group-focus-within:text-primary transition-colors z-10">
      <SearchIcon size={24} />
    </div>
    <input 
      type="text" 
      placeholder="Что будем слушать?" 
      class="w-full h-16 surface !rounded-2xl pl-14 pr-6 text-xl font-normal tracking-[-0.01em] text-white placeholder-neutral-500 outline-none ring-0 focus:outline-none focus:ring-0 transition-all"
      bind:value={$searchQuery}
      on:input={handleSearch}
    />
  </div>

  <div class="flex-1 min-h-0">
    {#if isLoading}
      <div class="flex items-center justify-center h-40">
        <Loader2 class="animate-spin text-white/50 w-8 h-8" />
      </div>
    {:else if $searchResults.length === 0 && $searchPlaylists.length === 0 && $searchQuery.trim() !== ''}
      <div class="py-20 px-10 plate mt-10 flex flex-col items-start">
        <SearchIcon size={26} class="mb-5 text-white/20" />
        <p class="display-title">По «{$searchQuery}» — ничего</p>
        <p class="empty-hint">Бывает, что название написано иначе. Попробуй короче или поищи по исполнителю.</p>
      </div>
    {:else if $searchResults.length > 0 || $searchPlaylists.length > 0}
      <div class="space-y-8">
        
        {#if $searchPlaylists.length > 0}
          <div class="animate-in fade-in slide-in-from-bottom-4">
            <h2 class="section-title mb-6 ml-2 flex items-center gap-3">
              <ListMusic class="text-primary" /> Плейлисты
            </h2>
            <div class="track-collection grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 p-2">
              {#each $searchPlaylists as pl}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <!-- `transition-all duration-500` здесь анимировал раскладку: по клику
                     плитка получает `col-span-full`, другой фон, отступы и радиус, и все
                     полсекунды браузер перекладывал сетку на каждом кадре. Подъём и
                     свечение карточки даёт `interactive-item`, ему переход не нужен. -->
                <div class="{expandedPlaylistId === pl.id ? 'col-span-full bg-black/40 backdrop-blur-md rounded-3xl p-6 shadow-2xl border border-primary/20 flex flex-col md:flex-row gap-6 items-start' : 'w-full flex flex-col'} w-full group cursor-pointer interactive-item"
                     on:click={() => { expandedPlaylistId = (expandedPlaylistId === pl.id ? null : pl.id); }}>

                  <!-- `spec-art` — глянцевая поверхность: по ней ходит отражение света,
                       положение которого считается из наклона (`$lib/utils/tilt`). Бегущей
                       полосы здесь нет намеренно — один блик на поверхность. Свой
                       `-translate-y-1` убран: карточка уже поднимается целиком. -->
                  <div class="{expandedPlaylistId === pl.id ? 'w-full md:w-64 aspect-square shrink-0' : 'w-full aspect-square mb-3'} rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 border border-white/5 transition-colors duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] spec-art art-glow">
                    {#if pl.tracks && pl.tracks.length > 0 && pl.tracks[0].coverUrl}
                      <img src={pl.tracks[0].coverUrl} alt="Cover" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                    {:else}
                      <div class="w-full h-full flex items-center justify-center text-neutral-500">
                        <ListMusic size={32} />
                      </div>
                    {/if}
                    
                    <!-- Hover Overlay with Wave Preview Button -->
                    <div class="{expandedPlaylistId === pl.id ? 'hidden' : 'absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4'}">
                      <button 
                        class="bg-white/20 hover:bg-white/40 backdrop-blur-md text-white rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                        on:click|stopPropagation={(e) => startPlaylistPreview(e, pl)}
                        title="Превью плейлиста"
                      >
                        <Radio size={20} />
                      </button>
                      <button 
                        class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300 delay-75"
                        on:click|stopPropagation={() => {
                          if (pl.tracks && pl.tracks.length > 0) {
                            queue.set(pl.tracks.slice(1));
                            currentTrack.set(pl.tracks[0]);
                            isPlaying.set(true);
                          }
                        }}
                        title="Слушать"
                      >
                        <Play fill="currentColor" size={20} />
                      </button>
                    </div>
                  </div>
                  
                  <!-- Metadata. `transition-all duration-500` снят по всей группе: между
                       состояниями здесь меняются только раскладка (`flex-1`, отступы),
                       размер иконки и типографика — то есть ровно то, что анимировать
                       нельзя (раскладка) или невозможно (атрибуты `width`/`height` у SVG
                       переходами не едут). Полсекунды браузер честно перекладывал сетку. -->
                  <div class="{expandedPlaylistId === pl.id ? 'flex-1 min-w-0 w-full' : 'px-1 relative w-full'}">
                    <div class="flex items-center gap-3 {expandedPlaylistId === pl.id ? 'mb-6' : ''}">
                      <ListMusic size={expandedPlaylistId === pl.id ? 28 : 14} class="text-primary shrink-0" />
                      <div class="{expandedPlaylistId === pl.id ? 'display-title whitespace-normal' : 'text-[14px] font-medium truncate text-white'}">{pl.title}</div>
                    </div>
                    
                    {#if expandedPlaylistId === pl.id}
                      <div class="flex items-center gap-4 mb-6">
                        <button 
                          class="bg-primary hover:bg-primary/80 text-black px-6 py-3 rounded-full font-bold shadow-[0_0_20px_var(--color-primary)] transition-all flex items-center gap-2 transform hover:scale-105"
                          on:click|stopPropagation={() => {
                            if (pl.tracks && pl.tracks.length > 0) {
                              queue.set(pl.tracks.slice(1));
                              currentTrack.set(pl.tracks[0]);
                              isPlaying.set(true);
                            }
                          }}
                        >
                          <Play fill="currentColor" size={20} />
                          Слушать все
                        </button>
                        <button 
                          class="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
                          on:click|stopPropagation={(e) => startPlaylistPreview(e, pl)}
                        >
                          <Radio size={20} />
                          Трейлер
                        </button>
                        {#if $playlists.some(p => p.title === pl.title || p.id === pl.id)}
                          <button 
                            class="bg-green-500/20 border border-green-500/30 text-green-400 px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2 transform hover:scale-105"
                            on:click|stopPropagation={() => {
                              playlists.update(p => p.filter(x => x.title !== pl.title && x.id !== pl.id));
                              notify(`Убрал «${pl.title}» из медиатеки`, 'info');
                            }}
                          >
                            <Check size={20} />
                            В медиатеке
                          </button>
                        {:else}
                          <button 
                            class="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2 transform hover:scale-105"
                            on:click|stopPropagation={() => {
                              playlists.update(p => [...p, {
                                id: pl.id || Date.now().toString(),
                                title: pl.title,
                                tracks: pl.tracks || [],
                                coverUrl: pl.coverUrl || (pl.tracks && pl.tracks[0]?.coverUrl) || ''
                              }]);
                              notify(`«${pl.title}» теперь в медиатеке`, 'success');
                            }}
                          >
                            <Plus size={20} />
                            Добавить
                          </button>
                        {/if}
                        <div class="text-white/40 text-sm ml-auto font-medium bg-black/20 px-4 py-2 rounded-xl">
                          {withCount(pl.tracks?.length || 0, 'трек', 'трека', 'треков')}
                        </div>
                      </div>
                      
                      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[350px] overflow-y-auto custom-scrollbar pr-2">
                        {#each pl.tracks as pt, i}
                          <!-- svelte-ignore a11y-click-events-have-key-events -->
                          <!-- svelte-ignore a11y-no-static-element-interactions -->
                          <div class="flex items-center gap-3 p-2 rounded-xl transition-colors group/ptrack cursor-pointer {$currentTrack?.title === pt.title ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/10'}"
                               on:click|stopPropagation={() => {
                                  queue.set(pl.tracks.slice(i + 1));
                                  currentTrack.set(pt);
                                  isPlaying.set(true);
                               }}>
                            <div class="w-10 h-10 rounded-md overflow-hidden bg-transparent shrink-0 relative shadow-md">
                              <img src={pt.coverUrl || 'lomimi.png'} alt="Cover" class="w-full h-full object-cover" />
                              <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/ptrack:opacity-100 flex items-center justify-center transition-opacity">
                                <Play fill="currentColor" size={16} class="text-white" />
                              </div>
                            </div>
                            <div class="flex flex-col min-w-0 flex-1">
                              <div class="text-sm font-bold truncate transition-colors {$currentTrack?.title === pt.title ? 'text-primary' : 'text-white group-hover/ptrack:text-primary'}">{pt.title}</div>
                              <div class="text-[11px] text-neutral-400 min-w-0">
                                <ArtistTag artist={pt.artist} artists={pt.artists} />
                              </div>
                            </div>
                            <div class="opacity-0 group-hover/ptrack:opacity-100 transition-opacity">
                              <button 
                                class="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-all"
                                on:click|stopPropagation={(e) => toggleLikeSearch(pt, e)}
                              >
                                {#if isTrackLiked($likedTracks, pt)}
                                  <Heart size={14} fill="#00e5ff" class="text-[#00e5ff]" />
                                {:else}
                                  <Heart size={14} />
                                  {/if}
                              </button>
                            </div>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <div class="text-neutral-400 text-[12px] mt-0.5">{withCount(pl.tracks?.length || 0, 'трек', 'трека', 'треков')}</div>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if $searchResults.length > 0}
          <div class="space-y-4 animate-in fade-in slide-in-from-bottom-4" style="animation-delay: 100ms">
            <h2 class="section-title mb-6 ml-2">Треки</h2>
            <div class="track-collection flex flex-col gap-2 p-2">
          {#each $searchResults as track, i}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <!-- `hover:-translate-y-1 hover:shadow-lg` убраны: подъём и тень строке уже
                 даёт `interactive-item`, причём тень — заранее отрисованным псевдоэлементом.
                 Два подъёма складывались в 8px и дёргались, а `hover:shadow-lg` заставлял
                 браузер перерисовывать тень на каждом кадре. `transition-all` сужен до
                 цветов — двигать здесь больше нечего. -->
            <div
              class="relative flex items-center gap-4 group rounded-xl p-3 transition-colors w-full cursor-pointer interactive-item {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'} {track.isBanned ? 'opacity-60' : ''} {showPlaylistMenuId === (track.id || track.title) ? 'z-[60]' : 'hover:z-50'}"
              on:click={() => playTrack(track)}
            >
              <TrackStatus index={i} {isActive} playing={$isPlaying} banned={track.isBanned} size="md" />
              <div class="relative w-12 h-12 shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800">
                {#if track.coverUrl}
                  <img src={track.coverUrl} alt="Cover" class="w-full h-full object-cover" />
                {:else}
                  <div class="w-full h-full flex items-center justify-center text-neutral-500">
                    <Music size={20} />
                  </div>
                {/if}
              </div>
              <div class="flex flex-col flex-1 min-w-0 pr-4">
                <span class="font-bold text-[15px] truncate {isActive ? 'text-primary' : 'text-white'}">{track.title}</span>
                <span class="text-neutral-400 text-[13px] mt-0.5 min-w-0">
                  <ArtistTag artist={track.artist} artists={track.artists} />
                </span>
              </div>
              <div class="flex items-center gap-2 {showPlaylistMenuId === (track.id || track.title) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity pr-2 relative">
                <button aria-label="Like" class="p-2 hover:bg-white/10 rounded-full transition-colors text-white" on:click={(e) => toggleLikeSearch(track, e)}>
                   {#if isTrackLiked($likedTracks, track)}
                     <Heart size={18} fill="var(--color-primary)" class="text-primary" />
                   {:else}
                     <Heart size={18} />
                   {/if}
                </button>
                <PlaylistMenu
                  {track}
                  placement="top"
                  align="right"
                  on:toggle={(e) => showPlaylistMenuId = e.detail ? (track.id || track.title) : null}
                  buttonClass="p-2 hover:bg-white/10 rounded-full transition-colors text-white"
                />
              </div>
            </div>
          {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else if $searchQuery.trim() === ''}
      <div class="mt-4 mb-8">
        <div class="flex items-center justify-between mb-4 px-2">
          <h2 class="section-title">История поиска</h2>
          {#if $searchHistory.length > 0}
            <button class="text-xs text-neutral-400 hover:text-white transition-colors" on:click={() => searchHistory.set([])}>Очистить</button>
          {/if}
        </div>
        {#if $searchHistory.length > 0}
          <div class="flex flex-wrap gap-3 px-2">
            {#each $searchHistory as hist}
              <button 
                class="px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/20 transition-all text-sm font-medium flex items-center gap-2"
                on:click={() => { searchQuery.set(hist); handleSearch({ target: { value: hist } } as any); }}
              >
                <SearchIcon size={14} class="opacity-50" />
                {hist}
              </button>
            {/each}
          </div>
        {:else}
          <div class="plate mx-2 p-8 flex flex-col items-start">
            <SearchIcon size={26} class="text-white/20 mb-4" />
            <h3 class="display-title">История пустая</h3>
            <p class="empty-hint">Что найдёшь — сохраню здесь, чтобы не набирать заново.</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if activePreviewPlaylist}
  <PlaylistTrailer playlist={activePreviewPlaylist} onClose={() => activePreviewPlaylist = null} />
{/if}
