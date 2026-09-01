<script lang="ts">
  import { settings, playlists, listenStats, notify, currentTrack, isPlaying } from '$lib/stores';
  import {
    Download,
    Loader2,
    Check,
    Music,
    Volume2,
    RefreshCw,
    ExternalLink,
    Heart,
    HandCoins,
    WalletCards,
    X,
    Palette,
    Headphones,
    Captions,
    MonitorCog,
    Database,
    HardDrive,
    ShieldCheck,
    Sparkles
  } from 'lucide-svelte';
  import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
  import { appDataDir, appLocalDataDir } from '@tauri-apps/api/path';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { onMount, tick } from 'svelte';
  import { withCount } from '$lib/utils/plural';
  import { APP_NAME, APP_VERSION, APP_CHANNEL } from '$lib/version';
  import { listOutputs, applyOutput, type AudioOutput } from '$lib/audioOutput';
  import SelectMenu from './SelectMenu.svelte';
  import SpotifyImport from './SpotifyImport.svelte';
  import LastFmConnect from './LastFmConnect.svelte';
  import MusicServiceIcon from './MusicServiceIcon.svelte';
  let autostartEnabled = false;
  let dataPath = '';
  let localDataPath = '';
  const RELEASES_URL = 'https://github.com/pizxxxxx/LomifyNEXT/releases';
  const YOOMONEY_BUTTON_URL = 'https://yoomoney.ru/quickpay/fundraise/button?billNumber=1JTH771HF4Q.260827';
  const YOOMONEY_WALLET_URL = 'https://yoomoney.ru/to/4100116984624656';
  let supportOpen = false;
  let supportTrigger: HTMLButtonElement;
  let supportDialog: HTMLElement;
  let appIconOpen = false;
  let appIconTrigger: HTMLButtonElement;
  let appIconDialog: HTMLElement;
  let cacheAudioBytes = 0;
  let cacheLikedBytes = 0;
  let cacheImageBytes = 0;
  let cacheStatsLoading = false;
  let cacheCleaning = false;
  let cacheCleanupMessage = '';

  const cacheRetentionOptions = [
    { value: 14, label: '14 дней' },
    { value: 30, label: '30 дней' },
    { value: 60, label: '60 дней' },
    { value: 90, label: '90 дней' }
  ];
  const cacheLimitOptions = [
    { value: 512, label: '512 МБ' },
    { value: 1024, label: '1 ГБ' },
    { value: 2048, label: '2 ГБ' },
    { value: 4096, label: '4 ГБ' }
  ];
  const uiScaleOptions = [
    { value: 'auto', label: 'Автоматически' },
    { value: '100', label: '100%' },
    { value: '110', label: '110%' },
    { value: '125', label: '125%' },
    { value: '133', label: '133%' },
    { value: '150', label: '150%' },
    { value: '175', label: '175%' },
    { value: '200', label: '200%' }
  ];

  $: cacheTotalBytes = cacheAudioBytes + cacheLikedBytes + cacheImageBytes;

  type SettingsTab = 'appearance' | 'music' | 'lyrics' | 'system' | 'data';
  const settingsTabs: SettingsTab[] = ['appearance', 'music', 'lyrics', 'system', 'data'];
  let settingsTab: SettingsTab = 'appearance';
  $: settingsTabIndex = settingsTabs.indexOf(settingsTab);

  function setSettingsTab(tab: SettingsTab) {
    settingsTab = tab;
  }

  async function onSettingsTabsKeydown(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();

    const current = settingsTabs.indexOf(settingsTab);
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = settingsTabs.length - 1;
    else if (event.key === 'ArrowRight') next = (current + 1) % settingsTabs.length;
    else next = (current - 1 + settingsTabs.length) % settingsTabs.length;

    settingsTab = settingsTabs[next];
    await tick();
    document.getElementById(`settings-tab-${settingsTab}`)?.focus();
  }

  /**
   * Внешние страницы остаются осознанным действием пользователя: приложение ничего не
   * скачивает и не проводит платежи внутри webview, а передаёт адрес системному браузеру.
   * В браузерной разработке используем обычное окно, в Tauri — системный браузер.
   */
  async function openExternalPage(url: string, errorMessage: string) {
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        await openUrl(url);
      } else {
        const externalWindow = window.open(url, '_blank', 'noopener,noreferrer');
        if (!externalWindow) throw new Error('Popup blocked');
      }
    } catch (e) {
      console.warn(errorMessage, e);
      notify(errorMessage, 'error');
    }
  }

  function openReleases() {
    return openExternalPage(RELEASES_URL, 'Не удалось открыть страницу обновлений');
  }

  function portalToBody(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  async function setSupportOpen(next: boolean) {
    supportOpen = next;
    await tick();
    if (next) supportDialog?.focus();
    else supportTrigger?.focus();
  }

  async function setAppIconOpen(next: boolean) {
    appIconOpen = next;
    await tick();
    if (next) appIconDialog?.focus();
    else appIconTrigger?.focus();
  }

  function onAppIconKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void setAppIconOpen(false);
      return;
    }
    if (event.key !== 'Tab' || !appIconDialog) return;
    event.preventDefault();
    appIconDialog.querySelector<HTMLButtonElement>('button')?.focus();
  }

  function onSupportKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void setSupportOpen(false);
      return;
    }
    if (event.key !== 'Tab' || !supportDialog) return;
    const controls = [...supportDialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function chooseSupport(url: string) {
    supportOpen = false;
    void openExternalPage(url, 'Не удалось открыть ЮMoney');
  }

  function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ`;
    return `${(mb / 1024).toFixed(1)} ГБ`;
  }

  async function refreshCacheStats() {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    cacheStatsLoading = true;
    try {
      const { getCacheUsage } = await import('$lib/cacheMaintenance');
      const usage = await getCacheUsage();
      cacheAudioBytes = usage.audioBytes;
      cacheLikedBytes = usage.likedBytes;
      cacheImageBytes = usage.imageBytes;
    } catch (e) {
      console.warn('[cache] не удалось прочитать размер кэша', e);
    } finally {
      cacheStatsLoading = false;
    }
  }

  async function cleanupCacheNow() {
    if (cacheCleaning) return;
    cacheCleaning = true;
    cacheCleanupMessage = 'Проверяю сохранённые файлы…';
    try {
      const { runSmartCacheCleanup } = await import('$lib/cacheMaintenance');
      const result = await runSmartCacheCleanup({ force: true });
      const freed = formatBytes(result?.freedBytes || 0);
      const removed = result?.removedFiles || 0;
      cacheCleanupMessage = removed
        ? `Удалено ${withCount(removed, 'файл', 'файла', 'файлов')} · освобождено ${freed}`
        : 'Лишних файлов не найдено';
      notify(removed ? `Готово: освободилось ${freed}.` : 'Кэш уже в порядке — удалять нечего.', 'success');
      await refreshCacheStats();
    } catch (e) {
      console.error('[cache] smart cleanup failed', e);
      cacheCleanupMessage = 'Не удалось завершить очистку';
      notify('Не удалось очистить кэш. Попробуй ещё раз.', 'error');
    } finally {
      cacheCleaning = false;
    }
  }

  async function handleGibberishToggle() {
    $settings.gibberishMode = !$settings.gibberishMode;
    if ($settings.gibberishMode) {
      try {
        const { getSoundCloudClientId, safeFetch, findBestTranscoding } = await import('$lib/api');
        const clientId = await getSoundCloudClientId();
        const url = "https://soundcloud.com/denismellstroy/tyomnyy-prints-madk1d-ty-che-obkukurikalas-prod-by-k4neswagga-yngyuuuchi";
        const res = await safeFetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`);
        const t = await res.json();
        if (t && t.id) {
           const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : '';
           const track = {
             id: t.id,
             title: t.title,
             artist: t.user?.username || 'Unknown',
             coverUrl: cover,
             audioUrl: findBestTranscoding(t),
             source: 'soundcloud',
             duration: t.duration || 0,
             permalinkUrl: t.permalink_url || url,
             transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || []
           };
           currentTrack.set(track as any);
           isPlaying.set(true);
        }
      } catch (e) {
        console.error("Gibberish track load failed", e);
      }
    }
  }

  onMount(() => {
    if ($settings.uiStyle === 'style3') {
      $settings.uiStyle = 'style1';
    }
    (async () => {
      try {
        if (window && '__TAURI_INTERNALS__' in window) {
          autostartEnabled = await isEnabled();
          dataPath = await appDataDir();
          localDataPath = await appLocalDataDir();
        }
      } catch(e) {
        console.error("Failed to load settings data", e);
      }
    })();
    // Список устройств перечитывается на каждом открытии вкладки (компонент здесь
    // создаётся заново, см. +page.svelte), поэтому воткнутые наушники видно без кнопки.
    refreshOutputs();
    void refreshCacheStats();
  });

  // ── Устройство вывода ────────────────────────────────────────────────────────
  let outputs: AudioOutput[] = [];
  let outputsLoading = false;
  // `name` устройства, которое сейчас открывается, или '' для «системного». Открытие
  // Bluetooth-приёмника занимает секунды, и всё это время нужно показывать, что выбор
  // принят и идёт, — иначе по списку начинают щёлкать повторно.
  let outputSwitching: string | null = null;

  // Сохранённое устройство, которого нет в списке: колонку выключили или переставили в
  // другой разъём. Отдельная строка нужна, чтобы выбор не выглядел потерянным — вывод
  // сейчас идёт через системное, но настройка жива и вернётся вместе с устройством.
  $: missingOutput =
    $settings.outputDevice && !outputs.some(o => o.name === $settings.outputDevice)
      ? ($settings.outputDeviceLabel || $settings.outputDevice)
      : null;

  async function refreshOutputs() {
    outputsLoading = true;
    try {
      outputs = await listOutputs();
    } catch (e) {
      console.error('[audio] list devices failed', e);
      notify('Не удалось получить список устройств воспроизведения.', 'error');
    }
    outputsLoading = false;
  }

  /** `device === null` — вернуться на системное устройство по умолчанию. */
  async function chooseOutput(device: AudioOutput | null) {
    const name = device?.name ?? null;
    if (outputSwitching !== null) return;
    if (name === $settings.outputDevice) return;

    outputSwitching = name ?? '';
    try {
      await applyOutput(name);
      // Пишем настройку только после успешного открытия: сохранённое устройство
      // применяется на каждом запуске, и записать то, что не открылось, значит повторять
      // одну и ту же ошибку при каждом старте.
      $settings.outputDevice = name;
      $settings.outputDeviceLabel = device?.description ?? '';
      notify(
        device ? `Звук переключён на «${device.description}».` : 'Звук переключён на системное устройство.',
        'success'
      );
    } catch (e: any) {
      // Тишины не будет: выходной поток в device.rs при неудаче откатывается на
      // устройство по умолчанию, а ошибка доезжает сюда уже после этого.
      notify(
        device
          ? `Не удалось подключить «${device.description}». Звук продолжит идти через системное устройство.`
          : 'Не удалось переключиться на системное устройство.',
        'error'
      );
      console.error('[audio] switch device failed', e);
      refreshOutputs();
    }
    outputSwitching = null;
  }

  async function toggleAutostart() {
    try {
      if (autostartEnabled) {
        await disable();
        autostartEnabled = false;
      } else {
        await enable();
        autostartEnabled = true;
      }
    } catch(e) {
      notify('Не удалось изменить настройку автозапуска.', 'error');
    }
  }

  let scInputUrl = '';
  let scLoading = false;
  async function linkSoundCloud() {
    if (!scInputUrl) return;
    scLoading = true;
    try {
      const { resolveSoundCloudProfile, getUserPlaylists } = await import('$lib/api');
      let url = scInputUrl;
      if (!url.startsWith('http')) url = 'https://soundcloud.com/' + url;
      const user = await resolveSoundCloudProfile(url);
      if (!user) {
        notify('Профиль не найден. Проверь ссылку или имя пользователя.', 'error');
        scLoading = false;
        return;
      }

      $settings.scUser = user;
      notify('Профиль SoundCloud подключён.', 'success');

      const userPlaylists = await getUserPlaylists(user.id);
      if (userPlaylists.length > 0) {
        playlists.update(p => {
          const fresh = userPlaylists.filter((up: any) => !p.some((existing: any) => existing.id === up.id));
          return [...fresh, ...p];
        });
        notify(`Импортировано ${withCount(userPlaylists.length, 'плейлист', 'плейлиста', 'плейлистов')}.`, 'success');
      }

      // Лайки тянет сверка, а не отдельный проход по списку. Она делает то же самое (берёт
      // из профиля то, чего здесь нет), но заодно заводит снимок, по которому дальше видно
      // снятые лайки — без него первое зеркалирование ничего бы не удаляло, и расхождение
      // жило бы до второго запуска. Об итоге сверка сообщает сама.
      const { syncLikes } = await import('$lib/likes');
      await syncLikes({ only: 'soundcloud' });
    } catch (e) {
      notify('Не удалось подключить профиль SoundCloud. Проверь ссылку и подключение к интернету.', 'error');
    }
    scLoading = false;
  }

  /** Свести лайки с профилем SoundCloud по кнопке. Разбор зеркала — в `$lib/likes`. */
  async function refreshSCLikes() {
    if (!$settings.scUser) return;
    scLoading = true;
    try {
      const { syncLikes } = await import('$lib/likes');
      // Итог показывает сама сверка: она одна знает, сколько пришло и сколько ушло, и
      // отличает «списки сходятся» от «источник ответил не целиком».
      await syncLikes({ only: 'soundcloud' });
    } catch (e) {
      notify('Не удалось обновить лайки SoundCloud. Попробуй ещё раз.', 'error');
    }
    scLoading = false;
  }

  /**
   * Переключатель эффекта движения. Один на все четыре, а не четыре обработчика подряд:
   * тумблеры отличаются только именем настройки.
   *
   * Сравнение с `false`, а не `!value`, — из-за уже сохранённых настроек: у тех, кто
   * поставил приложение до этой версии, полей в localStorage нет, и `undefined` должен
   * читаться как «включено» (эффекты работали и раньше). `!undefined` дало бы обратное —
   * первое нажатие ничего бы не изменило, потому что тумблер уже показан включённым.
   */
  function toggleFx(key: 'coverTilt' | 'coverGlare' | 'cardSheen' | 'panelPress') {
    $settings[key] = $settings[key] === false;
  }

  function toggleAutoCache() {
    $settings.autoCache = !$settings.autoCache;
  }

  function setSource(source: 'soundcloud' | 'yandex') {
    // Переключиться на Яндекс без токена — это выбрать источник, который сразу же ничего
    // не найдёт. Поэтому не даём молча уйти в нерабочее состояние, а показываем, чего не
    // хватает: плашка привязки стоит ниже в этой же вкладке.
    if (source === 'yandex' && !$settings.yandexToken) {
      notify('Сначала подключи Яндекс Музыку в разделе ниже.', 'info');
      return;
    }
    $settings.searchSource = source;
  }

  let ymInputToken = '';
  let ymLoading = false;

  async function linkYandex() {
    const raw = ymInputToken.trim();
    if (!raw) return;
    ymLoading = true;
    try {
      const { normalizeYandexToken, yandexAccountStatus, yandexAvatarUrl } = await import('$lib/yandex');
      // Проверка запросом, а не регуляркой: единственный способ узнать, что токен живой —
      // спросить у API, кто по нему вошёл. Заодно получаем uid для импорта лайков.
      const account = await yandexAccountStatus(raw);
      // Аватар отдаёт Паспорт, а не Музыка, и права на него у музыкального токена может не
      // быть — поэтому отдельным запросом, который не умеет бросать (вернёт пустую строку).
      const avatarUrl = await yandexAvatarUrl(raw);
      $settings.yandexToken = normalizeYandexToken(raw);
      $settings.yandexUser = { ...account, avatarUrl };
      $settings.searchSource = 'yandex';
      ymInputToken = '';
      notify(`Яндекс Музыка подключена: ${account.displayName}.`, 'success');
      // Лайки забираем сразу: привязка ради них и делается, а ждать перезапуска ради первой
      // сверки — ровно та ручная работа, от которой мы уходим. Отдельным `catch`, чтобы
      // отказ сверки не превратился в жалобу на токен: токен уже приняли строкой выше.
      try {
        const { syncLikes } = await import('$lib/likes');
        await syncLikes({ only: 'yandex' });
      } catch (e) {
        console.warn('[likes] первая сверка после привязки не прошла', e);
      }
    } catch (e: any) {
      // Текст берём как есть, без приставки «Токен не принят»: она была здесь всегда и
      // подменяла собой причину. Причина не обязана быть в токене — это может быть и
      // неопознанный клиент, и лимит запросов, и запуск в браузере. Формулировку под каждый
      // случай даёт `describeYmError` в yandex.ts, дублировать её догадкой не нужно.
      notify(e?.message || 'Не удалось связаться с Яндекс Музыкой.', 'error');
    }
    ymLoading = false;
  }

  function unlinkYandex() {
    $settings.yandexToken = '';
    $settings.yandexUser = null;
    // Оставлять выбранным источник, доступа к которому больше нет, нельзя — поиск бы
    // молча падал в SoundCloud, и было бы непонятно, почему.
    if ($settings.searchSource === 'yandex') $settings.searchSource = 'soundcloud';
    notify('Яндекс Музыка отключена.', 'info');
  }

  /**
   * Свести лайки с аккаунтом Яндекса по кнопке.
   *
   * Раньше это был односторонний импорт: он умел только добавлять сюда то, чего здесь нет.
   * Теперь то же действие ведёт зеркало — отправляет в аккаунт отметки, поставленные здесь,
   * забирает поставленные в вебе и убирает снятые там (разбор в `$lib/likes`). Кнопка
   * осталась потому, что автоматическая сверка идёт при запуске, а лайк в вебе могли
   * поставить, пока приложение открыто.
   */
  async function syncYandexLikes() {
    if (!$settings.yandexToken) return;
    ymLoading = true;
    try {
      const { syncLikes } = await import('$lib/likes');
      await syncLikes({ only: 'yandex' });
    } catch (e: any) {
      notify(e?.message ? `Не удалось синхронизировать лайки: ${e.message}` : 'Не удалось синхронизировать лайки.', 'error');
    }
    ymLoading = false;
  }

  function setLyricsAlignment(align: 'left' | 'right' | 'fullscreen') {
    $settings.lyricsAlignment = align;
  }
  
  function setTheme(theme: string) {
    $settings.theme = theme;
  }

  type FontId =
    | 'inter'
    | 'manrope'
    | 'onest'
    | 'golos'
    | 'playfair'
    | 'unbounded'
    | 'caveat'
    | 'comfortaa'
    | 'cormorant'
    | 'jost'
    | 'raleway'
    | 'rubik';
  const lyricsFonts: { id: FontId; name: string; hint: string; family: string }[] = [
    {
      id: 'inter',
      name: 'Inter',
      hint: 'Нейтральный и очень читаемый',
      family: "'Inter Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'manrope',
      name: 'Manrope',
      hint: 'Современный и выразительный',
      family: "'Manrope Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'onest',
      name: 'Onest',
      hint: 'Мягкий, спокойный ритм',
      family: "'Onest Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'golos',
      name: 'Golos Text',
      hint: 'Плотный набор с отличной кириллицей',
      family: "'Golos Text Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'playfair',
      name: 'Playfair Display',
      hint: 'Контрастная книжная антиква',
      family: "'Playfair Display Variable', Georgia, serif"
    },
    {
      id: 'unbounded',
      name: 'Unbounded',
      hint: 'Широкий футуристичный гротеск',
      family: "'Unbounded Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'caveat',
      name: 'Caveat',
      hint: 'Живой рукописный почерк',
      family: "'Caveat Variable', 'Segoe Print', cursive"
    },
    {
      id: 'comfortaa',
      name: 'Comfortaa',
      hint: 'Округлый и дружелюбный',
      family: "'Comfortaa Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'cormorant',
      name: 'Cormorant Garamond',
      hint: 'Лиричная журнальная антиква',
      family: "'Cormorant Garamond Variable', Georgia, serif"
    },
    {
      id: 'jost',
      name: 'Jost',
      hint: 'Чистый геометричный ритм',
      family: "'Jost Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'raleway',
      name: 'Raleway',
      hint: 'Тонкий и музыкальный характер',
      family: "'Raleway Variable', 'Segoe UI', sans-serif"
    },
    {
      id: 'rubik',
      name: 'Rubik',
      hint: 'Мягкий современный гротеск',
      family: "'Rubik Variable', 'Segoe UI', sans-serif"
    }
  ];

  function setFont(font: FontId) {
    $settings.fontFamily = font;
  }
  
  const themes = [
    { id: 'default', name: 'Pure', color: '#1DB954' },
    { id: 'toxic-sludge', name: 'Lime', color: '#bada55' },
    { id: 'dragon-sc', name: 'SC Prime', color: '#ff5500' },
    { id: 'n1xoy', name: 'n1xoy', color: '#B00000' },
    { id: 'night-city', name: 'Lemon', color: '#fce205' },
    { id: 'vice-city', name: 'Magenta', color: '#ff2a85' },
    { id: 'abyss-water', name: 'Cyan', color: '#00d2ff' },
    { id: 'purple-haze', name: 'Violet', color: '#9b59b6' },
    { id: 'martian-dust', name: 'Brick', color: '#ff7e5f' },
    { id: 'blood-moon', name: 'Wine', color: '#8a0303' },
    { id: 'electric-indigo', name: 'Space', color: '#6600ff' },
    { id: 'dracula', name: 'Dracula', color: '#bd93f9' }
  ];

  function clearLyricsCache() {
    if (confirm('Очистить кэш текстов песен?')) {
      localStorage.removeItem('lomifynext_lyrics_cache');
    }
  }

  function resetProfileStats() {
    if (confirm('Обнулить часы прослушивания и историю? Треки и лайки останутся.')) {
      listenStats.set({ listenSeconds: 0, tracksPlayed: 0, history: {} });
      notify('Статистика профиля сброшена.', 'success');
    }
  }

  function resetAllData() {
    if (confirm('Снести всё: настройки, историю, лайки, плейлисты. Вернуть не получится. Точно?')) {
      localStorage.clear();
      window.location.reload();
    }
  }
