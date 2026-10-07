<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Loader2, User, UserPlus, Check, Disc, X, ListMusic, ChevronLeft, ChevronDown, Music2 } from 'lucide-svelte';
  import { Play as PlayData, Pause as PauseData, LayoutGrid as LayoutGridData, List as ListData } from 'lucide';
  import { MorphIcon } from 'morphicons/svelte';
  import { currentArtist, currentTrack, isPlaying, queue, settings, effectivePerformanceMode, globalVolume, notify } from '$lib/stores';
  import { pageAtmosphere } from '$lib/stores';
  import { setGlassQueueContext } from '$lib/liquidGlass';
  import LiquidGlassMediaHeader from './LiquidGlassMediaHeader.svelte';
  import LiquidGlassTrackList from './LiquidGlassTrackList.svelte';
  import { stopWave, waveActive } from '$lib/wave';
  import { getArtistTracks, getAudioUrl, getArtistAlbums, getArtistProfile, getAlbumTracks, trackByArtist, type ArtistSource } from '$lib/api';
  import ArtistTrackList from './ArtistTrackList.svelte';
  import SelectMenu from './SelectMenu.svelte';
  import { withCount } from '$lib/utils/plural';
  import { ARTIST_TRACK_SORT_KEY, ARTIST_TRACK_SORT_OPTIONS, sortArtistTracks, type ArtistTrackSort } from '$lib/utils/artistTracks';

  let tracks: any[] = [];
  let trackSort: ArtistTrackSort = 'popular';
  $: sortedTracks = sortArtistTracks(tracks, trackSort, artistSource);
  $: glassTopTracks = sortArtistTracks(tracks, 'popular', artistSource);
  let artistDescription = '';
  let artistLocation = '';
  let aboutOpen = false;

  function changeTrackSort(value: string | number) {
    trackSort = value as ArtistTrackSort;
    handleMouseLeave();
    try { localStorage.setItem(ARTIST_TRACK_SORT_KEY, trackSort); } catch {}
  }

  /**
   * Список или плитка - тот же выбор, что у любимых треков, и он запоминается отдельно от
   * них: у артиста интересны обложки релизов, в своих лайках - быстрый просмотр названий,
   * и один общий переключатель на два экрана каждый раз ломал бы привычку на другом.
   */
  const ARTIST_TRACK_VIEW_KEY = 'lomify-artist-track-view';
  let trackView: 'list' | 'tiles' = 'list';

  function toggleTrackView() {
    trackView = trackView === 'list' ? 'tiles' : 'list';
    handleMouseLeave();
    try { localStorage.setItem(ARTIST_TRACK_VIEW_KEY, trackView); } catch {}
  }
  let isLoading = true;
  // Площадка страницы — локальный выбор. Переключение профиля не должно заодно менять
  // источник поиска, главной ленты и рекомендаций во всём приложении.
  let artistSource: ArtistSource = $settings.searchSource === 'yandex' && $settings.yandexToken
    ? 'yandex'
    : 'soundcloud';
  // Two sources for the same slot: the SoundCloud profile picture (right, when we're sure
  // it's the same account) and the artwork of the first track (always available). Keeping
  // them apart means whichever resolves second can't blank out the other.
  let profileAvatarUrl = '';
  let trackAvatarUrl = '';
  $: artistAvatarUrl = profileAvatarUrl || trackAvatarUrl;
  let artistBannerUrl = '';
  let artistVerified = false;
  $: artistFollowed = $settings.followedArtists.some(item => item.name === $currentArtist && item.source === artistSource);
  function toggleGlassFollow() {
    settings.update(value => ({ ...value, followedArtists: artistFollowed
      ? value.followedArtists.filter(item => item.name !== $currentArtist || item.source !== artistSource)
      : [...value.followedArtists, { name: $currentArtist, source: artistSource }] }));
    window.dispatchEvent(new Event('lomify:artist-follow'));
    if (!artistFollowed) notify('Подписка сохранена в Lomify. Новые релизы появятся на главной.', 'success');
  }
  $: glassAlbum = albums.find(album => album.id === expandedAlbum);
  $: pageAtmosphere.set($settings.design === 'liquid-glass'
    ? { url: glassAlbum?.coverUrl || glassAlbum?.tracks?.[0]?.coverUrl || artistBannerUrl || artistAvatarUrl, derived: !artistBannerUrl || !!glassAlbum } : null);
  let artistFollowers = 0;
  // Слушателей за месяц отдаёт Яндекс Музыка (`stats.lastMonthListeners`). У SoundCloud
  // такого числа нет, там есть подписчики — поэтому два поля, а не одно: подписать одно
  // число двумя разными подписями нельзя, а сложить их вместе — соврать.
  let artistListeners = 0;
  /**
   * Сколько людей держат артиста в избранном (Яндекс, `artist.likesCount`).
   *
   * Это НЕ прослушивания: по треку Музыка счётчиков не отдаёт вовсе — ни в `/tracks/{id}`, ни
   * в `/tracks/{id}/supplement`. Слушатели за месяц по артисту и это число — всё, что вообще
   * существует, поэтому подпись говорит именно «в избранном», а не «прослушиваний».
   */
  let artistLikes = 0;
  let totalPlaybackCount = 0;
  /**
   * Сколько у артиста треков и релизов по данным источника, а не по длине загруженного
   * списка. В шапке показывается это число, если оно есть: список ограничен сверху (см.
   * `limit` в `yandexArtistTracks`), и «300 треков» у артиста с тысячей — неправда так же,
   * как прежние «6 треков» у артиста с сотней.
   */
  let catalogTrackCount = 0;
  let catalogAlbumCount = 0;
  $: shownTrackCount = Math.max(catalogTrackCount, tracks.length);

  /**
   * Аватар во весь экран. Открывается по клику на кружок в шапке: в шапке он около 120px, а
   * у Музыки и SoundCloud та же картинка есть в размере, который стоит рассмотреть.
   */
  let lightboxUrl = '';

  /**
   * Тот же адрес, но в размере для просмотра.
   *
   * У Яндекса размер — часть пути раздачи (`…/400x400`), у SoundCloud — суффикс имени файла
   * (`-t500x500.jpg`, где есть и `-original`). Оба меняются подстановкой, и оба безопасны:
   * если формат адреса не тот, что ожидался, возвращается исходный — просмотр откроется с
   * той картинкой, что уже на экране, вместо битой.
   */
  function bigImage(url: string): string {
    if (!url) return '';
    if (url.includes('avatars.yandex.net') || url.includes('.yandex.net/get-music-content')) {
      return url.replace(/\/\d+x\d+$/, '/1000x1000');
    }
    return url.replace(/-(t\d+x\d+|large|badge|small|tiny|mini|crop)\.(jpg|png|jpeg)$/, '-original.$2');
  }

  /**
   * Отдать фокус подложке просмотра, как только она появилась.
   *
   * Escape ловится обработчиком на самой подложке, а не на окне: глобальный слушатель пришлось
   * бы снимать, и он перехватывал бы Escape у всего, что открыто одновременно. Без фокуса
   * такой обработчик молчит — событие клавиатуры уходит туда, где фокус остался.
   */
  function focusOnMount(node: HTMLElement) {
    node.focus();
  }
  
  let albums: any[] = [];
  let expandedAlbum: string | null = null;

  /**
   * Какая вкладка открыта. Раньше страница была одним свитком: сетка релизов сверху, список
   * треков под ней, — а раскрытый релиз показывался панелью ПОД всей сеткой. При тридцати
   * девяти обложках это метров экрана ниже точки клика: человек нажимал на альбом и
   * справедливо считал, что не открылось ничего. Теперь это две вкладки, а релиз
   * раскрывается на месте сетки, а не под ней.
   */
  let activeTab: 'tracks' | 'albums' = 'tracks';
  /**
   * Направление последнего перехода: +1 — вперёд (вправо), -1 — назад (влево). Нужно только
   * анимации: вход внутрь релиза и возврат к сетке должны читаться как шаг в глубину и шаг
   * обратно, а не как одинаковое появление.
   */
  let navDir = 1;

  function setTab(tab: 'tracks' | 'albums') {
    if (tab === activeTab) return;
    navDir = tab === 'albums' ? 1 : -1;
    // Уходя с релизов, закрываем раскрытый: вернувшись на вкладку, ждёшь список всего, а не
    // то, что открывал до этого.
    expandedAlbum = null;
    activeTab = tab;
  }
  
  let previewAudio: HTMLAudioElement | null = null;
  let hoverTimer: any = null;
  let hoveredTrack: any = null;

  $: if (previewAudio) {
    previewAudio.volume = Math.pow($globalVolume, 3);
  }

  onMount(() => {
    previewAudio = new Audio();
    try {
      const savedSort = localStorage.getItem(ARTIST_TRACK_SORT_KEY);
      if (ARTIST_TRACK_SORT_OPTIONS.some(option => option.value === savedSort)) trackSort = savedSort as ArtistTrackSort;
      const savedView = localStorage.getItem(ARTIST_TRACK_VIEW_KEY);
      if (savedView === 'list' || savedView === 'tiles') trackView = savedView;
    } catch {}
  });

  onDestroy(() => {
    pageAtmosphere.set(null);
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
    if (hoverTimer) clearTimeout(hoverTimer);
    loadGeneration += 1;
  });

  async function handleMouseEnter(track: any) {
    if ($effectivePerformanceMode || !$settings.enableHoverPreview) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoveredTrack = track;
    hoverTimer = setTimeout(async () => {
      if (!previewAudio) return;
      try {
        const url = await getAudioUrl(track, { silent: true });
        if (url && previewAudio && hoveredTrack === track && !$effectivePerformanceMode) {
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

  function handleMouseLeave() {
    hoveredTrack = null;
    if (hoverTimer) clearTimeout(hoverTimer);
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
  }

  $: if ($effectivePerformanceMode) handleMouseLeave();

  // React to artist and source changes. Явный source не даёт API тихо подменить выбранную
  // площадку fallback-данными другой площадки.
  $: if ($currentArtist) {
    loadArtist($currentArtist, artistSource);
  }

  // Switching artists while a request is still in flight used to let the slower response
  // win: you'd land on one artist and see another one's avatar or album row. Every load
  // takes a generation number and only the newest one may write to the view.
  let loadGeneration = 0;

  async function loadArtist(artistName: string, source: ArtistSource) {
    const generation = ++loadGeneration;
    isLoading = true;
    handleMouseLeave();
    artistDescription = '';
    artistLocation = '';
    aboutOpen = false;
    tracks = [];
    albums = [];
    expandedAlbum = null;
    activeTab = 'tracks';
    navDir = 1;
    profileAvatarUrl = '';
    trackAvatarUrl = '';
    artistBannerUrl = '';
    artistVerified = false;
    artistFollowers = 0;
    artistListeners = 0;
    artistLikes = 0;
    totalPlaybackCount = 0;
    catalogTrackCount = 0;
    catalogAlbumCount = 0;
    lightboxUrl = '';

    // The profile (avatar, header banner, followers) comes from a different endpoint than
    // the tracks, so let it land on its own instead of holding up the whole page.
    getArtistProfile(artistName, source).then(profile => {
      if (generation !== loadGeneration || !profile) return;
      artistBannerUrl = profile.bannerUrl;
      artistVerified = profile.isExactMatch && !!profile.verified;
      if (profile.isExactMatch) {
        artistDescription = profile.description?.trim() || '';
        artistLocation = [profile.city, profile.country].filter(Boolean).join(', ');
      }
      artistFollowers = profile.followersCount;
      artistListeners = profile.listenersCount;
      artistLikes = profile.likesCount ?? 0;
      catalogTrackCount = profile.trackCount ?? 0;
      catalogAlbumCount = profile.albumCount ?? 0;
      // Only trust the avatar when the account is actually this artist — a name search
      // can land on a fan page, and its picture would just be wrong.
      if (profile.isExactMatch) profileAvatarUrl = profile.avatarUrl;
    }).catch(e => console.error("Artist profile fetch failed", e));

    try {
      const results = await getArtistTracks(artistName, source);
      if (generation !== loadGeneration) return;

      // Сверка по списку исполнителей трека, а не по склеенной подписи: у совместной вещи в
      // `artist` стоит «А, Б», и сравнение с «А» по равенству строк её выбрасывало. Именно
      // из-за этого со страницы пропадали фиты.
      tracks = results.filter((t: any) => trackByArtist(t, artistName));
      if (tracks.length === 0) {
        tracks = results;
      }

      totalPlaybackCount = tracks.reduce((sum, t) => sum + (t.playbackCount || 0), 0);

      if (tracks.length > 0 && tracks[0].artistAvatarUrl) {
        trackAvatarUrl = tracks[0].artistAvatarUrl;
      } else if (tracks.length > 0 && tracks[0].coverUrl) {
        trackAvatarUrl = tracks[0].coverUrl;
      } else {
        trackAvatarUrl = '';
      }

      getArtistAlbums(artistName, source).then(res => {
        if (generation === loadGeneration) albums = res;
      }).catch(e => console.error("Albums fetch failed", e));

    } catch (err) {
      console.error(err);
    }
    if (generation === loadGeneration) isLoading = false;
  }

  function setArtistSource(source: ArtistSource) {
    if (source === artistSource) return;
    if (source === 'yandex' && !$settings.yandexToken) {
      notify('Сначала подключи Яндекс Музыку в настройках.', 'info');
      return;
    }
    artistSource = source;
  }

  /**
   * Дозагрузка содержимого релиза. `direct-albums` у Музыки перечисляет релизы, но не их
   * треки, — иначе открытие страницы артиста с 39 релизами стоило бы 39 запросов сразу. Так
   * что треки берутся по клику, один раз на релиз: результат остаётся в объекте альбома.
   *
   * `albums = albums` — не лишнее: правка поля внутри элемента массива Svelte не замечает.
   */
  let loadingAlbum: string | null = null;

  async function ensureAlbumTracks(album: any): Promise<any[]> {
    if (Array.isArray(album.tracks) && album.tracks.length > 0) return album.tracks;
    loadingAlbum = album.id;
    try {
      const fetched = await getAlbumTracks(album);
      album.tracks = fetched;
      albums = albums;
      return fetched;
    } catch (e) {
      console.error('Album tracks fetch failed', e);
      return [];
    } finally {
      if (loadingAlbum === album.id) loadingAlbum = null;
    }
  }

  /**
   * Открыть релиз. Это переход ВНУТРЬ: сетка уезжает влево, содержимое релиза приезжает
   * справа — на её месте, а не под ней. Прежняя версия дописывала панель в конец страницы,
   * и при сетке в тридцать девять обложек она оказывалась за пределами экрана.
   */
  async function openAlbum(album: any) {
    if (expandedAlbum === album.id) return;
    navDir = 1;
    expandedAlbum = album.id;
    const opened = album.id;
    const fetched = await ensureAlbumTracks(album);
    // Пока шёл запрос, могли закрыть релиз или открыть другой — тогда сообщать не о чем.
    if (expandedAlbum === opened && fetched.length === 0) {
      notify('В этом релизе нет треков, доступных для воспроизведения.', 'info');
    }
  }

  function closeAlbum() {
    navDir = -1;
    expandedAlbum = null;
  }

  /**
   * Что это за релиз — по данным источника, а не по числу треков. «EP» на глаз ставить не
   * стал: у Музыки в `type` лежит только `single`/`compilation`/`podcast`, и всё остальное
   * честнее звать альбомом, чем угадывать по длине.
   */
  function albumKind(al: any): string {
    if (al?.albumType === 'single') return 'Сингл';
    if (al?.albumType === 'compilation') return 'Сборник';
    if (al?.albumType === 'podcast') return 'Подкаст';
    return 'Альбом';
  }

  /**
   * `isBanned` больше не отменяет запуск — это подсказка, а не запрет: пометку ставил плеер
   * при любой неудаче с получением ссылки, а клик по такой строке молчал. Разбор целиком —
   * в `playTrackList` (Library.svelte).
   *
   * Список необязательный: у топ-треков артиста своя очередь, у трека внутри альбома — своя
   * (остаток этого альбома). Раньше второй случай был отдельным обработчиком в разметке со
   * своей копией логики, из-за чего правки приходилось дублировать — и одна из копий
   * неизбежно отставала.
   */
  function playTrack(track: any, list: any[] = sortedTracks) {
    if (!track) return;
    stopWave();
    setGlassQueueContext(glassAlbum?.title || $currentArtist, glassAlbum?.coverUrl || artistAvatarUrl, list);
    if (track.isBanned) {
      notify('Этот источник недавно не отвечал. Пробую запустить трек ещё раз.', 'info');
    }
    const source = Array.isArray(list) ? list : [];
    const idx = source.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set(source.slice(idx + 1));
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  function shuffleGlassAlbum(list: any[]) {
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const index = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[index]] = [shuffled[index], shuffled[i]];
    }
    if (shuffled.length) playTrack(shuffled[0], shuffled);
  }

  async function playAlbum(album: any) {
    // У яндексовых релизов треков до раскрытия нет, поэтому кнопка «слушать» на карточке
    // сначала их дозапрашивает. Раньше она на таком альбоме просто ничего не делала.
    const list = await ensureAlbumTracks(album);
    if (list.length === 0) {
      notify('Не удалось загрузить треки этого релиза. Попробуй ещё раз.', 'error');
      return;
    }
    stopWave();
    queue.set(list.slice(1));
    currentTrack.set(list[0]);
    isPlaying.set(true);
  }

  function trackMatches(a: any, b: any): boolean {
    if (!a || !b) return false;
    if (a.id != null && b.id != null && `${a.id}` === `${b.id}`) return true;
    if (a.urn && b.urn && a.urn === b.urn) return true;
    if (a.title && b.title && a.title.trim().toLowerCase() === b.title.trim().toLowerCase()) {
      if (!a.artist || !b.artist) return true;
      const aArt = a.artist.trim().toLowerCase();
      const bArt = b.artist.trim().toLowerCase();
      return aArt === bArt || aArt.includes(bArt) || bArt.includes(aArt);
    }
    return false;
  }

  function isTrackPlaying(track: any, current = $currentTrack, playing = $isPlaying): boolean {
    if (!playing || !current || !track) return false;
    return trackMatches(track, current);
  }

  function isAlbumPlaying(album: any, current = $currentTrack, playing = $isPlaying): boolean {
    if (!album?.tracks?.length || !playing || !current) return false;
    return album.tracks.some((t: any) => trackMatches(t, current));
  }

  function isAlbumCurrent(album: any, current = $currentTrack): boolean {
    if (!album?.tracks?.length || !current) return false;
    return album.tracks.some((t: any) => trackMatches(t, current));
  }

  async function toggleAlbumPlayback(album: any) {
    if (!album) return;
    if ($waveActive) {
      await playAlbum(album);
      return;
    }
    if (isAlbumPlaying(album, $currentTrack, $isPlaying)) {
      isPlaying.set(false);
      return;
    }
    if (isAlbumCurrent(album, $currentTrack)) {
      isPlaying.set(true);
      return;
    }
    await playAlbum(album);
  }

  $: isArtistPlaying = Boolean(
    $isPlaying &&
    $currentTrack &&
    tracks.length > 0 &&
    (tracks.some(t => isTrackPlaying(t)) ||
     ($currentArtist && $currentTrack?.artist && $currentTrack.artist.toLowerCase().includes($currentArtist.toLowerCase())))
  );

  function toggleArtistPlayback() {
    if (!tracks.length) return;
    if ($waveActive) {
      playTrack(sortedTracks[0], sortedTracks);
      return;
    }
    if (isArtistPlaying) {
      isPlaying.set(false);
      return;
    }
    const isCurrentInTracks = tracks.some(t =>
      (t.id && t.id === $currentTrack?.id) ||
      (t.urn && t.urn === ($currentTrack as any)?.urn) ||
      (t.title === $currentTrack?.title && t.artist === $currentTrack?.artist)
    );
    if (isCurrentInTracks && !$isPlaying) {
      isPlaying.set(true);
      return;
    }
    playTrack(sortedTracks[0], sortedTracks);
  }
</script>

<div class="artist-page" class:lg-album-open={$settings.design === 'liquid-glass' && !!expandedAlbum}>
  <header class="artist-hero artist-profile-hero">
    {#if artistBannerUrl || ($settings.design === 'liquid-glass' && artistAvatarUrl)}
      <!-- A dimmed artist photo keeps text readable without a colored gradient. -->
      <img
        src={artistBannerUrl || artistAvatarUrl}
        alt=""
        aria-hidden="true"
        class="artist-hero-media"
      />
      <div class="artist-hero-veil"></div>
    {/if}
    <!-- Верхняя полоса шапки. Раньше здесь стоял один переключатель площадки, прижатый
         вправо через всю ширину, а «Об артисте» висело отдельной рамкой под шапкой - две
         почти пустые полосы одна над другой. Теперь это одна полоса: слева вход в описание,
         справа площадка, а сам текст раскрывается ниже, под шапкой целиком. -->
    <div class="artist-hero-top">
      {#if artistDescription || artistLocation}
        <button
          type="button"
          class="artist-about-toggle"
          aria-expanded={aboutOpen}
          aria-controls="artist-about-panel"
          on:click={() => aboutOpen = !aboutOpen}
        >
          <span class="artist-about-chevron" aria-hidden="true"><ChevronDown size={16} /></span>
          <span>Об артисте</span>
          {#if artistLocation}<span class="artist-about-location">{artistLocation}</span>{/if}
        </button>
      {/if}
      <div class="artist-source-switch">
      <div
        class="seg-control artist-source-control"
        style="--seg-count: 2; --seg-index: {artistSource === 'yandex' ? 1 : 0}"
        role="tablist"
        aria-label="Площадка артиста"
        aria-busy={isLoading}
      >
        <span class="seg-pill" aria-hidden="true"></span>
        <button
          type="button"
          role="tab"
          aria-selected={artistSource === 'soundcloud'}
          class="seg-item"
          class:is-active={artistSource === 'soundcloud'}
          on:click={() => setArtistSource('soundcloud')}
          title="Показать артиста в SoundCloud"
        >
          <span class="artist-source-dot is-soundcloud" aria-hidden="true"></span>
          SoundCloud
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={artistSource === 'yandex'}
          aria-disabled={!$settings.yandexToken}
          class="seg-item"
          class:is-active={artistSource === 'yandex'}
          class:is-unavailable={!$settings.yandexToken}
          on:click={() => setArtistSource('yandex')}
          title={$settings.yandexToken ? 'Показать артиста в Яндекс Музыке' : 'Сначала подключи Яндекс Музыку в настройках'}
        >
          <span class="artist-source-dot is-yandex" aria-hidden="true"></span>
          Яндекс Музыка
        </button>
      </div>
      </div>
    </div>
    <!-- Кружок с аватаром: кнопка, а не картинка, когда её есть смысл открыть. Без аватара
         (буква-заглушка) остаётся обычным блоком — нажимать не на что, и `<button>` там
         только обманывал бы указатель и клавиатуру. -->
    {#if artistAvatarUrl}
      <button
        type="button"
        class="artist-avatar artist-hero-avatar artist-avatar-open"
        on:click={() => lightboxUrl = bigImage(artistAvatarUrl)}
        title="Открыть аватар"
        aria-label="Открыть аватар артиста"
      >
        <img src={artistAvatarUrl} alt={$currentArtist} class="w-full h-full object-cover relative z-10" />
      </button>
    {:else}
      <div class="artist-avatar artist-hero-avatar">
        <User size={50} class="text-primary relative z-10" />
      </div>
    {/if}
    <div class="artist-hero-body">
      <p class="artist-profile-label">Артист <span aria-hidden="true">·</span> {artistSource === 'yandex' ? 'Яндекс Музыка' : 'SoundCloud'}</p>
      <div class="flex items-center gap-3 mb-2 min-w-0">
        <h1 class="page-title artist-hero-name">
          {$currentArtist}
        </h1>
        {#if ['klimentos', 'uniquebleed', 'bleed'].includes($currentArtist.toLowerCase())}
          <span class="text-[12px] font-bold px-2 py-1 rounded bg-orange-500/20 text-orange-400 whitespace-nowrap shrink-0 border border-orange-500/30 tracking-normal normal-case shadow-[0_0_10px_rgba(249,115,22,0.3)]">
            Team Lomify
          </span>
        {/if}
      </div>
      <dl class="artist-profile-stats">
        <div><dt>Треки</dt><dd>{isLoading ? '...' : shownTrackCount.toLocaleString('ru-RU')}</dd></div>
        {#if catalogAlbumCount || albums.length}<div><dt>Релизы</dt><dd>{Math.max(catalogAlbumCount, albums.length).toLocaleString('ru-RU')}</dd></div>{/if}
        {#if artistListeners > 0}<div><dt>Слушателей за месяц</dt><dd>{artistListeners.toLocaleString('ru-RU')}</dd></div>{/if}
        {#if artistFollowers > 0}<div><dt>Подписчики</dt><dd>{artistFollowers.toLocaleString('ru-RU')}</dd></div>{/if}
        {#if artistLikes > 0}<div><dt>В избранном</dt><dd>{artistLikes.toLocaleString('ru-RU')}</dd></div>{/if}
        {#if totalPlaybackCount > 0 && artistSource !== 'yandex'}<div><dt>Прослушиваний у загруженных треков</dt><dd>{totalPlaybackCount.toLocaleString('ru-RU')}</dd></div>{/if}
      </dl>
      <div class="artist-hero-actions mt-3 flex items-center gap-3">
        <button
          type="button"
          class="artist-hero-play"
          class:is-playing={isArtistPlaying}
          disabled={!tracks.length}
          on:click={toggleArtistPlayback}
          title={isArtistPlaying ? 'Пауза' : 'Слушать'}
          aria-label={isArtistPlaying ? 'Пауза' : 'Слушать'}
        >
          <MorphIcon
            icon={isArtistPlaying ? PauseData : PlayData}
            size={18}
            strokeWidth={2.35}
            fill="currentColor"
            class="play-pause-morph"
            spring="snappy"
            reducedMotion="user"
          />
          <span>{isArtistPlaying ? 'Пауза' : 'Слушать'}</span>
        </button>
        {#if $settings.design === 'liquid-glass'}
          <button type="button" class="lg-artist-follow" aria-pressed={artistFollowed} aria-label={artistFollowed ? 'Отписаться от артиста' : 'Подписаться на артиста'} on:click={toggleGlassFollow}>
            <span class="lg-follow-content" aria-hidden="true">
              <span class="lg-follow-icon"><span class="lg-follow-off"><UserPlus size={14} /></span><span class="lg-follow-on"><Check size={14} /></span></span>
              <span class="lg-follow-label"><span class="lg-follow-off">Подписаться</span><span class="lg-follow-on">Подписан</span></span>
            </span>
          </button>
        {/if}
      </div>
    </div>
    <!-- Описание раскрывается последней строкой шапки во всю её ширину: читать биографию
         в колонке рядом с аватаром неудобно, а собственной рамки под шапкой этот текст не
         заслуживает - он закрыт почти всё время. -->
    {#if artistDescription || artistLocation}
      <div id="artist-about-panel" class="artist-about-collapse" class:is-open={aboutOpen} aria-hidden={!aboutOpen} inert={!aboutOpen}>
        <div class="artist-about-body"><p>{artistDescription || artistLocation}</p></div>
      </div>
    {/if}
  </header>

  <!-- Аватар во весь экран. Закрывается кликом по фону и Escape; фокус уходит на саму
       подложку, чтобы Escape ловился без глобального обработчика на окне. -->
  {#if lightboxUrl}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div
      class="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-xl p-8 animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Аватар артиста"
      tabindex="-1"
      on:click={() => lightboxUrl = ''}
      on:keydown={(e) => { if (e.key === 'Escape') lightboxUrl = ''; }}
      use:focusOnMount
    >
      <button
        type="button"
        class="absolute top-6 right-6 text-white/60 hover:text-white transition-colors"
        aria-label="Закрыть"
        on:click|stopPropagation={() => lightboxUrl = ''}
      >
        <X size={28} />
      </button>
      <!-- Клик по самой картинке не закрывает: её открывали, чтобы рассмотреть. -->
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <img
        src={lightboxUrl}
        alt={$currentArtist}
        class="max-w-full max-h-full rounded-3xl shadow-2xl object-contain animate-in zoom-in-95"
        on:click|stopPropagation
        on:error={() => { if (lightboxUrl !== artistAvatarUrl) lightboxUrl = artistAvatarUrl; }}
      />
    </div>
  {/if}

  <div class="artist-content">
  {#if isLoading}
    <div class="flex-1 flex items-center justify-center text-primary">
      <Loader2 class="animate-spin" size={40} />
    </div>
  {:else if tracks.length === 0}
    <div class="flex-1 flex flex-col items-start justify-center px-10">
      <User size={26} class="mb-5 text-white/20" />
      <p class="display-title">На {artistSource === 'yandex' ? 'Яндекс Музыке' : 'SoundCloud'} тут пусто</p>
      <p class="empty-hint">Ни одного трека не нашлось. Можно проверить вторую площадку переключателем в шапке.</p>
    </div>
  {:else}
    
    <!-- Вкладки вместо одного длинного свитка. Раскрытый релиз показывался панелью ПОД
         сеткой обложек — а при тридцати девяти релизах это на экран с лишним ниже точки
         клика, так что нажатие выглядело как «ничего не произошло». Теперь релизы и треки —
         два раздела, и релиз раскрывается на месте сетки, а не под ней. -->
    <div class="artist-list-header">
      {#if albums.length > 0}
        <div class="artist-tabs">
          <div
            class="seg-control is-lg"
            style="--seg-count: 2; --seg-index: {activeTab === 'albums' ? 1 : 0}"
            role="tablist"
            aria-label="Разделы артиста"
          >
            <span class="seg-pill" aria-hidden="true"></span>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'tracks'}
              class="seg-item"
              class:is-active={activeTab === 'tracks'}
              on:click={() => setTab('tracks')}
            >
              <Music2 size={15} />
              Треки
              <!-- Здесь длина загруженного списка, а НЕ каталожное `shownTrackCount` из шапки.
                   Цифра на вкладке читается как «столько строк внутри», и у артиста с тысячей
                   треков она обещала бы тысячу, а список ограничен лимитом источника. В шапке
                   то число уместно — оно там подписано словом «треков» и говорит о каталоге.
                   Рядом стоит `albums.length`, тоже длина списка: два счётчика в одном органе
                   управления обязаны значить одно и то же. -->
              <span class="seg-count tnum">{tracks.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'albums'}
              class="seg-item"
              class:is-active={activeTab === 'albums'}
              on:click={() => setTab('albums')}
            >
              <Disc size={15} />
              Альбомы и EP
              <span class="seg-count tnum">{albums.length}</span>
            </button>
          </div>
        </div>
      {:else}
        <!-- Релизов нет — переключатель из одного раздела был бы органом управления, которым
             нечего переключать. -->
        <h2 class="section-title">Треки</h2>
      {/if}
      {#if activeTab === 'tracks'}
        <div class="artist-sort-control">
          <button
            type="button"
            data-press-late
            class="library-view-toggle"
            aria-label={trackView === 'list' ? 'Показать треки плиткой' : 'Показать треки списком'}
            title={trackView === 'list' ? 'Показать плиткой' : 'Показать списком'}
            on:click={toggleTrackView}
          >
            <MorphIcon
              icon={trackView === 'list' ? LayoutGridData : ListData}
              size={17}
              spring="snappy"
              reducedMotion="user"
            />
            <span>{trackView === 'list' ? 'Плиткой' : 'Списком'}</span>
          </button>
          <SelectMenu value={trackSort} options={ARTIST_TRACK_SORT_OPTIONS} ariaLabel="Порядок треков артиста" onChange={changeTrackSort} />
        </div>
      {/if}
    </div>

    {#if activeTab === 'albums' && !expandedAlbum}
      <div class="artist-pane mb-10 w-full" in:fly={{ x: 34 * navDir, duration: $settings.design === 'liquid-glass' ? 0 : 340, easing: cubicOut }}>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {#each albums as album}
            {@const isPlayingThisAlbum = isAlbumPlaying(album, $currentTrack, $isPlaying)}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="w-full group cursor-pointer interactive-item"
              on:click={() => openAlbum(album)}
            >
              <!-- `spec-art` — глянцевая поверхность: по ней ходит отражение света, положение
                   которого считается из наклона (`$lib/utils/tilt`). Бегущей полосы здесь нет
                   намеренно - один блик на поверхность. Подъем и наклон применяются
                   к декоративной поверхности, кнопки остаются в неподвижной рамке. -->
              <div class="cover-tilt-frame w-full aspect-square min-w-[3rem] min-h-[3rem] rounded-xl relative mb-3">
                <div class="cover-tilt-surface spec-art art-glow shadow-lg bg-neutral-800 border border-white/5">
                  <!-- Обложка берётся с самого релиза. Раньше её искали в `tracks[0]`, но у
                       яндексовых релизов до раскрытия треков нет вовсе — и все карточки стояли
                       пустыми квадратами с иконкой. -->
                  {#if album.coverUrl || album.tracks?.[0]?.coverUrl}
                    <img src={album.coverUrl || album.tracks[0].coverUrl} alt="Cover" loading="lazy" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  {:else}
                    <div class="w-full h-full flex items-center justify-center text-neutral-500">
                      <ListMusic size={32} />
                    </div>
                  {/if}
                </div>
                <div class="absolute inset-0 rounded-xl bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button
                    class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                    class:is-playing={isPlayingThisAlbum}
                    on:click|stopPropagation={() => toggleAlbumPlayback(album)}
                    title={isPlayingThisAlbum ? 'Пауза' : 'Слушать альбом'}
                    aria-label={isPlayingThisAlbum ? 'Пауза' : 'Слушать альбом'}
                  >
                    <MorphIcon
                      icon={isPlayingThisAlbum ? PauseData : PlayData}
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
              <div class="px-1 relative">
                <div class="font-bold text-[14px] text-white truncate">{album.title}</div>
                <div class="text-neutral-400 text-[12px] mt-0.5">
                  <!-- `trackCount` приходит вместе со списком релизов, а `tracks` наполняется
                       только после раскрытия — так что число известно сразу. -->
                  {withCount(album.trackCount || album.tracks?.length || 0, 'трек', 'трека', 'треков')}
                  {#if album.year}
                    • {album.year}
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Содержимое релиза. Это не панель под сеткой, а её замена: сетка уезжает, релиз
         приезжает на её место, сверху — возврат ко всем релизам. -->
    {#if activeTab === 'albums' && expandedAlbum}
      {@const al = albums.find(a => a.id === expandedAlbum)}
      {#if al}
        {@const isPlayingThisAlbum = isAlbumPlaying(al, $currentTrack, $isPlaying)}
        <div class="artist-pane album-detail mb-10 w-full" in:fly={{ x: 34 * navDir, duration: $settings.design === 'liquid-glass' ? 0 : 340, easing: cubicOut }}>
          <button type="button" class="album-back" on:click={closeAlbum}>
            <ChevronLeft size={17} />
            Все релизы
          </button>

          {#if $settings.design === 'liquid-glass'}
            <LiquidGlassMediaHeader title={al.title} cover={al.coverUrl || al.tracks?.[0]?.coverUrl} artist={$currentArtist} avatar={artistAvatarUrl} verified={artistVerified} genre={al.genre || al.tracks?.[0]?.genre || ''} year={al.year} tracks={al.tracks || []} playing={isPlayingThisAlbum} onplay={() => toggleAlbumPlayback(al)} onshuffle={() => shuffleGlassAlbum(al.tracks || [])} />
          {:else}
          <div class="album-detail-head">
            <div class="album-detail-art">
              {#if al.coverUrl || al.tracks?.[0]?.coverUrl}
                <img src={al.coverUrl || al.tracks[0].coverUrl} alt={al.title} />
              {:else}
                <div class="album-detail-art-empty"><ListMusic size={38} /></div>
              {/if}
            </div>
            <div class="album-detail-meta">
              <span class="album-detail-kind">{albumKind(al)}</span>
              <h2 class="album-detail-title">{al.title}</h2>
              <p class="album-detail-sub">
                {withCount(al.trackCount || al.tracks?.length || 0, 'трек', 'трека', 'треков')}{#if al.year} • {al.year}{/if}
              </p>
              <button
                type="button"
                class="album-detail-play"
                class:is-playing={isPlayingThisAlbum}
                on:click={() => toggleAlbumPlayback(al)}
                title={isPlayingThisAlbum ? 'Пауза' : 'Слушать'}
                aria-label={isPlayingThisAlbum ? 'Пауза' : 'Слушать'}
              >
                <MorphIcon
                  icon={isPlayingThisAlbum ? PauseData : PlayData}
                  size={15}
                  strokeWidth={2.35}
                  fill="currentColor"
                  class="play-pause-morph"
                  spring="snappy"
                  reducedMotion="user"
                />
                <span>{isPlayingThisAlbum ? 'Пауза' : 'Слушать'}</span>
              </button>
            </div>
          </div>
          {/if}

          {#if loadingAlbum === al.id && !al.tracks?.length}
            <div class="flex items-center justify-center py-10 text-primary">
              <Loader2 class="animate-spin" size={28} />
            </div>
          {:else if !al.tracks?.length}
            <p class="empty-hint">Не удалось загрузить треки. Попробуй открыть релиз ещё раз.</p>
          {:else}
            {#key al.id}
              {#if $settings.design === 'liquid-glass'}<LiquidGlassTrackList tracks={al.tracks} onplay={playTrack} />{:else}<ArtistTrackList tracks={al.tracks} source={artistSource} onplay={playTrack} onpreview={handleMouseEnter} onpreviewend={handleMouseLeave} />{/if}
            {/key}
          {/if}
        </div>
      {/if}
    {/if}

    {#if activeTab === 'tracks'}
      <div class="artist-pane">
        {#if $settings.design === 'liquid-glass'}<h2 class="section-title">Топ треки</h2><LiquidGlassTrackList tracks={glassTopTracks} top={true} onplay={playTrack} />{/if}
        {#key `${$currentArtist}:${artistSource}:${trackSort}`}
          {#if $settings.design === 'liquid-glass'}<h2 class="section-title mt-8">Все треки</h2><LiquidGlassTrackList tracks={sortedTracks} artwork={true} onplay={playTrack} />{:else}<ArtistTrackList tracks={sortedTracks} source={artistSource} view={trackView} onplay={playTrack} onpreview={handleMouseEnter} onpreviewend={handleMouseLeave} />{/if}
        {/key}
      </div>
    {/if}
  {/if}
  </div>
</div>


<style>
  .artist-page { width: 100%; max-width: 1200px; margin: 0 auto; }
  .artist-content { width: 100%; container: artist-content / inline-size; padding: 0 8px 24px; }
  .artist-profile-hero.artist-hero, :global(body[data-design="aurora"]) .artist-profile-hero.artist-hero {
    display: grid; grid-template-columns: 152px minmax(0, 1fr); align-items: center; gap: 18px 28px;
    max-width: none; min-height: 0; margin: 0 0 20px; padding: 20px 24px;
    border: 1px solid rgb(255 255 255 / 8%); border-radius: 20px; background: rgb(255 255 255 / 3%);
  }
  /* Верхняя полоса шапки во всю ширину: описание слева, площадка справа. Раньше площадка
     стояла одна с `justify-self: end`, и слева от неё оставалась пустая строка во всю
     ширину шапки - самое заметное пустое место на странице. */
  .artist-hero-top { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; }
  .artist-profile-hero .artist-source-switch { position: static; margin-left: auto; }
  .artist-profile-hero .artist-source-control { min-width: 0; }
  .artist-profile-hero .artist-hero-media { mask-image: none; -webkit-mask-image: none; opacity: 0.22; filter: none; animation: none; }
  .artist-profile-hero .artist-hero-veil { mask-image: none; -webkit-mask-image: none; background: rgb(0 0 0 / 35%); }
  .artist-profile-hero .artist-hero-avatar { width: 152px; height: 152px; border: 1px solid rgb(255 255 255 / 12%); box-shadow: none; }
  .artist-profile-hero .artist-hero-name { font-size: clamp(28px, 3.5vw, 48px); line-height: 1.12; letter-spacing: -0.03em; overflow-wrap: anywhere; text-shadow: none; }
  .artist-profile-label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--color-muted, #a3a3a3); font-size: 12px; }
  /* Статистики бывает и одна («Треки»), и пять. Жёсткие 18px сверху и снизу при одной
     цифре давали полосу пустоты выше самой цифры, поэтому отступ снизу снят: кнопку
     «Слушать» и так отделяет её собственный `mt-3`. */
  .artist-profile-stats { display: flex; flex-wrap: wrap; gap: 12px 28px; margin: 14px 0 0; }
  .artist-profile-stats div { display: flex; flex-direction: column-reverse; gap: 4px; }
  .artist-profile-stats dt { font-size: 12px; color: var(--color-muted, #a3a3a3); }
  .artist-profile-stats dd { margin: 0; font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .artist-about-toggle { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 12px 6px 8px; border: 1px solid rgb(255 255 255 / 10%); border-radius: 999px; background: rgb(255 255 255 / 4%); color: inherit; text-align: left; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; }
  .artist-about-toggle:hover { background: rgb(255 255 255 / 8%); }
  .artist-about-chevron { display: inline-flex; flex: 0 0 auto; transition: transform var(--duration-quick) var(--ease-smooth-out); }
  .artist-about-toggle[aria-expanded='true'] .artist-about-chevron { transform: rotate(180deg); }
  .artist-about-location { margin-left: 4px; color: var(--color-muted, #a3a3a3); font-size: 12px; font-weight: 400; }
  .artist-about-collapse { grid-column: 1 / -1; display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--duration-quick) var(--ease-smooth-out), opacity 180ms var(--ease-smooth-out); }
  .artist-about-collapse.is-open { grid-template-rows: 1fr; opacity: 1; }
  .artist-about-body { min-height: 0; overflow: hidden; }
  .artist-about-body p { max-width: 80ch; margin: 0; padding-top: 14px; border-top: 1px solid rgb(255 255 255 / 8%); white-space: pre-line; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; color: rgb(255 255 255 / 75%); }
  .artist-list-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
  .artist-list-header .section-title { margin: 0; }
  .artist-sort-control { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .artist-sort-control :global(.select-menu) { min-width: 172px; }
  .artist-sort-control :global(.select-menu-trigger) { min-height: 44px; }
  .artist-sort-control :global(.library-view-toggle) { min-height: 44px; }
  .artist-about-toggle:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; border-radius: 999px; }
  @media (prefers-reduced-motion: reduce) {
    .artist-about-collapse { transition: opacity var(--duration-micro) var(--ease-smooth-out); }
    .artist-about-chevron { transition: none; }
  }
  @media (max-width: 800px) {
    .artist-profile-hero.artist-hero, :global(body[data-design="aurora"]) .artist-profile-hero.artist-hero { grid-template-columns: 96px minmax(0, 1fr); gap: 16px; padding: 20px; }
    .artist-profile-hero .artist-hero-avatar { width: 96px; height: 96px; }
  }
  @media (max-width: 540px) {
    .artist-profile-hero.artist-hero, :global(body[data-design="aurora"]) .artist-profile-hero.artist-hero { grid-template-columns: minmax(0, 1fr); }
    /* На узком окне полоса переносится в две строки, и прижимать площадку вправо больше
       не к чему - она встаёт под кнопкой описания и растягивается по ширине. */
    .artist-profile-hero .artist-source-switch { margin-left: 0; max-width: 100%; }
    .artist-content { padding-inline: 0; }
  }
</style>
