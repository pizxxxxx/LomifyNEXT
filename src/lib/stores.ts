import { writable } from 'svelte/store';

// Global app state
export const currentTrack = writable<{
  title: string;
  artist: string;
  coverUrl: string;
  audioUrl: string;
  source: 'soundcloud' | 'youtube' | 'Локальный' | string;
  id?: string;
  isLocal?: boolean;
  duration?: number;
  permalinkUrl?: string;
  /** Яндекс сообщил, что у трека есть синхронный или обычный текст. */
  lyricsAvailable?: boolean;
  /**
   * Раздельный список авторов, когда источник его знает. Яндекс отдаёт авторов массивом
   * (`mapYandexTrack`), и это факт, а не догадка: `artist` там — та же строка, склеенная
   * через запятую. `splitArtists` в `$lib/utils/artists` предпочитает это поле разбору
   * строки, потому что ложное разбиение даёт живую с виду ссылку в никуда.
   */
  artists?: string[];
  // Трек приехал из «Моей волны», и это идентификатор той порции, в которой он приехал:
  // отметки о треке станция принимает только вместе с ним (см. lib/wave.ts). По отсутствию
  // поля плеер и понимает, что человек включил что-то своё, и волну надо остановить.
  waveBatchId?: string;
} | null>(null);

export const isPlaying = writable(false);
export const progress = writable(0);
export const duration = writable(0);
export const globalVolume = writable(0.3);