</script>

<div class="max-w-3xl mx-auto py-8">
  <h2 class="page-title mb-5">Настройки</h2>

  <div class="settings-tabs-shell">
    <div
      class="seg-control is-lg settings-tabs-control"
      style="--seg-count: 5; --seg-index: {settingsTabIndex}"
      role="tablist"
      tabindex="-1"
      aria-label="Разделы настроек"
      on:keydown={onSettingsTabsKeydown}
    >
      <span class="seg-pill" aria-hidden="true"></span>
      <button
        id="settings-tab-appearance"
        type="button"
        role="tab"
        aria-controls="settings-tab-panel"
        aria-selected={settingsTab === 'appearance'}
        tabindex={settingsTab === 'appearance' ? 0 : -1}
        class="seg-item"
        class:is-active={settingsTab === 'appearance'}
        on:click={() => setSettingsTab('appearance')}
      >
        <Palette size={16} aria-hidden="true" />
        <span class="settings-tab-label">Вид</span>
      </button>
      <button
        id="settings-tab-music"
        type="button"
        role="tab"
        aria-controls="settings-tab-panel"
        aria-selected={settingsTab === 'music'}
        tabindex={settingsTab === 'music' ? 0 : -1}
        class="seg-item"
        class:is-active={settingsTab === 'music'}
        on:click={() => setSettingsTab('music')}
      >
        <Headphones size={16} aria-hidden="true" />
        <span class="settings-tab-label">Музыка</span>
      </button>
      <button
        id="settings-tab-lyrics"
        type="button"
        role="tab"
        aria-controls="settings-tab-panel"
        aria-selected={settingsTab === 'lyrics'}
        tabindex={settingsTab === 'lyrics' ? 0 : -1}
        class="seg-item"
        class:is-active={settingsTab === 'lyrics'}
        on:click={() => setSettingsTab('lyrics')}
      >
        <Captions size={16} aria-hidden="true" />
        <span class="settings-tab-label">Тексты</span>
      </button>
      <button
        id="settings-tab-system"
        type="button"
        role="tab"
        aria-controls="settings-tab-panel"
        aria-selected={settingsTab === 'system'}
        tabindex={settingsTab === 'system' ? 0 : -1}
        class="seg-item"
        class:is-active={settingsTab === 'system'}
        on:click={() => setSettingsTab('system')}
      >
        <MonitorCog size={16} aria-hidden="true" />
        <span class="settings-tab-label">Система</span>
      </button>
      <button
        id="settings-tab-data"
        type="button"
        role="tab"
        aria-controls="settings-tab-panel"
        aria-selected={settingsTab === 'data'}
        tabindex={settingsTab === 'data' ? 0 : -1}
        class="seg-item"
        class:is-active={settingsTab === 'data'}
        on:click={() => setSettingsTab('data')}
      >
        <Database size={16} aria-hidden="true" />
        <span class="settings-tab-label">Данные</span>
      </button>
    </div>
  </div>

  <!-- Все группы остаются смонтированы внутри одного tabpanel, но CSS показывает только
       выбранную категорию. Так поля ввода и локальное состояние не теряются при переходе,
       а длинный технический список превращается в пять предсказуемых экранов. -->
  <div
    id="settings-tab-panel"
    class="settings-tab-panels"
    data-settings-tab={settingsTab}
    role="tabpanel"
    aria-labelledby="settings-tab-{settingsTab}"
  >

    <!-- ── Внешний вид ─────────────────────────────────────────────────────── -->
    <section class="settings-pane" data-settings-pane="appearance">
      <div class="settings-group">
        <span class="settings-group-title">Внешний вид</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">

        <!-- Global design -->
        <div class="plate p-8">
          <h3 class="section-title">Глобальный дизайн</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">
            Выбери общий характер интерфейса. Цвет темы и плотность панелей настраиваются
            отдельно и работают в обоих вариантах.
          </p>
          <div class="grid grid-cols-2 gap-3">
            <!-- Не просто две кнопки, а два превью: разницу между дизайнами видно до
                 переключения, поэтому каждый вариант рисует сам себя в миниатюре. -->
            <button
              class="design-card {$settings.design !== 'aurora' ? 'is-active' : ''}"
              on:click={() => $settings.design = 'classic'}
            >
              <span class="design-card-preview design-preview-classic">
                <span class="design-preview-bar"></span>
                <span class="design-preview-bar is-short"></span>
                <span class="design-preview-tile"></span>
              </span>
              <span class="design-card-name">Классический</span>
              <span class="design-card-hint">Мягкое стекло, спокойная типографика</span>
            </button>
            <button
              class="design-card {$settings.design === 'aurora' ? 'is-active' : ''}"
              on:click={() => $settings.design = 'aurora'}
            >
              <span class="design-card-preview design-preview-aurora">
                <span class="design-preview-bar"></span>
                <span class="design-preview-bar is-short"></span>
                <span class="design-preview-tile"></span>
              </span>
              <span class="design-card-name">Aurora</span>
              <span class="design-card-hint">Контраст, акцентные кромки, плотный набор</span>
            </button>
          </div>
        </div>

        <!-- Interface Blur & Theme Depth -->
        <div class="plate p-8">
          <h3 class="section-title">Стиль интерфейса</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">Плотность панелей и то, насколько цвет темы проникает в фон.</p>
          <div class="settings-choice-grid mb-5">
            <button
              type="button"
              class="settings-choice"
              class:is-active={$settings.uiStyle === 'style1'}
              on:click={() => $settings.uiStyle = 'style1'}
            >
              <span class="settings-choice-icon" aria-hidden="true"><Palette size={17} /></span>
              <span class="settings-choice-copy">
                <strong>Светлее</strong>
                <small>Воздушные панели</small>
              </span>
              <span class="settings-choice-check" aria-hidden="true">
                {#if $settings.uiStyle === 'style1'}<Check size={14} />{/if}
              </span>
            </button>
            <button
              type="button"
              class="settings-choice"
              class:is-active={$settings.uiStyle === 'style2'}
              on:click={() => $settings.uiStyle = 'style2'}
            >
              <span class="settings-choice-icon" aria-hidden="true"><MonitorCog size={17} /></span>
              <span class="settings-choice-copy">
                <strong>Темнее</strong>
                <small>Плотные панели</small>
              </span>
              <span class="settings-choice-check" aria-hidden="true">
                {#if $settings.uiStyle === 'style2'}<Check size={14} />{/if}
              </span>
            </button>
          </div>

          <div class="setting-row mb-3">
            <div class="flex-1 min-w-0">
              <div class="setting-title">Кнопки окна</div>
              <div class="setting-hint">
                Оба варианта нарисованы Lomify — системная рамка Windows не включается.
              </div>
            </div>
            <div
              class="window-controls-picker"
              role="radiogroup"
              aria-label="Стиль кнопок окна"
            >
              <button
                type="button"
                role="radio"
                aria-checked={$settings.windowControlsStyle !== 'macos'}
                class:is-active={$settings.windowControlsStyle !== 'macos'}
                on:click={() => $settings.windowControlsStyle = 'windows'}
              >
                <span class="window-controls-preview is-windows" aria-hidden="true">
                  <i></i><i></i><i></i>
                </span>
                <span>Windows справа</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={$settings.windowControlsStyle === 'macos'}
                class:is-active={$settings.windowControlsStyle === 'macos'}
                on:click={() => $settings.windowControlsStyle = 'macos'}
              >
                <span class="window-controls-preview is-macos" aria-hidden="true">
                  <i></i><i></i><i></i>
                </span>
                <span>Круглые слева</span>
              </button>
            </div>
          </div>

          <div class="setting-row mb-3">
            <div class="flex-1 min-w-0">
              <div class="setting-title">Масштаб интерфейса</div>
              <div class="setting-hint">
                Авто сохраняет привычный размер: Full HD — 100%, 2K — около 133%, 4K —
                до 200%. Системный масштаб Windows уже учитывается и повторно не умножается.
              </div>
            </div>
            <div class="settings-scale-control">
              <SelectMenu
                bind:value={$settings.uiScale}
                options={uiScaleOptions}
                ariaLabel="Масштаб интерфейса"
              />
            </div>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Глубина темы</div>
              <div class="setting-hint">Цвет темы аккуратно подмешивается в фон приложения.</div>
            </div>
            <button
              aria-label="Глубина темы"
              role="switch"
              aria-checked={$settings.globalThemeEffect}
              class="switch"
              on:click={() => $settings.globalThemeEffect = !$settings.globalThemeEffect}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div class="setting-row mt-3">
            <div class="flex-1 min-w-0">
              <div class="setting-title">Стиль тусни</div>
              <div class="setting-hint">
                Как «Моя тусня» на главной реагирует на музыку: сглаженное дыхание или живой ритм.
              </div>
            </div>
            <div
              class="seg-control"
              style="--seg-count: 2; --seg-index: {$settings.waveStyle === 'pulse' ? 1 : 0}"
              role="radiogroup"
              aria-label="Стиль тусни"
            >
              <span class="seg-pill" aria-hidden="true"></span>
              <button
                type="button"
                role="radio"
                aria-checked={$settings.waveStyle !== 'pulse'}
                class="seg-item"
                class:is-active={$settings.waveStyle !== 'pulse'}
                on:click={() => $settings.waveStyle = 'smooth'}
              >
                Плавная
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={$settings.waveStyle === 'pulse'}
                class="seg-item"
                class:is-active={$settings.waveStyle === 'pulse'}
                on:click={() => $settings.waveStyle = 'pulse'}
              >
                Ритмичная
              </button>
            </div>
          </div>

          <div class="setting-row mt-3">
            <div>
              <div class="setting-title">Режим производительности</div>
              <div class="setting-hint">
                Упрощает тяжёлые эффекты, отключает предпрослушивание карточек и снижает
                нагрузку на видеокарту. Внешний вид останется знакомым, а прокрутка и текст
                песен будут работать плавнее на старых компьютерах.
              </div>
            </div>
            <button
              aria-label="Режим производительности"
              role="switch"
              aria-checked={$settings.perfMode}
              class="switch"
              on:click={() => $settings.perfMode = !$settings.perfMode}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div class="setting-row mt-3">
            <div>
              <div class="setting-title">Треки слева</div>
              <div class="setting-hint">Списки треков прижимаются к левому краю. Остальной интерфейс не двигается.</div>
            </div>
            <button
              aria-label="Левосторонний список треков"
              role="switch"
              aria-checked={$settings.leftAlignTracks}
              class="switch"
              on:click={() => $settings.leftAlignTracks = !$settings.leftAlignTracks}
            >
              <span class="switch-knob"></span>
            </button>
          </div>
        </div>

        <!-- Theme Selection -->
        <div class="plate p-8">
          <h3 class="section-title">Тема оформления</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">Акцентный цвет всего интерфейса — подписи, активные элементы, свечение.</p>

          <!-- The adaptive accent used to live in another plate entirely, which made the
               palette below look broken for no visible reason once it was on. It *replaces*
               the palette, so it belongs right above it. -->
          <div class="setting-row mb-5">
            <div>
              <div class="setting-title">Адаптивная тема</div>
              <div class="setting-hint">Акцент берётся с обложки текущего трека. Палитра ниже при этом не используется.</div>
            </div>
            <button
              aria-label="Адаптивная тема"
              role="switch"
              aria-checked={$settings.accentFromCover}
              class="switch"
              on:click={() => $settings.accentFromCover = !$settings.accentFromCover}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div
            class="grid grid-cols-2 md:grid-cols-3 gap-3 transition-opacity duration-300 {$settings.accentFromCover ? 'opacity-35 pointer-events-none' : ''}"
            aria-disabled={$settings.accentFromCover}
          >
            {#each themes as theme}
              <button
                class="theme-swatch {$settings.theme === theme.id && !$settings.accentFromCover ? 'is-active' : ''}"
                disabled={$settings.accentFromCover}
                on:click={() => setTheme(theme.id)}
              >
                <span class="w-9 h-9 rounded-full shrink-0 shadow-inner" style="background: {theme.color}"></span>
                <span class="text-[13px] font-medium truncate">{theme.name}</span>
              </button>
            {/each}
          </div>

          {#if $settings.accentFromCover}
            <p class="empty-hint !max-w-[56ch]">Пока адаптивная тема включена, цвет диктует обложка. Выключи тумблер, чтобы выбрать вручную.</p>
          {/if}
        </div>
      </div>
    </section>

    <!-- ── Движение и эффекты ──────────────────────────────────────────────── -->
    <section class="settings-pane" data-settings-pane="appearance">
      <div class="settings-group">
        <span class="settings-group-title">Движение и эффекты</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">
        <!-- Четыре эффекта в одной плашке, а не четыре плашки по тумблеру: выключают их, как
             правило, все разом и по одной причине — «пусть ничего не дёргается». Разложенные
             по странице, они бы читались как четыре независимые функции, и связь между ними
             (все четыре — движение под курсором) пришлось бы угадывать. -->
        <div class="plate p-8">
          <h3 class="section-title">Движение под курсором</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">
            Здесь можно оставить только те движения, которые тебе нравятся. В режиме
            производительности все четыре эффекта временно отключаются автоматически.
          </p>

          <div class="flex flex-col gap-3">
            <div class="setting-row">
              <div>
                <div class="setting-title">3D-наклон обложек</div>
                <div class="setting-hint">
                  Обложка слегка наклоняется вслед за курсором. Если музыкальные полки
                  прокручиваются рывками, попробуй сначала отключить этот эффект.
                </div>
              </div>
              <button
                aria-label="3D-наклон обложек"
                role="switch"
                aria-checked={$settings.coverTilt !== false}
                class="switch"
                on:click={() => toggleFx('coverTilt')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div>
                <div class="setting-title">Блик под курсором</div>
                <div class="setting-hint">
                  Мягкое свечение следует за курсором и делает обложки похожими на глянцевые.
                </div>
              </div>
              <button
                aria-label="Блик под курсором"
                role="switch"
                aria-checked={$settings.coverGlare !== false}
                class="switch"
                on:click={() => toggleFx('coverGlare')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div>
                <div class="setting-title">Проблеск по плоским карточкам</div>
                <div class="setting-hint">
                  Короткая полоса света появляется на строках исполнителей и других плоских
                  карточках, когда на них наводят курсор.
                </div>
              </div>
              <button
                aria-label="Проблеск по плоским карточкам"
                role="switch"
                aria-checked={$settings.cardSheen !== false}
                class="switch"
                on:click={() => toggleFx('cardSheen')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div>
                <div class="setting-title">Отклик боковой панели</div>
                <div class="setting-hint">
                  Пункты навигации слегка двигаются к курсору и мягко реагируют на нажатие.
                </div>
              </div>
              <button
                aria-label="Отклик боковой панели"
                role="switch"
                aria-checked={$settings.panelPress !== false}
                class="switch"
                on:click={() => toggleFx('panelPress')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Музыка ──────────────────────────────────────────────────────────── -->
    <section class="settings-pane" data-settings-pane="music">
      <div class="settings-group">
        <span class="settings-group-title">Музыка</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">

        <!-- Audio Source. Стоит первым в группе, а плашки привязок — сразу за ним: выбор
             источника без привязанного аккаунта не работает, и подсказка «плашка ниже» в
             `setSource` теперь действительно указывает на соседний блок, а не на другой
             конец страницы. -->
        <div class="plate p-8">
          <h3 class="section-title mb-2">Источник аудио</h3>
          <p class="setting-hint !mt-0 mb-5">Выбери сервис для поиска и воспроизведения. Музыка с компьютера и сохранённые треки доступны при любом варианте.</p>
          <div class="settings-choice-grid">
            <button
              type="button"
              class="settings-choice is-soundcloud"
              class:is-active={$settings.searchSource === 'soundcloud'}
              on:click={() => setSource('soundcloud')}
            >
              <span class="settings-choice-icon" aria-hidden="true"><MusicServiceIcon service="soundcloud" size={19} /></span>
              <span class="settings-choice-copy">
                <strong>SoundCloud</strong>
                <small>Публичные треки и профили</small>
              </span>
              <span class="settings-choice-check" aria-hidden="true">
                {#if $settings.searchSource === 'soundcloud'}<Check size={14} />{/if}
              </span>
            </button>
            <button
              type="button"
              class="settings-choice is-yandex"
              class:is-active={$settings.searchSource === 'yandex'}
              on:click={() => setSource('yandex')}
            >
              <span class="settings-choice-icon" aria-hidden="true"><MusicServiceIcon service="yandex" size={19} /></span>
              <span class="settings-choice-copy">
                <span class="settings-choice-titleline">
                  <strong>Яндекс Музыка</strong>
                  <em>Рекомендуется</em>
                </span>
                <small>{$settings.yandexUser ? $settings.yandexUser.displayName : 'Нужен OAuth-токен'}</small>
              </span>
              <span class="settings-choice-check" aria-hidden="true">
                {#if $settings.searchSource === 'yandex'}<Check size={14} />{/if}
              </span>
            </button>
          </div>
        </div>

        <!-- Подключения провайдеров используют ту же иерархию, что Spotify ниже:
             компактная шапка, один ряд аккаунта/формы и спокойная служебная подсказка. -->
        <div class="provider-import-card is-soundcloud">
          <div class="provider-import-head">
            <span class="provider-import-mark" aria-hidden="true"><MusicServiceIcon service="soundcloud" size={25} /></span>
            <div>
              <span class="provider-import-kicker">Подключение медиатеки</span>
              <h3>Импорт из SoundCloud</h3>
              <p>Импортирует публичный профиль, плейлисты и лайки. Вход в аккаунт не потребуется.</p>
            </div>
            {#if $settings.scUser}
              <span class="provider-import-status"><Check size={14} aria-hidden="true" /> Подключён</span>
            {/if}
          </div>

          {#if $settings.scUser}
            <div class="provider-import-body">
              <div class="provider-account-row">
                <div class="provider-account-identity">
                  <span class="provider-account-avatar">
                    {#if $settings.scUser.avatarUrl}
                      <img src={$settings.scUser.avatarUrl} alt="" />
                    {:else}
                      <MusicServiceIcon service="soundcloud" size={21} />
                    {/if}
                  </span>
                  <div>
                    <strong>{$settings.scUser.username}</strong>
                    <span>Публичная медиатека синхронизирована</span>
                  </div>
                </div>
                <div class="provider-account-actions">
                  <button type="button" class="is-primary" on:click={refreshSCLikes} disabled={scLoading}>
                    {#if scLoading}<Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />{/if}
                    {scLoading ? 'Сверяю…' : 'Сверить лайки'}
                  </button>
                  <button type="button" class="is-danger" on:click={() => $settings.scUser = null}>Отвязать</button>
                </div>
              </div>
              <p class="provider-import-note">
                Лайки обновляются при запуске приложения. Изменения из Lomify не отправляются
                обратно в SoundCloud, потому что публичный профиль не даёт такого доступа.
              </p>
            </div>
          {:else}
            <div class="provider-import-body">
              <label for="soundcloud-profile">Ссылка на профиль или никнейм</label>
              <div class="provider-import-field">
                <ExternalLink size={16} aria-hidden="true" />
                <input
                  id="soundcloud-profile"
                  type="text"
                  bind:value={scInputUrl}
                  placeholder="https://soundcloud.com/никнейм"
                  autocomplete="off"
                  spellcheck="false"
                />
                <button type="button" class="is-primary" on:click={linkSoundCloud} disabled={scLoading}>
                  {#if scLoading}
                    <Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />
                    Подключаю…
                  {:else}
                    Привязать
                  {/if}
                </button>
              </div>
              <p class="provider-import-note">Вход и пароль не нужны — читаются только публичные данные профиля.</p>
            </div>
          {/if}
        </div>

        <!-- Yandex Music Integration -->
        <div class="provider-import-card is-yandex">
          <div class="provider-import-head">
            <span class="provider-import-mark" aria-hidden="true"><MusicServiceIcon service="yandex" size={25} /></span>
            <div>
              <span class="provider-import-kicker">Подключение медиатеки</span>
              <h3>Импорт из Яндекс Музыки</h3>
              <p>Подключает аккаунт и синхронизирует любимые треки. Полные версии доступны при активной подписке Плюс.</p>
            </div>
            {#if $settings.yandexUser}
              <span class="provider-import-status"><Check size={14} aria-hidden="true" /> Подключён</span>
            {/if}
          </div>

          {#if $settings.yandexUser}
            <div class="provider-import-body">
              <div class="provider-account-row">
                <div class="provider-account-identity">
                  <span class="provider-account-avatar">
                    {#if $settings.yandexUser.avatarUrl}
                      <img src={$settings.yandexUser.avatarUrl} alt="" />
                    {:else}
                      <MusicServiceIcon service="yandex" size={21} />
                    {/if}
                  </span>
                  <div>
                    <strong>{$settings.yandexUser.displayName}</strong>
                    <span>
                      {$settings.yandexUser.login || 'Аккаунт привязан'}{$settings.yandexUser.hasPlus ? ' · Плюс' : ''}
                    </span>
                  </div>
                </div>
                <div class="provider-account-actions">
                  <button type="button" class="is-primary" on:click={syncYandexLikes} disabled={ymLoading}>
                    {#if ymLoading}<Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />{/if}
                    {ymLoading ? 'Сверяю…' : 'Сверить лайки'}
                  </button>
                  <button type="button" class="is-danger" on:click={unlinkYandex}>Отвязать</button>
                </div>
              </div>
              <p class="provider-import-note">
                Без активной подписки Яндекс Музыка отдаёт только короткие фрагменты, поэтому такие треки нельзя воспроизвести полностью.
              </p>
            </div>
          {:else}
            <div class="provider-import-body">
              <p class="provider-import-description">
                Нужен OAuth-токен аккаунта. Его можно получить расширением
                <code>yandex-music-token</code> и вставить сюда строкой.
              </p>
              <label for="yandex-token">OAuth-токен</label>
              <div class="provider-import-field">
                <Music size={16} aria-hidden="true" />
                <input
                  id="yandex-token"
                  type="password"
                  bind:value={ymInputToken}
                  placeholder="y0_AgAAAA..."
                  autocomplete="off"
                  spellcheck="false"
                />
                <button type="button" class="is-primary" on:click={linkYandex} disabled={ymLoading}>
                  {#if ymLoading}
                    <Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />
                    Подключаю…
                  {:else}
                    Привязать
                  {/if}
                </button>
              </div>
              <div class="provider-import-meta">
                <p class="provider-import-note">
                  Токен хранится только на этом компьютере. Он даёт полный доступ к аккаунту — не показывай его никому.
                </p>
                <button
                  type="button"
                  class="provider-help-link"
                  on:click={() => openUrl('https://github.com/MarshalX/yandex-music-token')}
                >
                  Где взять токен <ExternalLink size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          {/if}
        </div>

        <SpotifyImport />

        <LastFmConnect />

        <!-- Устройство вывода. Стоит сразу за источниками: группа «Музыка» читается как
             «откуда играем» → «куда играем» → что делаем с кэшем. Выбор оформлен одним
             списком, а не списком плюс тумблером «следовать за системой»: «Системное по
             умолчанию» — это и есть слежение, и два элемента управления одной вещью
             неизбежно расходились бы между собой (см. applyOutput в $lib/audioOutput). -->
        <div class="plate p-8">
          <div class="flex items-start justify-between gap-4 mb-6">
            <div>
              <h3 class="section-title">Устройство воспроизведения</h3>
              <p class="setting-hint !mt-2 !max-w-[54ch]">
                Выбери колонки или наушники. При переключении трек продолжит играть с того же места, а очередь сохранится.
              </p>
            </div>
            <button
              class="settings-action-button"
              on:click={refreshOutputs}
              disabled={outputsLoading || outputSwitching !== null}
              title="Обновить список"
            >
              <RefreshCw class="w-4 h-4 {outputsLoading ? 'animate-spin' : ''}" />
              Обновить
            </button>
          </div>

          <div class="flex flex-col gap-2.5">
            <button
              class="output-row {$settings.outputDevice === null ? 'is-active' : ''}"
              on:click={() => chooseOutput(null)}
              disabled={outputSwitching !== null}
            >
              <span class="output-row-icon">
                {#if outputSwitching === ''}
                  <Loader2 class="w-4 h-4 animate-spin" />
                {:else}
                  <Volume2 class="w-4 h-4" />
                {/if}
              </span>
              <span class="min-w-0">
                <span class="output-row-name">Системное по умолчанию</span>
                <span class="output-row-hint">
                  Следовать за системой: сменили устройство в Windows — звук уходит туда же.
                </span>
              </span>
              {#if $settings.outputDevice === null}
                <Check class="w-4 h-4 shrink-0 text-primary" />
              {/if}
            </button>

            {#each outputs as device (device.name)}
              <button
                class="output-row {$settings.outputDevice === device.name ? 'is-active' : ''}"
                on:click={() => chooseOutput(device)}
                disabled={outputSwitching !== null}
              >
                <span class="output-row-icon">
                  {#if outputSwitching === device.name}
                    <Loader2 class="w-4 h-4 animate-spin" />
                  {:else}
                    <Volume2 class="w-4 h-4" />
                  {/if}
                </span>
                <span class="min-w-0">
                  <span class="output-row-name">{device.description}</span>
                  {#if device.is_default}
                    <span class="output-row-hint">Выбрано системой по умолчанию</span>
                  {/if}
                </span>
                {#if $settings.outputDevice === device.name}
                  <Check class="w-4 h-4 shrink-0 text-primary" />
                {/if}
              </button>
            {/each}

            {#if missingOutput}
              <div class="output-row is-missing">
                <span class="output-row-icon">
                  <Volume2 class="w-4 h-4" />
                </span>
                <span class="min-w-0">
                  <span class="output-row-name">{missingOutput}</span>
                  <span class="output-row-hint">
                    Сейчас не подключено — звук идёт через системное. Выбор сохранён и
                    вернётся вместе с устройством.
                  </span>
                </span>
              </div>
            {/if}

            {#if outputs.length === 0 && !outputsLoading}
              <p class="empty-hint !max-w-[54ch]">
                Устройств не нашлось. В браузере такой список пуст — он собирается только в
                собранном приложении.
              </p>
            {/if}
          </div>
        </div>

        <!-- Кеш и подготовка следующего трека. Раньше здесь стояла одна плашка про офлайн; обе
             настройки про одно и то же — что приложение успевает скачать заранее, — поэтому
             стоят рядом, а не в разных местах вкладки. -->
        <div class="plate p-8">
          <h3 class="section-title mb-6">Кеш и загрузка</h3>

          <div class="setting-row mb-6">
            <div>
              <div class="setting-title">Офлайн-режим (автокеширование)</div>
              <div class="setting-hint">Сохранять прослушанные треки на диск, чтобы они играли без интернета.</div>
            </div>
            <button
              aria-label="Офлайн-режим"
              role="switch"
              aria-checked={$settings.autoCache}
              class="switch"
              on:click={toggleAutoCache}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Готовить следующий трек заранее</div>
              <div class="setting-hint">
                За несколько секунд до конца берём ссылку на следующий трек — переход получается
                без паузы на запрос. С микшированием запас больше: загрузка обязана успеть до
                начала перехода. При включённом кеше он же начинает докачиваться.
              </div>
            </div>
            <button
              aria-label="Готовить следующий трек заранее"
              role="switch"
              aria-checked={$settings.preloadNext !== false}
              class="switch"
              on:click={() => $settings.preloadNext = $settings.preloadNext === false}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <!-- Ползунок показывается только при включённой подготовке: микшировать нечего,
               пока следующий трек не готов заранее (разбор — у `crossfadeMs` в stores.ts).
               Показывать неработающую настройку хуже, чем не показывать никакой. -->
          {#if $settings.preloadNext !== false}
            <div class="mt-6">
              <div class="flex justify-between items-center mb-4">
                <h4 class="setting-title !text-[15px]">Микширование перехода</h4>
                <span class="text-neutral-400 tnum text-sm">
                  {$settings.crossfadeMs > 0 ? `${($settings.crossfadeMs / 1000).toFixed(1)} сек` : 'выключено'}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="12000"
                step="500"
                bind:value={$settings.crossfadeMs}
                class="settings-range"
              />
              <div class="flex justify-between mt-2 text-xs text-neutral-500">
                <span>встык</span>
                <span>6 сек</span>
                <span>12 сек</span>
              </div>
              <div class="setting-hint mt-3">
                Уходящий трек гаснет, пока следующий нарастает, — на автоматическом переходе.
                Кнопка «дальше» переключает сразу. На короткой склейке переход укорачивается сам:
                дольше четверти трека он не длится.
              </div>
            </div>
          {/if}
        </div>

        <!-- Preview Settings -->
        <div class="plate p-8">
          <h3 class="section-title mb-6">Предпросмотр при наведении</h3>
          <div class="setting-row mb-6">
            <div>
              <div class="setting-title">Включить превью</div>
              <div class="setting-hint">Автоматически воспроизводить превью трека при наведении.</div>
            </div>
            <button
              aria-label="Предпросмотр при наведении"
              role="switch"
              aria-checked={$settings.enableHoverPreview}
              class="switch"
              on:click={() => $settings.enableHoverPreview = !$settings.enableHoverPreview}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          {#if $settings.enableHoverPreview}
            <div>
              <div class="flex justify-between items-center mb-4">
                <h4 class="setting-title !text-[15px]">Задержка перед включением</h4>
                <span class="text-neutral-400 tnum text-sm">{$settings.hoverPreviewDelay} мс</span>
              </div>
              <input
                type="range"
                min="200"
                max="3000"
                step="100"
                bind:value={$settings.hoverPreviewDelay}
                class="settings-range"
              />
              <div class="flex justify-between mt-2 text-xs text-neutral-500">
                <span>200 мс</span>
                <span>1.5 сек</span>
                <span>3 сек</span>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </section>

    <!-- ── Текст песен ─────────────────────────────────────────────────────── -->
    <section class="settings-pane" data-settings-pane="lyrics">
      <div class="settings-group">
        <span class="settings-group-title">Текст песен</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">
        <!-- Каждая карточка рисуется своей гарнитурой, поэтому разницу видно до
             переключения. Все шрифты лежат в сборке и содержат кириллицу. -->
        <div class="plate p-8">
          <h3 class="section-title">Шрифт текста песен</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">
            Меняет только строки песни — меню, кнопки и заголовки приложения остаются прежними. Шрифты работают офлайн.
          </p>
          <div class="font-picker" role="radiogroup" aria-label="Шрифт текста песен">
            {#each lyricsFonts as font}
              <button
                type="button"
                role="radio"
                aria-checked={$settings.fontFamily === font.id}
                class="font-choice"
                class:is-active={$settings.fontFamily === font.id}
                style="--font-choice: {font.family}"
                on:click={() => setFont(font.id)}
              >
                <span class="font-choice-check" aria-hidden="true">
                  {#if $settings.fontFamily === font.id}<Check size={14} strokeWidth={2.5} />{/if}
                </span>
                <span class="font-choice-name">{font.name}</span>
                <span class="font-choice-sample">Музыка без лишнего</span>
                <span class="font-choice-hint">{font.hint}</span>
              </button>
            {/each}
          </div>
        </div>

        <!-- Плашка «Текст в полноэкранном режиме» была отдельной и содержала ровно один
             тумблер, стоя при этом далеко от настроек текста. Тумблер переехал сюда первой
             строкой: это одна и та же тема, и держать её в двух плашках было незачем. -->
        <div class="plate p-8">
          <h3 class="section-title mb-6">Отображение текста</h3>

          <div class="setting-row mb-8">
            <div>
              <div class="setting-title">Показывать сразу в полноэкранном режиме</div>
              <div class="setting-hint">Открывая полноэкранный плеер, сразу разворачивать текст, не нажимая кнопку.</div>
            </div>
            <button
              aria-label="Текст по умолчанию"
              role="switch"
              aria-checked={$settings.showLyricsByDefault}
              class="switch"
              on:click={() => $settings.showLyricsByDefault = !$settings.showLyricsByDefault}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div>
            <div class="flex justify-between items-center mb-4">
              <h4 class="setting-title !text-[15px]">Смещение текста</h4>
              <span class="text-neutral-400 tnum text-sm">{$settings.lyricsOffset > 0 ? '+' : ''}{$settings.lyricsOffset} мс</span>
            </div>
            <input
              type="range"
              min="-5000"
              max="5000"
              step="100"
              bind:value={$settings.lyricsOffset}
              class="settings-range"
            />
            <div class="flex justify-between mt-2 text-xs text-neutral-500">
              <span>-5 сек (Раньше)</span>
              <span>0 (Синхронно)</span>
              <span>+5 сек (Позже)</span>
            </div>
          </div>

          <div class="setting-row mt-8">
            <div>
              <div class="setting-title">Кэш текстов</div>
              <div class="setting-hint">Удалить уже скачанные слова песен, чтобы приложение поискало их заново.</div>
            </div>
            <button class="danger-btn" on:click={clearLyricsCache}>
              Сбросить
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Система ─────────────────────────────────────────────────────────── -->
    <section class="settings-pane" data-settings-pane="system">
      <div class="settings-group">
        <span class="settings-group-title">Система</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">

        <!-- Autostart -->
        <div class="plate p-8 settings-system-row">
          <div>
            <h3 class="section-title">Запуск вместе с системой</h3>
            <p class="setting-hint !mt-2">Автоматически открывать Lomify при включении ПК.</p>
          </div>
          <button
            aria-label="Запуск вместе с системой"
            role="switch"
            aria-checked={autostartEnabled}
            class="switch"
            on:click={toggleAutostart}
          >
            <span class="switch-knob"></span>
          </button>
        </div>

        <!-- Discord RPC Setting -->
        <div class="plate p-8 settings-system-row">
          <div>
            <h3 class="section-title">Discord Rich Presence</h3>
            <p class="setting-hint !mt-2">Показывает в профиле Discord, какой трек сейчас играет.</p>
          </div>
          <div class="flex items-center gap-4">
            {#if $settings.enableDiscordRpc !== false}
            <button
              type="button"
              class="settings-action-button"
              on:click={async () => {
                 const { invoke } = await import('@tauri-apps/api/core');
                 try {
                    await invoke('discord_disconnect');
                    await invoke('discord_connect');
                    notify('Подключение к Discord обновлено.', 'success');
                 } catch (e) {
                    notify('Discord сейчас недоступен. Lomify попробует подключиться снова автоматически.', 'error');
                 }
              }}
            >
              Перезапустить
            </button>
            {/if}
            <button
              aria-label="Discord Rich Presence"
              role="switch"
              aria-checked={$settings.enableDiscordRpc !== false}
              class="switch"
              on:click={() => $settings.enableDiscordRpc = $settings.enableDiscordRpc === false ? true : false}
            >
              <span class="switch-knob"></span>
            </button>
          </div>
        </div>

        <!-- App Data Paths -->
        <div class="plate p-8">
          <h3 class="section-title mb-4">Системные файлы</h3>
          <div class="settings-path-list">
            <div class="settings-path-row">
              <strong>Данные приложения</strong>
              <span>App Data</span>
              <code>{dataPath || 'Загрузка…'}</code>
            </div>
            <div class="settings-path-row">
              <strong>Локальные данные</strong>
              <span>Кэш и настройки</span>
              <code>{localDataPath || 'Загрузка…'}</code>
            </div>
          </div>
        </div>

        <!-- Gibberish Easter Egg Setting -->
        <div class="plate p-8 settings-system-row">
          <div>
            <h3 class="section-title">Секретный режим</h3>
            <p class="setting-hint !mt-2">Небольшая пасхалка для тех, кто добрался до самого конца настроек.</p>
          </div>
          <button
            aria-label="Секретный режим"
            role="switch"
            aria-checked={$settings.gibberishMode}
            class="switch"
            on:click={handleGibberishToggle}
          >
            <span class="switch-knob"></span>
          </button>
        </div>
      </div>
    </section>

    <!-- ── Хранилище ──────────────────────────────────────────────────────── -->
    <section class="settings-pane" data-settings-pane="data">
      <div class="settings-group">
        <span class="settings-group-title">Хранилище</span>
        <span class="settings-group-rule"></span>
      </div>

      <div class="plate settings-cache-card p-8">
        <div class="settings-cache-head">
          <span class="settings-cache-icon" aria-hidden="true"><HardDrive size={21} /></span>
          <div>
            <h3 class="section-title">Умная очистка кэша</h3>
            <p class="setting-hint !mt-1.5 !whitespace-normal">Автоматически освобождает место, не удаляя лайки, текущий трек и недавние прослушивания.</p>
          </div>
          <button
            type="button"
            aria-label="Автоматическая очистка кэша"
            role="switch"
            aria-checked={$settings.autoCacheCleanup !== false}
            class="switch"
            on:click={() => $settings.autoCacheCleanup = $settings.autoCacheCleanup === false}
          >
            <span class="switch-knob"></span>
          </button>
        </div>

        <div class="settings-cache-usage" aria-busy={cacheStatsLoading}>
          <div>
            <span>Всего</span>
            <strong>{cacheStatsLoading ? '…' : formatBytes(cacheTotalBytes)}</strong>
          </div>
          <div>
            <span>Обычные треки</span>
            <strong>{cacheStatsLoading ? '…' : formatBytes(cacheAudioBytes)}</strong>
          </div>
          <div>
            <span class="settings-cache-protected"><ShieldCheck size={13} /> В лайках</span>
            <strong>{cacheStatsLoading ? '…' : formatBytes(cacheLikedBytes)}</strong>
          </div>
          <div>
            <span>Обложки</span>
            <strong>{cacheStatsLoading ? '…' : formatBytes(cacheImageBytes)}</strong>
          </div>
        </div>

        <div class="settings-cache-rules">
          <div class="settings-cache-rule">
            <span>Считать устаревшим через</span>
            <SelectMenu
              bind:value={$settings.cacheRetentionDays}
              options={cacheRetentionOptions}
              ariaLabel="Срок хранения неиспользуемого кэша"
            />
          </div>
          <div class="settings-cache-rule">
            <span>Примерный лимит</span>
            <SelectMenu
              bind:value={$settings.cacheMaxMb}
              options={cacheLimitOptions}
              ariaLabel="Лимит обычного кэша"
            />
          </div>
        </div>

        <div class="settings-cache-footer">
          <div>
            <div class="setting-title">Что удалится</div>
            <div class="setting-hint !whitespace-normal">Старые обложки, давно не включавшиеся треки и сохранённые файлы, которых больше нет в любимых.</div>
          </div>
          <button class="settings-cache-action" type="button" disabled={cacheCleaning} on:click={cleanupCacheNow}>
            {#if cacheCleaning}<Loader2 size={16} class="animate-spin" />{:else}<Sparkles size={16} />{/if}
            {cacheCleaning ? 'Очищаю…' : 'Очистить сейчас'}
          </button>
        </div>
        <p class="settings-cache-status" aria-live="polite">{cacheCleanupMessage}</p>
      </div>
    </section>

    <!-- ── Опасная зона ────────────────────────────────────────────────────── -->
    <section class="settings-pane" data-settings-pane="data">
      <div class="settings-group">
        <span class="settings-group-title">Опасная зона</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="plate p-8 border border-red-500/20">
        <h3 class="section-title !text-red-400">Необратимые действия</h3>
        <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">Эти действия нельзя отменить. Перед удалением убедись, что выбрал нужный пункт.</p>
        <div class="flex flex-col gap-3">
          <div class="setting-row">
            <div>
              <div class="setting-title">Сбросить профиль</div>
              <div class="setting-hint">Обнулить часы прослушивания и счётчик включённых треков.</div>
            </div>
            <button class="danger-btn" on:click={resetProfileStats}>
              Сбросить
            </button>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Удалить кэш треков</div>
              <div class="setting-hint">Стереть все сохранённые аудиофайлы. Лайки и плейлисты останутся.</div>
            </div>
            <button
              class="danger-btn"
              on:click={async () => {
                const { invoke } = await import('@tauri-apps/api/core');
                try {
                  await invoke('track_clear_cache');
                  await invoke('track_clear_liked_cache');
                  window.dispatchEvent(new CustomEvent('cacheCleared'));
                  await refreshCacheStats();
                  notify('Кэш треков очищен.', 'success');
                } catch(e) {
                  notify('Не удалось очистить кэш треков. Попробуй ещё раз.', 'error');
                }
              }}
            >
              Удалить
            </button>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Удалить всё</div>
              <div class="setting-hint">Приложение станет как после установки: ни лайков, ни истории, ни настроек.</div>
            </div>
            <button class="danger-btn is-solid" on:click={resetAllData}>
              Удалить всё
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Версия, обновления и поддержка собраны в одном месте: это информация о самом
         приложении, а не системные параметры. -->
    <div class="settings-pane mb-12" data-settings-pane="data">
      <div class="plate settings-about-card p-8">
        <span class="settings-about-icon" aria-hidden="true">
          <Music size={21} />
        </span>
        <div class="settings-about-copy">
          <h3 class="section-title">О приложении</h3>
          <div class="settings-version-line">
            <div class="version-badge">
              <span class="version-badge-name">{APP_NAME}</span>
              <span class="version-badge-sep"></span>
              <span class="version-badge-num">{APP_VERSION}</span>
              <span class="version-badge-tag">
                <span class="version-badge-dot"></span>
                {APP_CHANNEL}
              </span>
            </div>
            <button
              type="button"
              class="settings-app-icon-button"
              bind:this={appIconTrigger}
              aria-label="Открыть иконку приложения"
              aria-haspopup="dialog"
              aria-expanded={appIconOpen}
              title="Открыть иконку"
              on:click={() => setAppIconOpen(true)}
            >
              <img src="/app-icon-full.png?v=1" alt="" aria-hidden="true" />
            </button>
          </div>
          <a href="https://t.me/dopaminegdev" target="_blank" class="settings-about-author">
            Автор — @dopaminegdev
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
        <div class="settings-about-actions">
          <button
            type="button"
            class="settings-about-action is-update"
            aria-label="Проверить обновления в GitHub Releases"
            on:click={openReleases}
          >
            <span class="settings-about-action-icon" aria-hidden="true">
              <RefreshCw size={19} />
            </span>
            <span class="settings-about-action-copy">
              <strong>Проверить обновления</strong>
              <span>GitHub Releases</span>
            </span>
            <ExternalLink size={15} class="settings-about-action-arrow" aria-hidden="true" />
          </button>

          <button
            type="button"
            class="settings-about-action is-support"
            bind:this={supportTrigger}
            aria-label="Поддержать LomifyNEXT"
            aria-haspopup="dialog"
            aria-expanded={supportOpen}
            on:click={() => setSupportOpen(true)}
          >
            <span class="settings-about-action-icon" aria-hidden="true">
              <Heart size={19} />
            </span>
            <span class="settings-about-action-copy">
              <strong>Поддержать проект</strong>
              <span>ЮMoney · 2 способа</span>
            </span>
            <ExternalLink size={15} class="settings-about-action-arrow" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </div>
</div>

{#if appIconOpen}
  <div
    class="settings-app-icon-lightbox"
    use:portalToBody
    bind:this={appIconDialog}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Иконка приложения {APP_NAME}"
    on:pointerdown|self={() => setAppIconOpen(false)}
    on:keydown={onAppIconKeydown}
  >
    <button
      type="button"
      class="settings-app-icon-lightbox-close"
      aria-label="Закрыть"
      on:click={() => setAppIconOpen(false)}
    >
      <X size={28} aria-hidden="true" />
    </button>
    <img
      src="/app-icon-full.png?v=1"
      alt="Иконка приложения {APP_NAME}"
      class="settings-app-icon-lightbox-image"
    />
  </div>
{/if}

{#if supportOpen}
  <!-- pointerdown уже завершён к моменту появления слоя, поэтому исходное нажатие по
       кнопке не закрывает только что открытое окно; следующие нажатия по фону закрывают. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="support-dialog-backdrop"
    use:portalToBody
    role="presentation"
    on:pointerdown|self={() => setSupportOpen(false)}
  >
    <div
      class="support-dialog"
      bind:this={supportDialog}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="support-dialog-title"
      aria-describedby="support-dialog-description"
      on:keydown={onSupportKeydown}
    >
      <header class="support-dialog-head">
        <div class="support-dialog-brand" aria-hidden="true">
          <Heart size={21} strokeWidth={2.2} />
        </div>
        <div class="support-dialog-copy">
          <h2 id="support-dialog-title">Поддержать LomifyNEXT</h2>
          <p id="support-dialog-description">Выберите удобный способ — платёж пройдёт на стороне ЮMoney.</p>
        </div>
        <button
          type="button"
          class="support-dialog-close"
          aria-label="Закрыть окно поддержки"
          on:click={() => setSupportOpen(false)}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div class="support-methods">
        <button
          type="button"
          class="support-method is-quick"
          on:click={() => chooseSupport(YOOMONEY_BUTTON_URL)}
        >
          <span class="support-method-icon" aria-hidden="true">
            <HandCoins size={21} />
          </span>
          <span class="support-method-copy">
            <strong>Быстрый платёж</strong>
            <span>Готовая сумма — останется выбрать способ оплаты</span>
          </span>
          <span class="support-method-price">150 ₽</span>
          <ExternalLink size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          class="support-method"
          on:click={() => chooseSupport(YOOMONEY_WALLET_URL)}
        >
          <span class="support-method-icon is-wallet" aria-hidden="true">
            <WalletCards size={21} />
          </span>
          <span class="support-method-copy">
            <strong>Перевод на кошелёк</strong>
            <span>Сумму можно указать самостоятельно</span>
          </span>
          <ExternalLink size={16} aria-hidden="true" />
        </button>
      </div>

      <p class="support-dialog-footnote">Поддержка добровольная и не открывает платные функции приложения.</p>
    </div>
  </div>
{/if}
