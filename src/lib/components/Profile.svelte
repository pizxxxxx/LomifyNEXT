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
  import { listenStats, currentTrack, isPlaying, settings, pageAtmosphere, type PageAtmosphere } from '$lib/stores';
  import { Clock, Play, Headphones, Trophy, Music, Edit2, Check, Image as ImageIcon, X } from '@lucide/svelte';
  import ArtistTag from './ArtistTag.svelte';

  let osUsername = 'Пользователь';
  $: scUsername = $settings.scUser?.username || ''; // Для SoundCloud интеграции

  /**
   * Аккаунт Яндекса как личность профиля — второй по приоритету после SoundCloud.
   *
   * Раньше профиль знал только про SoundCloud, и у того, кто слушает через Яндекс Музыку,
   * оставался безымянный «Пользователь» с буквой вместо аватара — при том что приложение
   * прекрасно знает, кто вошёл: имя, логин и признак Плюса лежат в `settings.yandexUser` с
   * момента привязки.
   *
   * Порядок именно такой (SoundCloud → Яндекс → своё имя → имя в системе), потому что
   * привязанный аккаунт — это факт, а `customProfileName` вводили как раз тогда, когда
   * никакого аккаунта не было. Пока привязан хоть один, ручное имя не показывается и
   * карандаш правки скрыт — так уже работал SoundCloud, и второй источник ведёт себя так же.
   */
  $: yandexUser = $settings.yandexUser;
  $: linkedName = scUsername || (yandexUser?.displayName ?? '');

  let isEditing = false;
  let editValue = '';
  let isEditingBanner = false;
  let bannerValue = '';

  $: displayUsername = linkedName || $settings.customProfileName || osUsername;
  $: initial = displayUsername.charAt(0).toUpperCase();

  // Аватар берём у того же аккаунта, чьё имя показано, а не «первый непустой»: иначе рядом
  // с именем из SoundCloud могло встать лицо из Яндекса, и профиль показывал бы двух разных
  // людей одновременно.
  $: avatarUrl = scUsername ? $settings.scUser?.avatarUrl || '' : yandexUser?.avatarUrl || '';

  // Адреса для плашек. Считаются здесь, а не в разметке: в шаблоне Svelte выражения — это
  // обычный JS без TypeScript, так что ни `!`, ни `as` там писать нельзя.
  $: scPermalink = $settings.scUser?.permalink || '';
  $: yandexPage = yandexUser?.login
    ? `https://music.yandex.ru/users/${encodeURIComponent(yandexUser.login)}/playlists`
    : '';

  let totalHours = 0;
  let topTracks: any[] = [];

  /**
   * Баннер профиля по приоритету: своя ссылка → шапка привязанного SoundCloud → обложка
   * самого слушаемого трека. Последний вариант — не «настоящий» баннер, но пустая
   * плашка выглядит как незагрузившийся блок, а размытая обложка честно показывает,
   * что человек слушает. Ничего нет только у совсем нового профиля.
   */
  $: bannerUrl = $settings.profileBannerUrl?.trim()
    || $settings.scUser?.bannerUrl
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

  onMount(async () => {
    try {
      if (window && '__TAURI_INTERNALS__' in window) {
        osUsername = await invoke('get_os_username');
      }
    } catch (e) {
      console.warn("Could not get OS username", e);
    }

    syncScBanner();
    syncYandexAvatar();
  });

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
    totalHours = Number(($listenStats.listenSeconds / 3600).toFixed(1));
    
    // Sort history by count descending
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
<div class="w-full relative">

  <div class="relative z-10 p-8 space-y-12 pb-32">

  <!-- Header / Profile Badge. Геометрия, вуали и аватар — в классах `.profile-hero*`:
       второй дизайн меняет им форму (аватар из круга в квадрат со свечением), а строка
       утилит такого не позволяла в принципе. `interactive-item` снят сознательно: шапка
       никуда не ведёт, а класс поднимал её целиком, стоило курсору пойти к кнопке
       «Баннер». -->
  <header class="profile-hero group">
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
          class="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2 px-3.5 py-2 rounded-xl bg-black/40 backdrop-blur-md border border-white/10 text-white/70 hover:text-white text-[12.5px]"
          on:click={startBannerEdit}
        >
          <ImageIcon size={14} />
          Баннер
        </button>
      {/if}
    </div>

    <div class="profile-hero-avatar">
      {#if avatarUrl}
        <img src={avatarUrl} alt="Avatar" class="w-full h-full object-cover" />
      {:else}
        {initial}
      {/if}
    </div>

    <div class="profile-hero-body">
      <div class="profile-hero-kicker">Профиль слушателя</div>
      
      {#if isEditing}
        <div class="flex items-center gap-3">
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" bind:value={editValue} class="bg-black/20 border border-white/20 rounded-xl px-4 py-2 page-title focus:outline-none focus:border-primary" on:keydown={(e) => e.key === 'Enter' && saveEdit()} autofocus />
          <button class="p-3 bg-primary text-black rounded-xl hover:scale-105 transition-transform" on:click={saveEdit}>
            <Check size={20} />
          </button>
        </div>
      {:else}
        <div class="flex items-center gap-4 group/name flex-wrap">
          <h1 class="page-title !text-[38px] !font-medium flex items-center gap-4">
            {displayUsername}
            {#if ['klimentos', 'uniquebleed', 'bleed'].includes(displayUsername.toLowerCase())}
              <span class="text-[14px] font-bold px-2.5 py-1 rounded bg-orange-500/20 text-orange-400 whitespace-nowrap shrink-0 border border-orange-500/30 tracking-normal normal-case shadow-[0_0_10px_rgba(249,115,22,0.3)]">
                Team Lomify
              </span>
            {/if}
            {#if ['pizxx'].includes(displayUsername.toLowerCase())}
              <span class="text-[14px] font-bold px-2.5 py-1 rounded bg-green-500/20 text-green-400 whitespace-nowrap shrink-0 border border-green-500/30 tracking-normal normal-case shadow-[0_0_10px_rgba(34,197,94,0.3)]">
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
                class="bg-[#ff5500] text-white text-sm font-bold px-3 py-1 rounded-lg flex items-center gap-1 shadow-lg hover:bg-[#ff5500]/80 transition-colors"
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
                  class="bg-[#ffcc00] text-black text-sm font-bold px-3 py-1 rounded-lg flex items-center gap-1 shadow-lg hover:bg-[#ffcc00]/80 transition-colors"
                  on:click|preventDefault={() => openExternal(yandexPage)}
                >
                  Яндекс Музыка{yandexUser.hasPlus ? ' · Плюс' : ''}
                </a>
              {:else}
                <span class="bg-[#ffcc00] text-black text-sm font-bold px-3 py-1 rounded-lg flex items-center gap-1 shadow-lg">
                  Яндекс Музыка{yandexUser.hasPlus ? ' · Плюс' : ''}
                </span>
              {/if}
            {/if}
          </h1>
          {#if !linkedName}
            <button class="opacity-0 group-hover/name:opacity-100 text-neutral-400 hover:text-white transition-opacity p-2 bg-white/5 rounded-full" on:click={startEdit}>
              <Edit2 size={18} />
            </button>
          {/if}
        </div>
      {/if}
      
      <p class="text-white/45 mt-2.5 text-[14px] leading-relaxed">Сколько ты уже отслушал.</p>
    </div>
  </header>

  <!-- Stats Grid -->
  <div class="grid grid-cols-2 gap-6">
    <div class="bg-white/5 p-6 rounded-3xl border border-white/10 flex flex-col gap-2 interactive-item">
      <Clock class="text-primary mb-2" size={28} />
      <div class="stat-label">Время прослушивания</div>
      <div class="stat-value">{formatTime($listenStats.listenSeconds)}</div>
    </div>
    <div class="bg-white/5 p-6 rounded-3xl border border-white/10 flex flex-col gap-2 interactive-item">
      <Headphones class="text-primary mb-2" size={28} />
      <div class="stat-label">Треков включено</div>
      <div class="stat-value">{$listenStats.tracksPlayed}</div>
    </div>
  </div>

  <!-- Top Tracks -->
  <div>
    <div class="flex items-center gap-3 mb-6">
      <Trophy class="text-yellow-500" size={24} />
      <h2 class="section-title">Самые прослушиваемые треки</h2>
    </div>

    {#if topTracks.length === 0}
      <div class="plate p-8 flex flex-col items-start">
        <Music size={26} class="text-white/20 mb-4" />
        <h3 class="display-title">Статистика пока пустая</h3>
        <p class="empty-hint">Послушай пару треков — здесь появится, что ты крутишь чаще всего.</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each topTracks as track, i}
          {@const isActive = $currentTrack?.title === track.title && $currentTrack?.artist === track.artist}
          <div class="flex items-center gap-4 p-3 rounded-2xl transition-colors group {isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/10'}">
            <div class="text-neutral-500 font-bold w-6 text-center">{i + 1}</div>
            
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            {#if track.coverUrl}
              <img src={track.coverUrl} class="w-12 h-12 rounded-lg object-cover shadow-md cursor-pointer hover:scale-105 transition" alt="Cover" on:click={() => playTrack(track)} />
            {:else}
              <div class="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center cursor-pointer hover:scale-105 transition" on:click={() => playTrack(track)}>
                <Music size={20} class="text-neutral-400" />
              </div>
            {/if}
            
            <div class="flex-1 min-w-0">
              <div class="font-bold truncate text-base {isActive ? 'text-primary' : 'text-white'}">{track.title}</div>
              <div class="text-sm text-neutral-400 min-w-0">
                <ArtistTag artist={track.artist} artists={track.artists} />
              </div>
            </div>
            
            <div class="text-sm font-medium text-neutral-500 bg-black/20 px-3 py-1 rounded-full">
              Включено: <span class="text-primary">{track.count}</span> раз
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
  </div>
</div>