// Global settings
const defaultSettings = {
  theme: 'red-dragon', // 'default' | 'cyberpunk' | 'neon-pink' | 'ocean' | 'dracula' | 'red-dragon'
  globalThemeEffect: true, // Apply theme color to app background
  accentFromCover: true, // Pull the accent colour out of the current cover art

  searchSource: 'soundcloud', // 'youtube' | 'soundcloud' | 'yandex'
  yandexToken: '', // OAuth token for Yandex Music
  // Кто привязан. Лежит рядом с токеном, чтобы настройки показывали аккаунт сразу, не
  // дёргая /account/status при каждом открытии — сеть тут только для проверки при вводе.
  // `avatarUrl` необязателен: у аккаунтов, привязанных до его появления, поля в сохранённых
  // настройках нет, и профиль добирает его сам одним запросом (см. Profile.svelte). Пустая
  // строка — «спрашивали, аватара нет», и повторять запрос уже не нужно.
  yandexUser: null as { uid: number, login: string, displayName: string, hasPlus: boolean, avatarUrl?: string } | null,
  spotifyPlaylistUrl: '',
  lyricsAlignment: 'right', // 'left' | 'right' | 'fullscreen'
  lyricsOffset: 0, // ms offset for synced lyrics
  uiStyle: 'style1', // 'style1' | 'style2'
  // Гарнитура только для текста песен. Шрифты поставляются локально через Fontsource и
  // содержат кириллицу; старое имя поля оставлено, чтобы не сбрасывать выбор при обновлении.
  // Неизвестное значение безопасно откатывается к Inter через `--font-lyrics`.
  fontFamily: 'inter', // 'inter' | 'manrope' | 'onest' | 'golos' | 'playfair' | 'unbounded'
  // Глобальный дизайн: 'classic' — исходное оформление, 'aurora' — контрастная
  // альтернатива (см. src/design-aurora.css). Живёт отдельно от uiStyle, который
  // отвечает только за плотность стекла, чтобы обе настройки не перебивали друг друга.
  design: 'classic', // 'classic' | 'aurora'

  // ── Движение интерфейса ────────────────────────────────────────────────────
  // Каждый эффект выключается отдельно, а не одним «выключить анимации»: они стоят
  // разного и мешают по-разному. Наклон — единственное, что двигает геометрию, и он же
  // первый кандидат на выключение на слабой видеокарте. Блик — только краска, но он
  // ездит за курсором и кому-то мешает читать подписи. Полоса — разовый проезд на входе.
  // Отклик панели — короткий сдвиг пунктов навигации; сама колонка остаётся неподвижной.
  // Значения читаются как `!== false`, поэтому старые сохранённые настройки без этих
  // ключей ведут себя как «включено» — так же, как до появления переключателей.
  coverTilt: true, // 3D-наклон обложки под курсором
  coverGlare: true, // Блик по стеклу карточки и по обложке
  cardSheen: true, // Световая полоса, проезжающая по обложке на входе курсора
  panelPress: true, // Отклик пунктов боковой панели

  // ── Устройство вывода ──────────────────────────────────────────────────────
  // `null` — играть через системное устройство по умолчанию и следовать за ним, когда
  // система его меняет (воткнули наушники — звук ушёл в наушники). Строка — id
  // конкретного устройства из `audio_list_devices` (на Windows/macOS это cpal device id,
  // на Linux — имя pulse-sink'а); слежение за системным при этом выключается, иначе
  // монитор в device.rs увёл бы вывод обратно на дефолт.
  outputDevice: null as string | null,
  // Человекочитаемое имя выбранного устройства. Хранится рядом с id, потому что id на
  // Windows — нечитаемая строка, а показать, что именно выбрано, нужно и тогда, когда
  // устройства нет в системе (наушники отключены) и в списке его не найти.
  outputDeviceLabel: '',

  autoCache: true, // Auto-cache tracks for offline playback
  /**
   * Готовить следующий трек за три секунды до конца текущего (см. `PRELOAD_LEAD_SECS` в
   * Player.svelte). Выключатель нужен не ради экономии: подготовка тратит один запрос
   * подписи и, при включённом кеше, начинает качать трек, который человек может и
   * пропустить. На тарифе с лимитом трафика это заметно, поэтому решение остаётся за ним.
   * Читается как `!== false`, значит в старых сохранённых настройках без ключа
   * предзагрузка включена — как и у всех новых.
   */
  preloadNext: true,
  /**
   * Длительность микширования перехода между треками, мс. 0 — переход встык, как было.
   *
   * Работает только на автоматическом переходе: уходящий трек начинает гаснуть за
   * `crossfadeMs` до своего конца, входящий за то же время нарастает из тишины. Кнопка
   * «дальше» остаётся мгновенной — от неё ждут ровно того, что нажали, а не полутора секунд
   * прежнего трека вдогонку.
   *
   * Микширование само требует подготовленного следующего трека, поэтому при `preloadNext:
   * false` оно не сработает: перехода без готовых данных не бывает. Два числа связаны и
   * иначе (см. `preloadLeadSecs` в Player.svelte) — подготовка начинается раньше, чем
   * длится переход, иначе входящему треку было бы нечем начаться.
   *
   * Шесть секунд, а не две. Двух хватало, чтобы переход был технически, но не чтобы его
   * услышать: за две секунды на равной мощности уходящий трек не успевает отступить настолько,
   * чтобы это читалось как наложение, — выходит просто быстрое приглушение. Столько же по
   * умолчанию отдаёт Apple Music, на который здесь и ориентировались.
   */
  crossfadeMs: 6000,
  enableDiscordRpc: true,
  showLyricsByDefault: false,
  enableHoverPreview: true,
  hoverPreviewDelay: 1000,
  playbackRate: 1.0,
  customProfileName: '', // Кастомное имя пользователя
  profileBannerUrl: '', // Свой баннер профиля (ссылка). Пусто — берём баннер SoundCloud
  scUser: null as { id: number, username: string, avatarUrl: string, permalink: string, bannerUrl?: string } | null,
  leftAlignTracks: false, // Выравнивание треков по левому краю
  // Полосы спектра на весь экран в полноэкранном режиме. Выключаются отдельно от эффектов
  // интерфейса выше: те — оформление, а это единственное, что там рисуется каждый кадр по
  // событию `audio:fft`, шестьдесят раз в секунду поверх всего окна. Когда полноэкранный
  // режим включают, чтобы смотреть на обложку и текст, спектр только отвлекает — и он же
  // первое, что стоит убрать, если ноутбук на этом греется.
  // Читается как `!== false`, поэтому в старых сохранённых настройках без ключа спектр
  // остаётся включённым — так же, как до появления переключателя.
  fullscreenVisualizer: true,
  /** В полноэкранном режиме: true — караоке по буквам, false — синхронизация целыми строками. */
  fullscreenLyricsSync: true,
  /**
   * Стиль волны «Моя волна» на главной.
   *   'smooth' — фоновое дыхание: сглаженное скольжение, без резких скачков. Ритм остаётся
   *             виден (атаки всё ещё различимы), но гребни мягко перетекают, а не «дёргаются».
   *   'pulse'  — живой ритм: громкие удары выстреливают высоко и быстро (как было всегда).
   * По умолчанию 'smooth': волна — фон страницы, а фон не должен прыгать в глаза.
   * Читается как `=== 'pulse'`, поэтому отсутствие ключа в старых сохранённых настройках
   * даёт сглаженный стиль — новый и более спокойный вид по умолчанию.
   */
  waveStyle: 'smooth', // 'smooth' | 'pulse'
  /** Что допускается в «Мою волну». Фильтры применяются только к станции Яндекс Музыки. */
  waveContent: 'all', // 'all' | 'lyrics'
  /** Пустая строка — любой жанр; остальные значения описаны в lib/waveFilters.ts. */
  waveGenre: '',
  /**
   * Режим производительности: снимает всё, что стоит кадров, а не только размытие панелей.
   * Живое `backdrop-filter` везде, крупные декоративные размытия (атмосферная подложка,
   * заливка шапки профиля), блик под курсором, наклон обложки, световая полоса и объём
   * нажатия — разбор средств у блока `body[data-perf="light"]` в конце app.css.
   *
   * Четыре тумблера эффектов движения (`coverTilt`, `coverGlare`, `cardSheen`, `panelPress`)
   * при этом НЕ перезаписываются: режим гасит эффекты поверх них (`data-fx-*` в
   * +layout.svelte), поэтому выбор человека возвращается, когда режим выключают. Иначе один
   * тумблер молча стирал бы четыре других.
   *
   * По умолчанию выключен: красота — приоритет, и включают его по необходимости, а не «на
   * всякий случай».
   */
  perfMode: false,
  /**
   * Раскладка полноэкранного режима.
   *   'panel'     — обложка слева, текст в стеклянной панели справа (как было всегда);
   *   'immersive' — при включённом тексте обложка вместе с названием уезжает вверх за край
   *                 экрана, а текст выезжает снизу без панели, крупным кеглем во всю ширину.
   * По умолчанию 'panel': у того, кто обновился, экран не должен смениться сам собой.
   * Читается как `=== 'immersive'`, поэтому отсутствие ключа и любое неизвестное значение
   * дают привычную раскладку, а не пустой экран.
   */
  fullscreenStyle: 'panel', // 'panel' | 'immersive'
  gibberishMode: false, // Easter egg
};

