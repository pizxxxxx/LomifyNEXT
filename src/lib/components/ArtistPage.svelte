<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Play, Loader2, User, Info, Disc, X, ListMusic, ChevronLeft, Music2 } from 'lucide-svelte';
  import { currentArtist, currentTrack, isPlaying, queue, settings, globalVolume, notify, pageAtmosphere, type PageAtmosphere } from '$lib/stores';
  import { getArtistTracks, getAudioUrl, getArtistAlbums, getArtistProfile, getAlbumTracks, trackByArtist } from '$lib/api';
  import ArtistTag from './ArtistTag.svelte';
  import TrackStatus from './TrackStatus.svelte';
  import { withCount, plural } from '$lib/utils/plural';

  let tracks: any[] = [];
  let isLoading = true;
  // Two sources for the same slot: the SoundCloud profile picture (right, when we're sure
  // it's the same account) and the artwork of the first track (always available). Keeping
  // them apart means whichever resolves second can't blank out the other.
  let profileAvatarUrl = '';
  let trackAvatarUrl = '';
  $: artistAvatarUrl = profileAvatarUrl || trackAvatarUrl;
  let artistBannerUrl = '';
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

  /**
   * Атмосферная подложка страницы: то же изображение, что в шапке, размытое во всю ширину
   * окна — включая полосу под боковой панелью, куда сама шапка попасть не может
   * (`<main>` обрезает содержимое по стыку с панелью, см. `pageAtmosphere` в stores).
   * Именно она и делает продолжение баннера влево: резкий слой в шапке теперь гасится
   * коротким спадом и передаёт картинку размытой копии, а не обрывается в пустоту.
   *
   * Только в Aurora: там шапка растянута во всю ширину и её левая кромка приходится ровно
   * на стык с панелью. В классическом дизайне шапка — закрытая карточка в колонке
   * контента, продолжать себя ей некуда, и подложка была бы новым элементом дизайна, а не
   * починкой.
   *
   * Баннера у артиста может не быть вовсе — тогда источником идёт аватар (он же обложка
   * первого трека). Как `derived`: это квадрат, его надо размыть сильнее.
   */
  let atmos: PageAtmosphere | null = null;
  $: {
    const source = artistBannerUrl || artistAvatarUrl;
    atmos = $settings.design === 'aurora' && source
      ? { url: source, derived: !artistBannerUrl }
      : null;
    pageAtmosphere.set(atmos);
  }

  onMount(() => {
    previewAudio = new Audio();
  });

  onDestroy(() => {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
    // Гасим подложку только если она всё ещё наша: порядок «создать новую страницу →
    // уничтожить старую» Svelte не обещает, и слепой сброс погасил бы подложку, которую
    // только что поставил следующий раздел.
    pageAtmosphere.update(cur => (cur === atmos ? null : cur));
  });

  async function handleMouseEnter(track: any) {
    if (!$settings.enableHoverPreview) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoveredTrack = track;
    hoverTimer = setTimeout(async () => {
      if (!previewAudio) return;
      try {
        const url = await getAudioUrl(track, { silent: true });
        if (url && previewAudio) {
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

  // React to artist changes
  $: if ($currentArtist) {
    loadArtist($currentArtist);
  }

  // Switching artists while a request is still in flight used to let the slower response
  // win: you'd land on one artist and see another one's avatar or album row. Every load
  // takes a generation number and only the newest one may write to the view.
  let loadGeneration = 0;

  async function loadArtist(artistName: string) {
    const generation = ++loadGeneration;
    isLoading = true;
    tracks = [];
    albums = [];
    expandedAlbum = null;
    activeTab = 'tracks';
    navDir = 1;
    profileAvatarUrl = '';
    trackAvatarUrl = '';
    artistBannerUrl = '';
    artistFollowers = 0;
    artistListeners = 0;
    artistLikes = 0;
    catalogTrackCount = 0;
    catalogAlbumCount = 0;
    lightboxUrl = '';

    // The profile (avatar, header banner, followers) comes from a different endpoint than
    // the tracks, so let it land on its own instead of holding up the whole page.
    getArtistProfile(artistName).then(profile => {
      if (generation !== loadGeneration || !profile) return;
      artistBannerUrl = profile.bannerUrl;
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
      const results = await getArtistTracks(artistName);
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

      getArtistAlbums(artistName).then(res => {
        if (generation === loadGeneration) albums = res;
      }).catch(e => console.error("Albums fetch failed", e));

    } catch (err) {
      console.error(err);
    }
    if (generation === loadGeneration) isLoading = false;
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
      notify('В этом релизе не оказалось треков, которые можно включить', 'info');
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
  function playTrack(track: any, list: any[] = tracks) {
    if (!track) return;
    if (track.isBanned) {
      notify('Источник считал трек недоступным. Пробую ещё раз', 'info');
    }
    const source = Array.isArray(list) ? list : [];
    const idx = source.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set(source.slice(idx + 1));
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  async function playAlbum(album: any) {
    // У яндексовых релизов треков до раскрытия нет, поэтому кнопка «слушать» на карточке
    // сначала их дозапрашивает. Раньше она на таком альбоме просто ничего не делала.
    const list = await ensureAlbumTracks(album);
    if (list.length === 0) {
      notify('Не удалось получить треки этого релиза', 'error');
      return;
    }
    queue.set(list.slice(1));
    currentTrack.set(list[0]);
    isPlaying.set(true);
  }
</script>

<div class="w-full">
  <!-- Artist Header. Геометрия, вуали и растворение в фон — в классах `.artist-hero*`
       (app.css + design-aurora.css). Шапка сознательно вынесена ЗА пределы колонки
       контента: в Aurora она перестаёт быть плиткой и растягивается во всю ширину
       страницы, уходя под верхний край и растворяясь в цвете фона к контенту — то есть
       делает ровно то, чего нельзя добиться, пока блок заперт в центрированном
       контейнере с `max-width`. В классическом дизайне ширину ей возвращает
       `max-width: 1000px` в самом классе, так что колонка не разъезжается. -->
  <header class="artist-hero">
    {#if artistBannerUrl}
      <!-- The artist's own SoundCloud header. Faded and masked so the name stays readable
           on top of whatever they uploaded — some banners are near-white. -->
      <img
        src={artistBannerUrl}
        alt=""
        aria-hidden="true"
        class="artist-hero-media"
      />
      <div class="artist-hero-veil"></div>
      <div class="artist-hero-fade"></div>
    {/if}
    <div class="artist-hero-tint"></div>
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
        <div class="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent"></div>
        <img src={artistAvatarUrl} alt={$currentArtist} class="w-full h-full object-cover relative z-10" />
      </button>
    {:else}
      <div class="artist-avatar artist-hero-avatar">
        <div class="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent"></div>
        <User size={50} class="text-primary relative z-10" />
      </div>
    {/if}
    <div class="artist-hero-body">
      <div class="flex items-center gap-3 mb-2 min-w-0">
        <h1 class="page-title artist-hero-name truncate">
          {$currentArtist}
        </h1>
        {#if ['klimentos', 'uniquebleed', 'bleed'].includes($currentArtist.toLowerCase())}
          <span class="text-[12px] font-bold px-2 py-1 rounded bg-orange-500/20 text-orange-400 whitespace-nowrap shrink-0 border border-orange-500/30 tracking-normal normal-case shadow-[0_0_10px_rgba(249,115,22,0.3)]">
            Team Lomify
          </span>
        {/if}
      </div>
      <p class="artist-hero-meta truncate w-full">
        <!-- Число треков — из каталога источника, а не из длины загруженного списка: список
             ограничен сверху, и «300 треков» у артиста с тысячей было бы такой же неправдой,
             как прежние «6 треков» у артиста с сотней. -->
        {withCount(shownTrackCount, 'трек', 'трека', 'треков')}
        {#if catalogAlbumCount > 0}
          • {withCount(catalogAlbumCount, 'релиз', 'релиза', 'релизов')}
        {/if}
        {#if totalPlaybackCount > 0}
          • {totalPlaybackCount.toLocaleString('ru-RU')} прослушиваний
        {/if}
        <!-- Слушатели — из Яндекса, подписчики — из SoundCloud. Оба сразу не бывают: профиль
             приходит от одного источника, того, который выбран в настройках. -->
        {#if artistListeners > 0}
          • {artistListeners.toLocaleString('ru-RU')} {plural(artistListeners, 'слушатель', 'слушателя', 'слушателей')} за месяц
        {/if}
        <!-- «В избранном», а не «прослушиваний»: это `likesCount`. Прослушиваний по треку
             Музыка не отдаёт нигде — см. комментарий у `artistLikes`. -->
        {#if artistLikes > 0}
          • {artistLikes.toLocaleString('ru-RU')} в избранном
        {/if}
        {#if artistFollowers > 0}
          • {artistFollowers.toLocaleString('ru-RU')} {plural(artistFollowers, 'подписчик', 'подписчика', 'подписчиков')}
        {/if}
      </p>
    </div>
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

  <div class="flex flex-col px-4 md:px-8 w-full max-w-[1000px] mx-auto">
  {#if isLoading}
    <div class="flex-1 flex items-center justify-center text-primary">
      <Loader2 class="animate-spin" size={40} />
    </div>
  {:else if tracks.length === 0}
    <div class="flex-1 flex flex-col items-start justify-center px-10">
      <User size={26} class="mb-5 text-white/20" />
      <p class="display-title">У этого артиста тут пусто</p>
      <p class="empty-hint">Ни одного трека не нашлось — возможно, имя написано немного иначе.</p>
    </div>
  {:else}
    
    <!-- Вкладки вместо одного длинного свитка. Раскрытый релиз показывался панелью ПОД
         сеткой обложек — а при тридцати девяти релизах это на экран с лишним ниже точки
         клика, так что нажатие выглядело как «ничего не произошло». Теперь релизы и треки —
         два раздела, и релиз раскрывается на месте сетки, а не под ней. -->
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
      <h2 class="section-title mb-6 flex items-center gap-3">Популярные треки</h2>
    {/if}

    {#if activeTab === 'albums' && !expandedAlbum}
      <div class="artist-pane mb-10 w-full" in:fly={{ x: 34 * navDir, duration: 340, easing: cubicOut }}>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {#each albums as album}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="w-full group cursor-pointer interactive-item"
              on:click={() => openAlbum(album)}
            >
              <!-- `spec-art` — глянцевая поверхность: по ней ходит отражение света, положение
                   которого считается из наклона (`$lib/utils/tilt`). Бегущей полосы здесь нет
                   намеренно — один блик на поверхность. Свой `-translate-y-1` снят: карточка
                   уже поднимается целиком через `interactive-item`. -->
              <div class="w-full aspect-square min-w-[3rem] min-h-[3rem] rounded-xl overflow-hidden shadow-lg relative bg-neutral-800 mb-3 border border-white/5 transition-colors duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] spec-art art-glow">
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
                <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button
                    class="bg-primary hover:bg-primary/80 text-black rounded-full p-3 shadow-xl transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                    on:click|stopPropagation={() => playAlbum(album)}
                    title="Слушать альбом"
                  >
                    <Play fill="currentColor" size={20} />
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
        <div class="artist-pane album-detail mb-10 w-full" in:fly={{ x: 34 * navDir, duration: 340, easing: cubicOut }}>
          <button type="button" class="album-back" on:click={closeAlbum}>
            <ChevronLeft size={17} />
            Все релизы
          </button>

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
              <button type="button" class="album-detail-play" on:click={() => playAlbum(al)}>
                <Play fill="currentColor" size={15} />
                Слушать
              </button>
            </div>
          </div>

          {#if loadingAlbum === al.id && !al.tracks?.length}
            <div class="flex items-center justify-center py-10 text-primary">
              <Loader2 class="animate-spin" size={28} />
            </div>
          {:else if !al.tracks?.length}
            <p class="empty-hint">Треки этого релиза не пришли — источник их не отдал.</p>
          {:else}
            <div class="flex flex-col gap-2">
              {#each al.tracks as track, i}
                {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <!-- Та же правка, что и у строк основного списка: `transition-all` разгонял
                     вообще всё, включая `box-shadow` от `hover:shadow-lg` — тень
                     перерисовывается каждый кадр. Подъём и тень даёт `interactive-item`, у
                     которого тень заранее отрисована на псевдоэлементе и проявляется
                     прозрачностью, а переход остаётся только на цвете фона. -->
                <div
                  class="relative hover:z-50 flex items-center gap-4 group/track rounded-xl p-2 transition-colors w-full cursor-pointer interactive-item {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'} {track.isBanned ? 'opacity-60' : ''}"
                  on:click={() => playTrack(track, al.tracks)}
                >
                  <TrackStatus index={i} {isActive} playing={$isPlaying} banned={track.isBanned} />
                  <div class="flex flex-col flex-1 min-w-0 pr-4">
                    <span class="font-bold text-[14px] truncate {isActive ? 'text-primary' : 'text-white'}">{track.title}</span>
                    <span class="text-neutral-400 text-[12px] mt-0.5 min-w-0">
                      <ArtistTag artist={track.artist} artists={track.artists} />
                    </span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}

    {#if activeTab === 'tracks'}
    <div class="artist-pane" in:fly={{ x: 34 * navDir, duration: 340, easing: cubicOut }}>
    <div class="track-collection grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 p-2">
      {#each tracks as track, i}
        {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <!-- `hover:-translate-y-1 hover:shadow-lg` убраны: подъём и тень строке уже даёт
             `interactive-item` (тень — заранее отрисованным псевдоэлементом, а не свойством
             `box-shadow`, которое перерисовывается каждый кадр). Два подъёма складывались
             в 8px и заметно дёргались. -->
        <div
          class="relative hover:z-50 flex items-center gap-4 group rounded-xl p-2 transition-colors w-full cursor-pointer interactive-item {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5'} {track.isBanned ? 'opacity-60' : ''}"
          on:click={() => playTrack(track)}
        >
          <TrackStatus index={i} {isActive} playing={$isPlaying} banned={track.isBanned} />
          <div class="relative w-12 h-12 min-w-[3rem] min-h-[3rem] aspect-square shadow-sm rounded-lg overflow-hidden shrink-0 bg-neutral-800"
               on:mouseenter={() => handleMouseEnter(track)}
               on:mouseleave={handleMouseLeave}>
            {#if track.coverUrl}
              <!-- `lazy` — потому что список перестал быть короткой выдачей поиска: у артиста
                   с большой дискографией здесь сотни строк, и без этого браузер полез бы за
                   всеми обложками сразу, включая те, до которых никто не докрутит. -->
              <img src={track.coverUrl} alt="Cover" loading="lazy" class="w-full h-full object-cover" />
            {:else}
              <div class="w-full h-full flex items-center justify-center text-neutral-500">
                <Play size={20} />
              </div>
            {/if}
            {#if $settings.enableHoverPreview}
              <div class="absolute bottom-0 left-0 h-[3px] bg-primary shadow-[0_0_8px_#00e5ff]"
                   style="width: {hoveredTrack?.title === track.title ? '100%' : '0%'}; transition: width {$settings.hoverPreviewDelay}ms linear;">
              </div>
            {/if}
          </div>
          <div class="flex flex-col flex-1 min-w-0 pr-1">
            <span class="font-bold text-[14px] truncate {isActive ? 'text-primary' : 'text-white'}">{track.title}</span>
            <div class="text-neutral-400 text-[12px] mt-0.5 min-w-0">
              <ArtistTag artist={track.artist} artists={track.artists} />
            </div>
          </div>
          <!-- Dropdown for Info -->
          <div class="relative group/info mr-2">
            <button class="opacity-0 group-hover:opacity-100 p-2 text-neutral-400 hover:text-white rounded-full transition-all" aria-label="Информация" on:click|stopPropagation>
              <Info size={18} />
            </button>
            <div class="absolute right-0 {i >= tracks.length - 2 ? 'bottom-full mb-1' : 'top-full pt-1'} w-56 hidden group-hover/info:block z-50">
              <div class="bg-neutral-900 border border-white/10 rounded-xl shadow-xl p-3 text-xs text-neutral-300 pointer-events-none">
                <p class="mb-1"><strong class="text-white">Автор:</strong> {track.artist}</p>
                {#if track.playbackCount != null}
                  <p class="mb-1"><strong class="text-white">Прослушиваний SC:</strong> {track.playbackCount.toLocaleString('ru-RU')}</p>
                {/if}
                {#if track.releaseDate}
                  <p class="mb-1"><strong class="text-white">Выпущен:</strong> {new Date(track.releaseDate).toLocaleDateString('ru-RU')}</p>
                {/if}
                {#if track.genre}
                  <p><strong class="text-white">Жанр:</strong> {track.genre}</p>
                {/if}
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>
    </div>
    {/if}
  {/if}
  </div>
</div>
