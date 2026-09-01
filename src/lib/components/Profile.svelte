<script context="module" lang="ts">
  // Живёт вне экземпляра компонента: профиль монтируется заново при каждом заходе, и без
  // этих флагов аккаунт без шапки или без аватара (пустой ответ — тоже ответ) дёргал бы сеть
  // снова и снова при каждом открытии страницы.
  let bannerSyncTried = false;
  let yandexAvatarSyncTried = false;
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { listenStats, currentTrack, isPlaying, settings, pageAtmosphere, likedTracks, playlists, type ListenHistoryEntry, type PageAtmosphere } from '$lib/stores';
  import { BarChart3, Check, Clock, Cloud, Disc3, Edit2, ExternalLink, Headphones, Heart, Image as ImageIcon, ListMusic, Loader2, Music, Pause, Play, RefreshCw, Trophy, X } from '@lucide/svelte';
  import {
    LASTFM_TASTE_UPDATED_EVENT,
    getCachedLastFmOverview,
    getLastFmOverview,
    getLastFmSession,
    type LastFmOverview,
    type LastFmPeriodReport,
    type LastFmReportPeriod,
    type LastFmSession
  } from '$lib/lastfm';
  import ArtistTag from './ArtistTag.svelte';

  let osUsername = 'Пользователь';
  $: scUsername = $settings.scUser?.username || ''; // Для SoundCloud интеграции
  let lastFmSession: LastFmSession | null = null;
  let lastFmOverview: LastFmOverview | null = null;
  let lastFmLoading = false;
  let lastFmError = '';
  let lastFmPeriod: LastFmReportPeriod = '1month';
  let lastFmReport: LastFmPeriodReport = { artists: [], tracks: [] };

  const lastFmPeriods: Array<{ value: LastFmReportPeriod; label: string; shortLabel: string }> = [
    { value: '7day', label: 'За 7 дней', shortLabel: '7 дней' },
    { value: '1month', label: 'За месяц', shortLabel: 'Месяц' },
    { value: '12month', label: 'За год', shortLabel: 'Год' },
    { value: 'overall', label: 'За всё время', shortLabel: 'Всё время' }
  ];

  $: lastFmReport = lastFmOverview?.reports?.[lastFmPeriod] || { artists: [], tracks: [] };

  /**
   * Аккаунт Яндекса как личность профиля — второй по приоритету после SoundCloud.
   *
   * Раньше профиль знал только про SoundCloud, и у того, кто слушает через Яндекс Музыку,
   * оставался безымянный «Пользователь» с буквой вместо аватара — при том что приложение
   * прекрасно знает, кто вошёл: имя, логин и признак Плюса лежат в `settings.yandexUser` с
   * момента привязки.
   *
   * Порядок именно такой (SoundCloud → Яндекс → Last.fm → своё имя → имя в системе), потому что
   * привязанный аккаунт — это факт, а `customProfileName` вводили как раз тогда, когда
   * никакого аккаунта не было. Пока привязан хоть один, ручное имя не показывается и
   * карандаш правки скрыт — облачная личность не должна расходиться с ручным именем на этом ПК.
   */
  $: yandexUser = $settings.yandexUser;
  $: linkedName = scUsername || (yandexUser?.displayName ?? '') || lastFmSession?.username || '';

  let isEditing = false;
  let editValue = '';
  let isEditingBanner = false;
  let bannerValue = '';

  $: displayUsername = linkedName || $settings.customProfileName || osUsername;
  $: initial = displayUsername.charAt(0).toUpperCase();

  // Аватар берём у того же аккаунта, чьё имя показано, а не «первый непустой»: иначе рядом
  // с именем из SoundCloud могло встать лицо из Яндекса, и профиль показывал бы двух разных
  // людей одновременно.
  $: avatarUrl = scUsername
    ? $settings.scUser?.avatarUrl || ''
    : yandexUser
      ? yandexUser.avatarUrl || ''
      : lastFmSession?.avatarUrl || '';

  // Адреса для плашек. Считаются здесь, а не в разметке: в шаблоне Svelte выражения — это
  // обычный JS без TypeScript, так что ни `!`, ни `as` там писать нельзя.
  $: scPermalink = $settings.scUser?.permalink || '';
  $: yandexPage = yandexUser?.login
    ? `https://music.yandex.ru/users/${encodeURIComponent(yandexUser.login)}/playlists`
    : '';
  $: lastFmPage = lastFmSession?.profileUrl || '';

  let topTracks: ListenHistoryEntry[] = [];
  let uniqueTracks = 0;

  /**
   * Баннер профиля по приоритету: своя ссылка → шапка привязанного SoundCloud → обложка
   * месячного лидера Last.fm → самый слушаемый локальный трек. Последние варианты — не «настоящий» баннер, но пустая
   * плашка выглядит как незагрузившийся блок, а размытая обложка честно показывает,
   * что человек слушает. Ничего нет только у совсем нового профиля.
   */
  $: bannerUrl = $settings.profileBannerUrl?.trim()
    || $settings.scUser?.bannerUrl
    || lastFmOverview?.reports?.['1month']?.tracks?.[0]?.imageUrl
    || topTracks[0]?.coverUrl
    || '';

  // Обложка вместо шапки — картинка низкого разрешения и другого формата, её надо
  // сильнее размыть и растянуть, иначе видно, что это квадрат 500x500.
  $: bannerIsDerived = !$settings.profileBannerUrl?.trim() && !$settings.scUser?.bannerUrl;

  /**
   * Атмосферная подложка страницы. Раньше она рисовалась здесь же (`.profile-backdrop`) и
   * упиралась в стык с боковой панелью: `<main>` обрезает содержимое, панель матовая и
   * показывает сквозь себя фон БЕЗ подложки — на стыке стояла вертикальная граница между
   * двумя разными фонами. Теперь страница только отдаёт картинку, а рисует её слой фона
   * приложения, который тянется под панель (см. `pageAtmosphere` в stores).
   */
  let atmos: PageAtmosphere | null = null;
  $: {
    atmos = bannerUrl ? { url: bannerUrl, derived: bannerIsDerived } : null;
    pageAtmosphere.set(atmos);
  }

  // Гасим подложку только если она всё ещё наша: порядок «создать новую страницу →
  // уничтожить старую» Svelte не обещает, и слепой сброс погасил бы подложку, которую
  // только что поставил следующий раздел.
  onDestroy(() => pageAtmosphere.update(cur => (cur === atmos ? null : cur)));

  onMount(() => {
    lastFmSession = getLastFmSession();
    lastFmOverview = getCachedLastFmOverview();

    const syncLastFmCache = () => {
      lastFmSession = getLastFmSession();
      lastFmOverview = getCachedLastFmOverview();
    };
    window.addEventListener(LASTFM_TASTE_UPDATED_EVENT, syncLastFmCache);

    void (async () => {
      try {
        if (window && '__TAURI_INTERNALS__' in window) {
          osUsername = await invoke('get_os_username');
        }
      } catch (e) {
        console.warn("Could not get OS username", e);
      }

      syncScBanner();
      syncYandexAvatar();
      if (lastFmSession) await refreshLastFmOverview(false);
    })();

    return () => window.removeEventListener(LASTFM_TASTE_UPDATED_EVENT, syncLastFmCache);
  });

  async function refreshLastFmOverview(force: boolean) {
    if (!lastFmSession || lastFmLoading) return;
    lastFmLoading = true;
    lastFmError = '';
    try {
      lastFmOverview = await getLastFmOverview(force);
      lastFmSession = getLastFmSession();
    } catch (error) {
      lastFmError = error instanceof Error ? error.message : 'Не удалось загрузить отчёт Last.fm.';
    } finally {
      lastFmLoading = false;
    }
  }

  function formatCount(value: number) {
    return new Intl.NumberFormat('ru-RU').format(Math.max(0, value || 0));
  }

  function formatCloudUpdated(value: number) {
    if (!value) return 'ещё не обновлялась';
    const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} ч назад`;
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(value);
  }

  /**
   * Догружает аватар привязанного аккаунта Яндекса.
   *
   * Причина та же, что у `syncScBanner`: `yandexUser` лежит в localStorage с момента
   * привязки, а поле `avatarUrl` появилось позже — у всех, кто привязал аккаунт раньше, в
   * сохранённом объекте его нет, и профиль навсегда остался бы с буквой. Проверяем именно
   * `undefined`: пустая строка означает «спрашивали, аватара нет», и повторять запрос по
   * ней не нужно.
   */
  async function syncYandexAvatar() {
    const user = $settings.yandexUser;
    if (!user || user.avatarUrl !== undefined || !$settings.yandexToken || yandexAvatarSyncTried) return;
    yandexAvatarSyncTried = true;

    try {
      const { yandexAvatarUrl } = await import('$lib/yandex');
      // Функция не бросает: нет прав у токена — вернёт пустую строку, и мы её сохраним,
      // чтобы больше не спрашивать.
      const fetched = await yandexAvatarUrl($settings.yandexToken);
      const current = $settings.yandexUser;
      // Пока шёл запрос, аккаунт могли отвязать или привязать другой — тогда писать нечего.
      if (current && current.uid === user.uid) {
        $settings.yandexUser = { ...current, avatarUrl: fetched };
      }
    } catch (e) {
      console.warn('Could not refresh Yandex avatar', e);
    }
  }

  /**
   * Внешняя ссылка. В окне приложения `target="_blank"` открывать нечего: новых окон вебвью
   * не создаёт, и клик по такой ссылке просто ничего не делал. `openUrl` отдаёт адрес
   * системному браузеру. `href` у ссылок остаётся — он даёт и подсказку по наведению, и
   * работающее поведение, если страница вдруг открыта в обычном браузере (vite dev).
   */
  function openExternal(url: string) {
    openUrl(url).catch(e => console.warn('Не удалось открыть ссылку', e));
  }

  /**
   * Догружает шапку привязанного SoundCloud-аккаунта.
   *
   * `scUser` лежит в localStorage с момента привязки, а поле `bannerUrl` появилось позже —
   * у всех, кто привязал аккаунт раньше, в сохранённом объекте его просто нет, и профиль
   * навсегда остался бы с запасной обложкой. Один тихий запрос по уже известной ссылке
   * профиля добирает шапку и аватар; провал ничего не ломает — остаётся то, что было.
   */
  async function syncScBanner() {
    const user = $settings.scUser;
    if (!user?.permalink || user.bannerUrl || bannerSyncTried) return;
    bannerSyncTried = true;

    try {
      const { resolveSoundCloudProfile } = await import('$lib/api');
      const fresh = await resolveSoundCloudProfile(user.permalink);
      if (!fresh) return;
      $settings.scUser = {
        ...user,
        bannerUrl: fresh.bannerUrl || '',
        avatarUrl: fresh.avatarUrl || user.avatarUrl
      };
    } catch (e) {
      console.warn('Could not refresh SoundCloud profile visuals', e);
    }
  }

  function startEdit() {
    if (linkedName) return;
    isEditing = true;
    editValue = displayUsername;
  }

  function saveEdit() {
    $settings.customProfileName = editValue;
    isEditing = false;
  }

  function startBannerEdit() {
    isEditingBanner = true;
    bannerValue = $settings.profileBannerUrl || '';
  }

  function saveBanner() {
    $settings.profileBannerUrl = bannerValue.trim();
    isEditingBanner = false;
  }

  function clearBanner() {
    $settings.profileBannerUrl = '';
    bannerValue = '';
    isEditingBanner = false;
  }

  $: {
    uniqueTracks = Object.keys($listenStats.history || {}).length;
    topTracks = Object.values($listenStats.history)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  function playTrack(track: any) {
    if ($currentTrack?.title === track.title && $currentTrack?.artist === track.artist) {
      $isPlaying = !$isPlaying;
    } else {
      $currentTrack = track;
      $isPlaying = true;
    }
  }

  function formatTime(seconds: number) {
    if (seconds < 60) return `${seconds} сек`;
    const m = Math.floor(seconds / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h} ч ${m % 60} мин`;
    return `${m} мин`;
  }