export const settings = writable(defaultSettings);

// Stats state
const defaultStats = {
  listenSeconds: 0,
  tracksPlayed: 0,
  history: {} as Record<string, { count: number, title: string, artist: string, coverUrl: string }>
};
export const listenStats = writable(defaultStats);

// Navigation state
export const currentView = writable<'home' | 'search' | 'library' | 'settings' | 'lyrics' | 'equalizer' | 'fullscreen' | 'profile' | 'artist'>('home');
export const previousView = writable<'home' | 'search' | 'library' | 'settings' | 'lyrics' | 'equalizer' | 'fullscreen' | 'profile' | 'artist'>('home');
export const activeEqualizerPreset = writable<string>('flat');

/**
 * Есть ли текст у играющего трека. Нужно ДО того, как текст открыли: кнопка «Показать текст»
 * раньше обещала одно и то же всегда, и на треке без текста человек открывал пустую панель,
 * закрывал, открывал ещё раз — проверить, не показалось ли. Ответ на этот вопрос уже есть:
 * плеер и так запрашивает текст в фоне при загрузке трека, только выбрасывал результат.
 *
 * `unknown` — ещё не спрашивали (например, сразу после запуска для трека, который поставили
 * из прошлой сессии): в этом состоянии кнопка ведёт себя как раньше и ничего не обещает.
 */
export type LyricsStatus = 'unknown' | 'loading' | 'found' | 'none';
export const lyricsStatus = writable<LyricsStatus>('unknown');

export interface NavState {
  view: string;
  artist: string;
  search: string;
}

export const navHistory = writable<NavState[]>([]);
export const navFuture = writable<NavState[]>([]);
export const isHistoryNavigation = writable(false);

/**
 * Атмосферная подложка страницы: сильно размытая картинка во всю ширину окна под всем
 * содержимым (класс `.page-atmos` в app.css, рисуется в слое фона в routes/+page.svelte).
 *
 * Почему через стор, а не внутри самой страницы. Страницы рисуются внутри `<main>`, у
 * которого `overflow-x: hidden`, а боковая панель стоит в потоке слева. Значит всё
 * нарисованное внутри `<main>` обрезается ровно по стыку с панелью — причём панель матовая
 * и показывает сквозь себя фон БЕЗ подложки, так что на стыке видна вертикальная граница
 * между двумя разными фонами. Ширина затухания её не убирает: сколько бы её ни было,
 * слева от кромки подложки нет вообще, а справа она есть. Слой фона лежит выше по дереву и
 * тянется под панель, поэтому у подложки там просто нет кромки — картинка уходит под
 * панель, и панель её размывает.
 *
 * `derived` — источник не шапка, а обложка (квадрат вроде 500×500): такую надо размыть
 * сильнее и притушить, иначе видно и пиксели, и границы кадра.
 */