</script>

<!-- Корень — система координат для шапки, поэтому `relative`. Своей прокрутки у него нет:
     страница скроллится общим `<main>`, как и все остальные разделы. Атмосферная подложка
     здесь больше не рисуется — она уехала в фоновый слой приложения, потому что внутри
     `<main>` её обрезал стык с боковой панелью (см. `pageAtmosphere` в stores). Отступы
     контента живут во вложенном слое. -->
<div class="profile-page w-full relative">

  <div class="profile-content relative z-10">

  <!-- Header / Profile Badge. Геометрия, вуали и аватар — в классах `.profile-hero*`:
       второй дизайн меняет им форму (аватар из круга в квадрат со свечением), а строка
       утилит такого не позволяла в принципе. `interactive-item` снят сознательно: шапка
       никуда не ведёт, а класс поднимал её целиком, стоило курсору пойти к кнопке
       «Баннер». -->
  <header class="profile-hero profile-hero-v2 group">
    <!-- Матовое стекло и заливка шапки отдельным слоем. На самом `header` они стоять не
         могут: чтобы размытие растворялось, его нужно гасить маской, а маска на header
         погасила бы вместе с фоном имя, аватар и кнопки. Пустой слой гасится целиком. -->
    <div class="profile-hero-glass" aria-hidden="true"></div>
    {#if bannerUrl}
      <!-- Баннер крупным планом — тот же снимок, что в подложке, но резче и ярче: одна
           картинка в двух масштабах даёт глубину. Две вуали обязательны: загрузить можно
           что угодно, включая почти белую картинку, а имя и статус обязаны остаться
           читаемыми. -->
      <img
        src={bannerUrl}
        alt=""
        aria-hidden="true"
        class="profile-hero-media"
        class:is-derived={bannerIsDerived}
      />
      <div class="profile-hero-veil"></div>
      <div class="profile-hero-fade"></div>
    {:else}
      <div class="profile-hero-tint"></div>
    {/if}

    <!-- Смена баннера. Кнопка проявляется по ховеру — как у имени, чтобы шапка не была
         засеяна элементами управления. -->
    <div class="absolute top-5 right-5 z-20">
      {#if isEditingBanner}
        <div class="flex items-center gap-2 bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl p-2 pl-3.5">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="url"
            bind:value={bannerValue}
            placeholder="Ссылка на картинку"
            class="bg-transparent w-[240px] text-[13px] text-white placeholder:text-white/30 focus:outline-none"
            on:keydown={(e) => { if (e.key === 'Enter') saveBanner(); if (e.key === 'Escape') isEditingBanner = false; }}
            autofocus
          />
          <button class="p-2 bg-primary text-black rounded-xl hover:opacity-90 transition-opacity" on:click={saveBanner} aria-label="Сохранить баннер">
            <Check size={15} />
          </button>
          {#if $settings.profileBannerUrl}
            <button class="p-2 bg-white/10 text-white/70 rounded-xl hover:bg-white/20 hover:text-white transition-colors" on:click={clearBanner} title="Убрать свой баннер">
              <X size={15} />
            </button>
          {/if}
        </div>
      {:else}
        <button
          class="profile-banner-action"
          on:click={startBannerEdit}
        >
          <ImageIcon size={14} />
          Баннер
        </button>
      {/if}
    </div>

    <div class="profile-hero-avatar">
      {#if avatarUrl}
        <img src={avatarUrl} alt="Аватар {displayUsername}" width="128" height="128" class="w-full h-full object-cover" />
      {:else}
        {initial}
      {/if}
    </div>

    <div class="profile-hero-body profile-identity">
      <div class="profile-hero-kicker"><Disc3 size={12} /> Профиль слушателя</div>
      
      {#if isEditing}
        <div class="flex items-center gap-3">
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" bind:value={editValue} class="bg-black/20 border border-white/20 rounded-xl px-4 py-2 page-title focus:outline-none focus:border-primary" on:keydown={(e) => e.key === 'Enter' && saveEdit()} autofocus />
          <button class="p-3 bg-primary text-black rounded-xl hover:scale-105 transition-transform" on:click={saveEdit}>
            <Check size={20} />
          </button>
        </div>
      {:else}
        <div class="profile-name-row group/name">
          <h1 class="profile-name">{displayUsername}</h1>
          {#if !linkedName}
            <button class="profile-name-edit" on:click={startEdit} aria-label="Изменить имя профиля" title="Изменить имя">
              <Edit2 size={16} />
            </button>
          {/if}
        </div>
        <div class="profile-badge-row">
            {#if ['klimentos', 'uniquebleed', 'bleed'].includes(displayUsername.toLowerCase())}
              <span class="profile-role-badge is-team">
                Team Lomify
              </span>
            {/if}
            {#if ['pizxx'].includes(displayUsername.toLowerCase())}
              <span class="profile-role-badge is-dev">
                Developer
              </span>
            {/if}
            <!-- Плашка сервиса — одна: она говорит, чьё имя и лицо показаны выше. Второй
                 аккаунт рядом с первым только запутал бы, а привязки видны в настройках. -->
            {#if scPermalink}
              <a
                href={scPermalink}
                target="_blank"
                rel="noreferrer"
                class="profile-provider-badge is-soundcloud"
                on:click|preventDefault={() => openExternal(scPermalink)}
              >
                SoundCloud
              </a>
            {:else if yandexUser}
              <!-- Ссылка только при известном логине: страница пользователя в Музыке
                   адресуется по нему, а без него вести некуда — тогда просто метка. -->
              {#if yandexPage}
                <a
                  href={yandexPage}
                  target="_blank"
                  rel="noreferrer"
                  class="profile-provider-badge is-yandex"
                  on:click|preventDefault={() => openExternal(yandexPage)}
                >
                  Яндекс Музыка{yandexUser.hasPlus ? ' · Плюс' : ''}
                </a>
              {:else}
                <span class="profile-provider-badge is-yandex">
                  Яндекс Музыка{yandexUser.hasPlus ? ' · Плюс' : ''}
                </span>
              {/if}
            {:else if lastFmSession}
              <a
                href={lastFmPage}
                target="_blank"
                rel="noreferrer"
                class="profile-provider-badge is-lastfm"
                on:click|preventDefault={() => openExternal(lastFmPage)}
              >
                Last.fm · облачная история
              </a>
            {/if}
        </div>
      {/if}
      
      <p class="profile-summary">
        {#if lastFmOverview}
          {formatCount(lastFmOverview.playcount)} скробблов хранится в Last.fm и доступно на других компьютерах
        {:else}
          {uniqueTracks ? `${uniqueTracks} уникальных треков в истории` : 'Здесь постепенно соберётся твоя музыкальная история'}
        {/if}
      </p>
    </div>
  </header>

  <section aria-labelledby="profile-overview-title">
    <div class="profile-section-head">
      <div>
        <span class="profile-section-kicker">Твоя библиотека</span>
        <h2 id="profile-overview-title" class="section-title">Обзор</h2>
      </div>
    </div>

    <div class="profile-stat-grid">
      <article class="profile-stat-card">
        <span class="profile-stat-icon"><Clock size={19} /></span>
        <div><span>В эфире</span><strong>{formatTime($listenStats.listenSeconds)}</strong></div>
      </article>
      <article class="profile-stat-card">
        <span class="profile-stat-icon"><Headphones size={19} /></span>
        <div><span>Прослушиваний</span><strong>{$listenStats.tracksPlayed}</strong></div>
      </article>
      <article class="profile-stat-card">
        <span class="profile-stat-icon"><Heart size={19} /></span>
        <div><span>В лайках</span><strong>{$likedTracks.length}</strong></div>
      </article>
      <article class="profile-stat-card">
        <span class="profile-stat-icon"><ListMusic size={19} /></span>
        <div><span>Плейлистов</span><strong>{$playlists.length}</strong></div>
      </article>
    </div>
  </section>

  <section aria-labelledby="profile-lastfm-title">
    <div class="profile-section-head profile-lastfm-section-head">
      <div>
        <span class="profile-section-kicker">Облачная история</span>
        <h2 id="profile-lastfm-title" class="section-title">Отчёт Last.fm</h2>
      </div>
      {#if lastFmSession}
        <button
          type="button"
          class="profile-lastfm-refresh"
          on:click={() => refreshLastFmOverview(true)}
          disabled={lastFmLoading}
          aria-label="Обновить отчёт Last.fm"
        >
          {#if lastFmLoading}<Loader2 size={15} class="animate-spin" />{:else}<RefreshCw size={15} />{/if}
          Обновить
        </button>
      {/if}
    </div>

    {#if !lastFmSession}
      <div class="plate profile-lastfm-connect">
        <span class="profile-lastfm-connect-icon" aria-hidden="true"><Cloud size={23} /></span>
        <div>
          <h3>Подключи Last.fm в настройках</h3>
          <p>После входа здесь появятся отчёты за неделю, месяц, год и всё время. На другом ПК войди в тот же Last.fm — история подтянется из облака.</p>
        </div>
      </div>
    {:else if lastFmLoading && !lastFmOverview}
      <div class="plate profile-lastfm-loading" aria-live="polite">
        <Loader2 size={20} class="animate-spin" /> Собираю облачный отчёт…
      </div>
    {:else if lastFmOverview}
      <div class="profile-lastfm-shell">
        <div class="profile-lastfm-toolbar">
          <div class="profile-lastfm-periods" role="tablist" aria-label="Период отчёта Last.fm">
            {#each lastFmPeriods as period}
              <button
                type="button"
                role="tab"
                aria-selected={lastFmPeriod === period.value}
                class:active={lastFmPeriod === period.value}
                on:click={() => lastFmPeriod = period.value}
                title={period.label}
              >
                {period.shortLabel}
              </button>
            {/each}
          </div>
          <div class="profile-lastfm-cloud-state">
            <Cloud size={14} aria-hidden="true" />
            <span>Last.fm · {formatCloudUpdated(lastFmOverview.updatedAt)}</span>
          </div>
        </div>

        {#if lastFmError}
          <div class="profile-lastfm-error" role="status">{lastFmError} Показываю последние сохранённые данные.</div>
        {/if}

        <div class="profile-lastfm-summary-grid">
          <article>
            <span><Headphones size={15} /> В облачной истории</span>
            <strong>{formatCount(lastFmOverview.playcount)}</strong>
            <small>скробблов со всех подключённых плееров</small>
          </article>
          <article>
            <span><Trophy size={15} /> Топ-исполнитель</span>
            <strong title={lastFmReport.artists[0]?.name || ''}>{lastFmReport.artists[0]?.name || 'Пока нет данных'}</strong>
            <small>{lastFmReport.artists[0] ? `${formatCount(lastFmReport.artists[0].playcount)} прослушиваний` : 'за выбранный период'}</small>
          </article>
          <article>
            <span><BarChart3 size={15} /> Топ-трек</span>
            <strong title={lastFmReport.tracks[0]?.title || ''}>{lastFmReport.tracks[0]?.title || 'Пока нет данных'}</strong>
            <small>{lastFmReport.tracks[0] ? `${lastFmReport.tracks[0].artist} · ${formatCount(lastFmReport.tracks[0].playcount)}×` : 'за выбранный период'}</small>
          </article>
        </div>

        <div class="profile-lastfm-charts">
          <article class="profile-lastfm-chart">
            <div class="profile-lastfm-chart-head">
              <div>
                <strong>Исполнители</strong>
                <span>{lastFmPeriods.find((period) => period.value === lastFmPeriod)?.label}</span>
              </div>
            </div>
            {#if lastFmReport.artists.length > 0}
              <div class="profile-lastfm-list">
                {#each lastFmReport.artists.slice(0, 6) as artist, index}
                  <a href={artist.url} target="_blank" rel="noreferrer" on:click|preventDefault={() => openExternal(artist.url)}>
                    <span class="profile-lastfm-rank">{index + 1}</span>
                    <span class="profile-lastfm-list-copy"><strong>{artist.name}</strong><small>{formatCount(artist.playcount)} прослушиваний</small></span>
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                {/each}
              </div>
            {:else}
              <p class="profile-lastfm-empty">За этот период исполнителей пока нет.</p>
            {/if}
          </article>

          <article class="profile-lastfm-chart">
            <div class="profile-lastfm-chart-head">
              <div>
                <strong>Треки</strong>
                <span>{lastFmPeriods.find((period) => period.value === lastFmPeriod)?.label}</span>
              </div>
            </div>
            {#if lastFmReport.tracks.length > 0}
              <div class="profile-lastfm-list">
                {#each lastFmReport.tracks.slice(0, 6) as track, index}
                  <a href={track.url} target="_blank" rel="noreferrer" on:click|preventDefault={() => openExternal(track.url)}>
                    <span class="profile-lastfm-rank">{index + 1}</span>
                    <span class="profile-lastfm-list-copy"><strong>{track.title}</strong><small>{track.artist} · {formatCount(track.playcount)}×</small></span>
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                {/each}
              </div>
            {:else}
              <p class="profile-lastfm-empty">За этот период треков пока нет.</p>
            {/if}
          </article>
        </div>

        {#if lastFmOverview.discoveryArtists.length > 0}
          <div class="profile-lastfm-discovery">
            <div>
              <strong>Похожие исполнители для рекомендаций</strong>
              <span>Lomify добавляет их как слабый исследовательский сигнал — лайки и твоя реальная история всё равно важнее.</span>
            </div>
            <div>
              {#each lastFmOverview.discoveryArtists.slice(0, 6) as artist}
                <a href={artist.url} target="_blank" rel="noreferrer" on:click|preventDefault={() => openExternal(artist.url)}>{artist.name}</a>
              {/each}
            </div>
          </div>
        {/if}

        <p class="profile-lastfm-sync-note"><Cloud size={14} aria-hidden="true" /> Эти отчёты и музыкальный вкус хранятся в Last.fm. На другом ПК подключи тот же аккаунт — локальные плейлисты и свой баннер при этом не переносятся.</p>
      </div>
    {:else}
      <div class="plate profile-lastfm-connect is-error">
        <span class="profile-lastfm-connect-icon" aria-hidden="true"><Cloud size={23} /></span>
        <div><h3>Отчёт не загрузился</h3><p>{lastFmError || 'Проверь интернет и попробуй обновить данные.'}</p></div>
      </div>
    {/if}
  </section>

  <section aria-labelledby="profile-top-title">
    <div class="profile-section-head">
      <div>
        <span class="profile-section-kicker">За всё время</span>
        <h2 id="profile-top-title" class="section-title">Чаще всего звучат</h2>
      </div>
      {#if topTracks.length}<span class="profile-section-count">Топ {topTracks.length}</span>{/if}
    </div>

    {#if topTracks.length === 0}
      <div class="plate profile-empty-state">
        <span class="profile-empty-icon"><Music size={24} /></span>
        <div>
          <h3 class="display-title">Статистика пока пустая</h3>
          <p class="empty-hint">Послушай пару треков — здесь появится твой личный рейтинг.</p>
        </div>
      </div>
    {:else}
      {@const favorite = topTracks[0]}
      {@const favoriteActive = $currentTrack?.title === favorite.title && $currentTrack?.artist === favorite.artist}
      <div class="profile-top-layout">
        <article class="profile-favorite-card">
          <div class="profile-favorite-art">
            {#if favorite.coverUrl}
              <img src={favorite.coverUrl} alt="Обложка {favorite.title}" width="320" height="320" loading="lazy" decoding="async" />
            {:else}
              <Music size={42} />
            {/if}
            <button type="button" on:click={() => playTrack(favorite)} aria-label={favoriteActive && $isPlaying ? 'Поставить на паузу' : `Включить ${favorite.title}`}>
              {#if favoriteActive && $isPlaying}<Pause size={20} fill="currentColor" />{:else}<Play size={20} fill="currentColor" />{/if}
            </button>
          </div>
          <div class="profile-favorite-copy">
            <span><Trophy size={14} /> Главный трек</span>
            <h3>{favorite.title}</h3>
            <div class="profile-favorite-artist"><ArtistTag artist={favorite.artist} artists={favorite.artists} /></div>
            <p>{favorite.count} {favorite.count === 1 ? 'прослушивание' : favorite.count < 5 ? 'прослушивания' : 'прослушиваний'}</p>
          </div>
        </article>

        <div class="profile-ranking" aria-label="Самые прослушиваемые треки">
          {#each topTracks as track, i}
            {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
            <button type="button" class:active={isActive} class="profile-rank-row" on:click={() => playTrack(track)}>
              <span class="profile-rank-number">{String(i + 1).padStart(2, '0')}</span>
              <span class="profile-rank-cover">
                {#if track.coverUrl}
                  <img src={track.coverUrl} alt="" width="48" height="48" loading="lazy" decoding="async" />
                {:else}
                  <Music size={18} />
                {/if}
                {#if isActive}<span class="profile-rank-playing">{#if $isPlaying}<Pause size={13} fill="currentColor" />{:else}<Play size={13} fill="currentColor" />{/if}</span>{/if}
              </span>
              <span class="profile-rank-copy">
                <strong>{track.title}</strong>
                <span><ArtistTag artist={track.artist} artists={track.artists} /></span>
              </span>
              <span class="profile-rank-count">{track.count}×</span>
              <span class="profile-rank-meter" style={`--profile-rank-progress: ${(track.count / topTracks[0].count) * 100}%`}></span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </section>
  </div>
</div>