export interface PageAtmosphere {
  url: string;
  derived?: boolean;
}
export const pageAtmosphere = writable<PageAtmosphere | null>(null);

// Playlists store
const storedPlaylists = typeof window !== 'undefined' ? localStorage.getItem('lomifynext_playlists') : null;
export const playlists = writable<any[]>(storedPlaylists ? JSON.parse(storedPlaylists) : []);

if (typeof window !== 'undefined') {
  playlists.subscribe(value => {
    localStorage.setItem('lomifynext_playlists', JSON.stringify(value));
  });
}

// Notifications
export const notifications = writable<{id: number, message: string, type: 'success'|'info'|'error'}[]>([]);
export function notify(message: string, type: 'success'|'info'|'error' = 'info') {
  const id = Date.now() + Math.random();
  notifications.update(n => [...n, { id, message, type }]);
  setTimeout(() => {
    notifications.update(n => n.filter(x => x.id !== id));
  }, 3000);
}
export const currentArtist = writable<string>('');
export const searchQuery = writable('');
export const searchResults = writable<any[]>([]);
export const searchPlaylists = writable<any[]>([]);
export const searchHistory = writable<string[]>([]);

// Playback queue
export const queue = writable<any[]>([]);
export const trackHistory = writable<any[]>([]);
export const likedTracks = writable<any[]>([]);

/**
 * Снимает с сохранённых лайков флаг `isBanned`.
 *
 * Флаг попал в localStorage не из ответа источника, а из догадки плеера: раньше при любой
 * неудаче с получением ссылки на поток трек помечался как заблокированный — и в базе, и
 * здесь. Пометка переживала перезапуск, а обработчик клика в «Любимом» на неё смотрел, так
 * что строка навсегда перестала запускаться и вообще как-либо отвечать. Догадку плеер
 * больше не делает (см. Player.svelte), но у людей на диске уже лежат списки, испорченные
 * прежней версией — их надо расчистить, иначе исправление до них просто не доедет.
 *
 * Терять при этом нечего: настоящую недоступность отдаёт сам источник при загрузке
 * (`available === false` в yandex.ts, `policy === 'BLOCK'` в api.ts), и после следующего
 * обновления списка флаг вернётся сам — уже как факт, а не как предположение.
 */
function sanitizeStoredLikes(raw: unknown): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(track => {
    if (track && typeof track === 'object' && (track as any).isBanned) {
      return { ...(track as any), isBanned: false };
    }
    return track;
  });
}

export function initStore() {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('lomifynext_settings');
    if (stored) {
      try {
        settings.set({ ...defaultSettings, ...JSON.parse(stored) });
      } catch (e) {
        console.error("Failed to parse settings", e);
      }
    }
    settings.subscribe(val => {
      localStorage.setItem('lomifynext_settings', JSON.stringify(val));
    });

    const storedStats = localStorage.getItem('lomifynext_stats');
    if (storedStats) {
      try {
        listenStats.set({ ...defaultStats, ...JSON.parse(storedStats) });
      } catch (e) {
        console.error("Failed to parse stats", e);
      }
    }
    listenStats.subscribe(val => {
      localStorage.setItem('lomifynext_stats', JSON.stringify(val));
    });

    const storedLikes = localStorage.getItem('lomifynext_likes');
    if (storedLikes) {
      try {
        likedTracks.set(sanitizeStoredLikes(JSON.parse(storedLikes)));
      } catch (e) {
        console.error("Failed to parse liked tracks", e);
      }
    }
    likedTracks.subscribe(val => {
      localStorage.setItem('lomifynext_likes', JSON.stringify(val));
    });

    const storedSearch = localStorage.getItem('lomifynext_search_history');
    if (storedSearch) {
      try {
        searchHistory.set(JSON.parse(storedSearch));
      } catch (e) {
        console.error("Failed to parse search history", e);
      }
    }
    searchHistory.subscribe(val => {
      localStorage.setItem('lomifynext_search_history', JSON.stringify(val));
    });
  }
}

// Equalizer state (10 bands: 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k)
export const equalizerBands = writable([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
