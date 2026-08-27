<script lang="ts">
  /**
   * «Моя волна» на главной — радиостанция, собранная по трекам самого человека.
   *
   * Зачем отдельный блок, а не кнопка. Волна была: круглая кнопка в `HomeMasthead.svelte`.
   * Только сам `HomeMasthead` нигде не подключался — ни один файл в `src/` его не
   * импортировал, то есть кнопки на экране не было вовсе, и снаружи это выглядело как
   * «волны нет». Мёртвый компонент удалён, а вход в волну переехал туда, где его видно с
   * первого взгляда: в самый верх главной.
   *
   * Волна двух видов, и разница честная, а не косметическая:
   *   • Яндекс Музыка — настоящая станция на стороне сервиса, привязанная к аккаунту токена.
   *     Очередь бесконечная, пропуски и дослушивания уходят обратно на станцию (`lib/wave.ts`).
   *   • Остальные случаи — станция из своего: лайки, прослушанное, история поиска и плейлисты.
   *     У SoundCloud персональной станции не существует, и называть тренд «моей волной» было
   *     бы неправдой, поэтому подпись под названием прямо говорит, из чего собран поток.
   *
   * Анимация идёт от настоящего звука: бэкенд шлёт 64 полосы спектра событием `audio:fft`
   * (см. `audio/analyser.rs`, ~30 кадров в секунду; диапазон значений описан в `lib/fft.ts`).
   * Пока ничего не играет, лента дышит сама от суммы синусоид — блок не должен выглядеть
   * мёртвым до первого нажатия.
   *
   * Лента считается только когда на неё есть кому смотреть: не видно на экране или окно не на
   * переднем плане — кадры не идут вовсе, фоновые пятна замирают. Рядом запущенная игра для
   * плеера не повод молотить полотно шириной в полтора метра пикселей.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import {
    Check,
    Info,
    Loader2,
    Radio,
    RefreshCw,
    SlidersHorizontal
  } from 'lucide-svelte';
  import { MorphIcon } from 'morphicons/svelte';
  import {
    Maximize2 as Maximize2Data,
    Minimize2 as Minimize2Data,
    Pause as PauseData,
    Play as PlayData
  } from 'lucide';
  import {
    currentTrack,
    isPlaying,
    likedTracks,
    listenStats,
    notify,
    playlists,
    queue,
    searchHistory,
    settings
  } from '$lib/stores';
  import { startWave, waveActive, waveAvailable } from '$lib/wave';
  import { FFT_BINS, readFftInto } from '$lib/fft';
  import {
    describeWaveFilters,
    trackMatchesWaveGenre,
    waveGenreLabel,
    WAVE_GENRES
  } from '$lib/waveFilters';

  /** Приветствие и имя приходят с главной — там они и считаются по часам и по ОС. */
  export let greeting: string = '';
  export let username: string = '';

  /**
   * Лента главной. Станция «по своему» собирается из неё, а не новым запросом: лента уже
   * персональная (`getTrendingTracks` строит её по лайкам, прослушанному, поиску и
   * плейлистам) и уже в памяти, поэтому нажатие срабатывает мгновенно. Если ленты нет —
   * например, она не загрузилась, — станция сходит за треками сама.
   */
  export let sourceTracks: any[] = [];

  /**
   * Открыт ли раздел, в котором лента живёт (главная).
   *
   * Лента больше не пересоздаётся при переходах между разделами — иначе при каждом
   * возвращении на главную полосы начинались с нуля и до первого кадра `audio:fft` (до 350 мс)
   * дышали «холостым» дыханием. Но и считать кадры на чужом разделе незачем, поэтому главная
   * сообщает сюда, смотрят ли на ленту: при `false` она замирает так же, как при уходе окна
   * на задний план, — кадры не идут, фоновые пятна встают на паузу с сохранением фазы.
   *
   * Именно паузой, а не `display: none`: тот отменяет CSS-анимации, и при возвращении пятна
   * прыгнули бы в начальное положение — то самое «сбивается», от которого всё и затевалось.
   */
  export let onPage: boolean = true;

  let busy = false;
  let tuneOpen = false;
  let tuneTrigger: HTMLButtonElement;
  let tunePanel: HTMLElement;
  let tuneLeft = 16;
  let tuneTop = 16;
  let expanded = false;
  let overlayActive = false;
  let slotEl: HTMLElement;
  let expandTrigger: HTMLButtonElement;
  let expandAnimation: Animation | null = null;
  let expansionBusy = false;
  let expansionRevision = 0;

  /**
   * Идентификаторы треков станции «по своему». Признак «станция играет» выводится из них, а
   * не из отдельного флага: человек может включить что угодно из поиска или лайков, и флаг
   * пришлось бы гасить руками из каждого такого места. Здесь же достаточно спросить, лежит
   * ли играющий трек в станции.
   */
  let stationIds = new Set<string>();

  $: yandexWave = waveAvailable($settings);
  $: localActive = Boolean($currentTrack && stationIds.has(`${$currentTrack.id}`));
  $: active = $waveActive || localActive;
  $: sourceLabel = yandexWave ? 'Яндекс Музыка' : 'по вашей библиотеке';
  $: cover = active ? $currentTrack?.coverUrl || '' : '';
  $: waveFilterLabel = describeWaveFilters($settings);
  $: selectedGenre = waveGenreLabel($settings.waveGenre) || 'Любой жанр';
  $: activeFilterCount = ($settings.waveContent === 'lyrics' ? 1 : 0) + ($settings.waveGenre ? 1 : 0);
  $: ignoredLocalFilters = !yandexWave && $settings.waveContent === 'lyrics';
  $: if (!onPage && tuneOpen) setTuneOpen(false);
  $: if (!onPage && expanded) void setExpanded(false, true);

  function positionTunePanel() {
    if (!tuneTrigger || typeof window === 'undefined') return;
    const trigger = tuneTrigger.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const playerClearance = 118;
    const viewportBottom = window.innerHeight - playerClearance;
    const height = tunePanel?.offsetHeight || Math.min(510, viewportBottom - 12);
    tuneLeft = Math.max(12, Math.min(trigger.right - width, window.innerWidth - width - 12));
    const below = trigger.bottom + 10;
    const above = trigger.top - height - 10;
    tuneTop = below + height <= viewportBottom
      ? below
      : Math.max(12, above);
  }

  function onTuneOutsideClick(event: MouseEvent) {
    const target = event.target;
    if (target instanceof Element && target.closest('.wave-tune-trigger, .wave-tune-pop')) return;
    setTuneOpen(false);
  }

  function onTuneKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') setTuneOpen(false);
  }

  function attachTuneListeners() {
    if (typeof window === 'undefined') return;
    window.addEventListener('click', onTuneOutsideClick);
    window.addEventListener('keydown', onTuneKeydown);
    window.addEventListener('resize', positionTunePanel);
    window.addEventListener('scroll', positionTunePanel, true);
  }

  function detachTuneListeners() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('click', onTuneOutsideClick);
    window.removeEventListener('keydown', onTuneKeydown);
    window.removeEventListener('resize', positionTunePanel);
    window.removeEventListener('scroll', positionTunePanel, true);
  }

  // Выносим popover из контекста наложения главной страницы: карточки треков создают
  // собственные слои и иначе могут оказаться над ним, сколько бы z-index ни стоял внутри.
  function portalToBody(node: HTMLElement) {
    document.body.appendChild(node);
  }

  function onExpandedKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || tuneOpen) return;
    event.preventDefault();
    void setExpanded(false);
  }

  function attachExpandedListeners() {
    if (typeof window !== 'undefined') window.addEventListener('keydown', onExpandedKeydown);
  }

  function detachExpandedListeners() {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onExpandedKeydown);
  }

  function setPageScrollLocked(locked: boolean) {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('wave-overlay-open', locked);
  }

  async function playExpansion(from: DOMRect, to: DOMRect, opening: boolean, revision: number) {
    if (!hostEl || reduceMotion || typeof hostEl.animate !== 'function') return;
    // При открытии элемент уже лежит в большой геометрии и визуально стартует из карточки.
    // При закрытии всё наоборот: layout пока большой, а transform должен привести его к слоту.
    const x = opening ? from.left - to.left : to.left - from.left;
    const y = opening ? from.top - to.top : to.top - from.top;
    const sx = opening
      ? Math.max(0.08, from.width / Math.max(1, to.width))
      : Math.max(0.08, to.width / Math.max(1, from.width));
    const sy = opening
      ? Math.max(0.08, from.height / Math.max(1, to.height))
      : Math.max(0.08, to.height / Math.max(1, from.height));
    const transformed = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
    const frames = opening
      ? [
          { transform: transformed },
          { transform: 'translate3d(0, 0, 0) scale(1)' }
        ]
      : [
          { transform: 'translate3d(0, 0, 0) scale(1)' },
          { transform: transformed }
        ];

    expandAnimation = hostEl.animate(frames, {
      duration: opening ? 240 : 200,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      fill: 'both'
    });
    await expandAnimation.finished.catch(() => undefined);
    if (revision === expansionRevision) {
      expandAnimation.cancel();
      expandAnimation = null;
    }
  }

  async function setExpanded(next: boolean, instant = false) {
    if (expanded === next || (expansionBusy && !instant)) return;
    const revision = ++expansionRevision;
    expansionBusy = true;
    expandAnimation?.cancel();
    expandAnimation = null;

    if (tuneOpen) await setTuneOpen(false);

    if (next) {
      const from = hostEl?.getBoundingClientRect();
      overlayActive = true;
      setPageScrollLocked(true);
      expanded = true;
      attachExpandedListeners();
      await tick();
      resize();
      const to = hostEl?.getBoundingClientRect();
      if (!instant && from && to) await playExpansion(from, to, true, revision);
    } else {
      const from = hostEl?.getBoundingClientRect();
      const to = slotEl?.getBoundingClientRect();
      if (!instant && from && to) await playExpansion(from, to, false, revision);
      if (revision !== expansionRevision) return;
      expanded = false;
      overlayActive = false;
      setPageScrollLocked(false);
      detachExpandedListeners();
      await tick();
      resize();
    }

    if (revision === expansionRevision) {
      expansionBusy = false;
      expandTrigger?.focus();
    }
  }

  async function setTuneOpen(next: boolean) {
    if (tuneOpen === next) return;
    tuneOpen = next;
    if (!next) {
      detachTuneListeners();
      tuneTrigger?.focus();
      return;
    }
    await tick();
    positionTunePanel();
    tunePanel?.focus();
    // Подключаем закрытие снаружи после завершения исходного клика. Иначе тот же клик,
    // который открыл меню в fixed-карточке, мог тут же дойти до window и закрыть его.
    attachTuneListeners();
  }

  function onTuneTriggerPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    void setTuneOpen(!tuneOpen);
  }

  // Клавиатурная активация кнопки не создаёт pointerdown, но создаёт click с detail = 0.
  function onTuneTriggerClick(event: MouseEvent) {
    if (event.detail === 0) void setTuneOpen(!tuneOpen);
  }

  function setWaveContent(value: 'all' | 'lyrics') {
    settings.update((state) => ({ ...state, waveContent: value }));
  }

  function setWaveGenre(value: string) {
    settings.update((state) => ({ ...state, waveGenre: value }));
  }

  function clearWaveFilters() {
    settings.update((state) => ({ ...state, waveContent: 'all', waveGenre: '' }));
  }

  async function applyWaveFilters() {
    if (active) await collect();
    setTuneOpen(false);
  }

  function tunePop(node: HTMLElement, params: { duration?: number } = {}) {
    const duration = params.duration ?? 220;
    return {
      duration,
      easing: cubicOut,
      css: (t: number) => `opacity: ${t}; transform: translateY(${(1 - t) * -6}px) scale(${0.96 + 0.04 * t});`
    };
  }

  /** Только треки: `mixPlaylists` подмешивает в ленту плейлисты, у них вместо звука список. */
  function onlyTracks(list: any[]): any[] {
    return (list || []).filter((t) => t && !Array.isArray(t.tracks) && t.title);
  }

  async function startLocalStation(): Promise<boolean> {
    let pool = onlyTracks(sourceTracks);

    if (pool.length === 0) {
      try {
        const api = await import('$lib/api');
        pool = onlyTracks(
          await api.getTrendingTracks($likedTracks, $listenStats, $searchHistory, $playlists)
        );
      } catch (e) {
        console.error('[волна] станция по своему не собралась', e);
      }
    }

    // SoundCloud сообщает жанр, поэтому этот фильтр работает и у локальной волны. Наличие
    // текста он надёжно не сообщает — это условие остаётся только для станции Яндекса.
    pool = pool.filter((track) => trackMatchesWaveGenre(track, $settings));
    const unique = new Map<string, any>();
    for (const track of pool) {
      const key = track?.id
        ? `${track.source ?? 'track'}:${track.id}`
        : `${track?.title ?? ''}:${track?.artist ?? ''}`.toLocaleLowerCase('ru-RU');
      if (key && !unique.has(key)) unique.set(key, track);
    }
    pool = [...unique.values()];

    // Пустой список здесь — не «нет музыки», а проглоченный отказ внутри api:
    // `getTrendingTracks` гасит сетевые ошибки через `Promise.allSettled` и на мёртвой сети
    // возвращает пустой массив, а не ошибку.
    if (pool.length === 0) {
      const filter = describeWaveFilters($settings);
      notify(
        filter
          ? `Для волны не нашлось треков по условию «${filter}»`
          : 'Волна не собралась: не из чего. Проверь соединение или послушай что-нибудь',
        'error'
      );
      return false;
    }

    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    stationIds = new Set(shuffled.map((t) => `${t.id}`));
    // Очередь ставим раньше трека: реакция плеера на `currentTrack` синхронная, и к моменту,
    // когда он возьмётся за первый трек, остальное уже должно лежать на месте.
    queue.set(shuffled.slice(1));
    currentTrack.set(shuffled[0]);
    isPlaying.set(true);
    return true;
  }

  /** Собрать волну заново. У Яндекса это новая порция с учётом пропусков, у своего — новый порядок. */
  async function collect() {
    if (busy) return;
    busy = true;
    try {
      if (yandexWave) {
        // У волны Яндекса свои уведомления об отказе: она знает, что именно не сложилось —
        // токен, сеть или пустая станция, — и общий текст был бы там неправдой.
        stationIds = new Set();
        await startWave();
      } else {
        await startLocalStation();
      }
    } catch (e) {
      console.error('[волна] не собралась', e);
      notify('Не получилось собрать волну. Проверь соединение', 'error');
    } finally {
      busy = false;
    }
  }

  /** Главная кнопка: волна не играет — включить, играет — пауза и обратно. */
  function primary() {
    if (busy) return;
    if (active) {
      isPlaying.set(!$isPlaying);
      return;
    }
    collect();
  }

  // ── Лента спектра ──────────────────────────────────────────────────────────────────
  const BINS = FFT_BINS;

  /**
   * Три ленты друг сквозь друга. Разные частоты и разные скорости — в том числе одна против
   * хода: у совпадающих скоростей ленты слипаются в одну толстую линию.
   *
   * `halo` — во сколько раз шире основной линии идёт подсветка. Раньше здесь был `shadowBlur`
   * из canvas, и он один стоил больше, чем вся остальная отрисовка: тень размывается по всей
   * длине пути на процессоре, каждый кадр. Второй проход по уже построенному пути широкой
   * почти прозрачной линией даёт то же мягкое свечение и обходится как обычная обводка.
   */
  const RIBBONS = [
    { freq: 3.1, speed: 0.55, amp: 1.0, width: 2.6, alpha: 0.9, halo: 5 },
    { freq: 4.7, speed: -0.38, amp: 0.72, width: 1.7, alpha: 0.5, halo: 0 },
    { freq: 6.3, speed: 0.82, amp: 0.5, width: 1.2, alpha: 0.3, halo: 0 }
  ];

  /**
   * Частота кадров. Спектр приходит раз в 33 мс (`FFT_INTERVAL_MS` в analyser.rs), поэтому
   * при 60 кадрах в секунду два кадра из трёх рисуют ровно то же самое. В простое движение
   * синтетическое и медленное — там и 20 кадров не отличить от 30 на глаз, зато работы вдвое
   * меньше. Всё это заметно ровно тогда, когда важно: пока рядом идёт игра.
   */
  const FRAME_MS_LIVE = 32;
  const FRAME_MS_IDLE = 48;

  /**
   * Сколько отрезков в ломаной. Раньше шаг был 3 пикселя по ширине, то есть на широком окне
   * почти полторы тысячи отрезков за кадр на одни ленты. Форма здесь низкочастотная — синус с
   * периодом в треть ширины, — и от вдвое более редкой ломаной она не отличается.
   */
  const FILL_STEPS = 72;
  const RIBBON_STEPS = 108;

  let canvas: HTMLCanvasElement | null = null;
  let hostEl: HTMLElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let raf = 0;
  let unlistenFft: (() => void) | null = null;
  let observer: ResizeObserver | null = null;
  let inView: IntersectionObserver | null = null;
  let reduceMotion = false;
  let onScreen = true;

  /**
   * Окно на переднем плане. Пока человек в игре, окно плеера остаётся «видимым» с точки
   * зрения браузера — чужое полноэкранное окно поверх для него не событие, — и кадры
   * продолжают идти на полной частоте, отбирая у игры и процессор, и GPU. Здесь лента
   * замирает целиком: и полотно, и переливающиеся пятна в фоне (класс `is-idle`).
   */
  let awake = true;

  const level = new Float32Array(BINS);
  const target = new Float32Array(BINS);
  /**
   * Сглаженный стиль (`waveStyle` в stores.ts) — две ступени, и каждая лечит свою причину
   * угловатости. Цифры ниже мерены на НАРИСОВАННОЙ кривой (72 точки по ширине, 30 кадров/с),
   * а не на сырых полосах: важно то, что видит глаз, а не то, что лежит в буфере.
   *
   * По ВРЕМЕНИ: каскад из двух задержек по 0.30 поверх `level`. Именно каскад, а не одно
   * звено: у одиночного фильтра атака начинается с угла (скорость прыгает с нуля), и глаз
   * читает ровно этот угол. Две ступени дают S-образный подъём — излом между кадрами падает
   * в 11 раз (0.080 → 0.007), скачок в 8.6 (0.074 → 0.009). Ритм при этом остаётся виден:
   * удар вырастает за 7 кадров (~230 мс) — это набегающая волна, а не щелчок. Симметрично, а
   * не «атака быстрая, спад долгий»: с долгим спадом уровень не успевает вернуться между
   * ударами и встаёт плоским плато, то есть ритм пропадает совсем. Плавность не должна быть
   * ценой правдивости.
   *
   * По ШИРИНЕ: `soft` — каждая полоса вместе с соседями (0.25/0.5/0.25). Одиночный выброс в
   * спектре обычно не музыка, а утечка FFT в соседний бин, и по ширине он давал шип: полос 64,
   * а низы растянуты на три четверти ленты (`Math.pow(u, 1.5)`), так что на одну полосу
   * приходится по 4–5 точек кривой, и на её границе кривая ломалась. Усреднение снимает
   * излом по ширине в 3 раза (0.109 → 0.037). Кубическую интерполяцию поверх пробовал —
   * не даёт ничего (0.056 против 0.054 на сырых полосах), поэтому её здесь нет: она ещё и
   * перестреливает на тех самых выбросах утечки, которые усреднение только что убрало.
   *
   * Цепочка считается всегда, независимо от выбранного стиля: 128 операций на кадр не стоят
   * разговора, зато переключение стиля на ходу происходит без прыжка — иначе плавная волна
   * начинала бы расти с нуля, из остывших буферов.
   */
  const glow = new Float32Array(BINS);
  const glow2 = new Float32Array(BINS);
  const soft = new Float32Array(BINS);
  let lastFftAt = 0;
  let lastDrawAt = 0;
  let accent: [number, number, number] = [29, 185, 84];
  let accentReadAt = 0;
  let cssWidth = 0;
  let cssHeight = 0;

  /**
   * Градиенты живут между кадрами. `createLinearGradient` с тремя остановками — это четыре
   * новых объекта на кадр, то есть 240 объектов в секунду на мусор; при этом зависят они
   * только от ширины полотна и цвета темы. Яркость от громкости добавляет `globalAlpha`
   * поверх готового градиента, а не новые остановки.
   */
  let fillGrad: CanvasGradient | null = null;
  let ribbonGrads: CanvasGradient[] = [];
  let gradKey = '';

  /**
   * Цвет темы. `--color-primary` объявлен через `@property` с типом `<color>` (app.css), то
   * есть вычисленное значение — настоящий цвет вида `rgb(29 185 84)`, а не текст `var(...)`.
   * Разбираем оба привычных вида записи; на всё незнакомое остаётся прежний цвет, и лента
   * просто не меняет оттенок.
   */
  function parseColor(raw: string): [number, number, number] | null {
    const s = raw.trim();
    if (!s) return null;

    if (s.startsWith('#')) {
      const hex = s.slice(1);
      if (hex.length === 3) {
        return [
          parseInt(hex[0] + hex[0], 16),
          parseInt(hex[1] + hex[1], 16),
          parseInt(hex[2] + hex[2], 16)
        ];
      }
      if (hex.length >= 6) {
        return [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16)
        ];
      }
      return null;
    }

    const nums = s.match(/[\d.]+/g);
    if (s.startsWith('rgb') && nums && nums.length >= 3) {
      return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
    }
    return null;
  }

  function readAccent() {
    if (typeof window === 'undefined') return;
    // Читаем с самого блока, а не с `documentElement`. Темы объявляют `--color-primary` на
    // `body[data-global-theme]` — у `html` остаётся базовое зелёное значение, и лента рисовалась
    // зелёной поверх оранжевой темы. У элемента внутри каскада значение всегда то, что видно
    // глазом, откуда бы оно ни пришло — от темы, от акцента обложки или от корня.
    const host = hostEl || document.body;
    const raw = getComputedStyle(host).getPropertyValue('--color-primary');
    const parsed = parseColor(raw);
    if (parsed) accent = parsed;
  }

  /**
   * До какого момента цвет ещё может двигаться.
   *
   * `getComputedStyle` — это принудительный пересчёт стилей, и звать его два раза в секунду
   * навсегда (как было) незачем: цвет меняется только по смене трека или темы. Но одного
   * чтения по событию тоже не хватает — `--color-primary` объявлен через `@property` и едет
   * по `transition` длиной 900 мс (`--duration-very-slow` в app.css), а ставит его
   * `+layout.svelte` асинхронно, уже разобрав обложку на цвета. Поэтому открываем окно на
   * время перехода, в нём читаем часто, а потом молчим.
   */
  let accentWatchUntil = 0;
  function watchAccent() {
    if (typeof performance === 'undefined') return;
    accentWatchUntil = performance.now() + 1500;
  }
  $: $currentTrack, $settings, watchAccent();

  function resize() {
    if (!canvas) return;
    // Потолок 1.5, а не 2: лента размытая и мягкая, разницы в резкости на ней не видно, а на
    // экране с двойной плотностью полотно выходило под 3000×500 — полтора миллиона пикселей,
    // которые очищаются и закрашиваются заново каждый кадр.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    cssWidth = canvas.offsetWidth;
    cssHeight = canvas.offsetHeight;
    if (cssWidth === 0 || cssHeight === 0) return;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx = canvas.getContext('2d');
    // Рисуем в CSS-пикселях: масштаб задаём один раз здесь, а не в каждой строке отрисовки.
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Полотно поменяло ширину — прежние градиенты растянуты не по нему.
    gradKey = '';
    if (reduceMotion) frame(performance.now());
  }

  /** Градиенты по ширине полотна и цвету темы. Пересобираются только когда что-то из этого изменилось. */
  function ensureGradients(w: number) {
    const [r, g, b] = accent;
    const key = `${Math.round(w)}|${r},${g},${b}`;
    if (key === gradKey && fillGrad && ribbonGrads.length === RIBBONS.length) return;
    if (!ctx) return;
    gradKey = key;

    // Остановки задают максимальную яркость; до текущей громкости их приглушает `globalAlpha`.
    fillGrad = ctx.createLinearGradient(0, 0, w, 0);
    fillGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
    fillGrad.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, 0.27)`);
    fillGrad.addColorStop(1, `rgba(255, 255, 255, 0.1)`);

    ribbonGrads = RIBBONS.map((ribbon) => {
      const grad = ctx!.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
      grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${ribbon.alpha})`);
      grad.addColorStop(1, `rgba(255, 255, 255, ${ribbon.alpha * 0.45})`);
      return grad;
    });
  }

  /**
   * Живой или сглаженный стиль (настройка `waveStyle` в stores.ts). `!== 'pulse'` — чтобы
   * отсутствие ключа в старых сохранённых настройках тоже давало сглаженный стиль.
   */
  $: smoothWave = $settings.waveStyle !== 'pulse';

  /**
   * Значение полосы в произвольной точке ленты, с наклоном в сторону низов.
   *
   * Показатель больше единицы — и это важно. С прежним `0.72` наклон получался ровно
   * обратный: под полосы выше 2 кГц уходило больше половины ширины, а там у музыки почти
   * всегда тишина, так что правая половина ленты стояла плоской. При `1.5` три четверти
   * ширины занимает всё, что ниже 2.4 кГц, — то есть то, что в музыке и слышно.
   */
  function ampAt(u: number): number {
    const x = Math.pow(u, 1.5) * (BINS - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = level[i] || 0;
    const b = level[Math.min(BINS - 1, i + 1)] || a;
    return a + (b - a) * f;
  }

  /** Сглаженное значение полосы. Обе ступени уже посчитаны в `frame` — здесь только выборка. */
  function ampSmoothed(u: number): number {
    const x = Math.pow(u, 1.5) * (BINS - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = soft[i] || 0;
    const b = soft[Math.min(BINS - 1, i + 1)] || a;
    return a + (b - a) * f;
  }

  function frame(now: number) {
    // Заявку на следующий кадр отдаём сразу: дальше идут выходы по «нечего рисовать» и по
    // ограничителю частоты, и после каждого из них цикл обязан продолжиться.
    if (!reduceMotion) raf = requestAnimationFrame(frame);

    if (!ctx || cssWidth === 0 || cssHeight === 0) return;

    // Спектра нет дольше трети секунды — значит пауза, тишина или волна ещё не включена.
    const live = now - lastFftAt < 350;

    // Минус 4 мс: кадры приходят не ровно по расписанию, и строгое сравнение выбрасывало бы
    // каждый второй кадр, опоздавший на миллисекунду, — вместо 30 в секунду выходило бы 20.
    const budget = live ? FRAME_MS_LIVE : FRAME_MS_IDLE;
    if (!reduceMotion && now - lastDrawAt < budget - 4) return;
    lastDrawAt = now;

    if (now < accentWatchUntil && now - accentReadAt > 180) {
      accentReadAt = now;
      readAccent();
    }

    const secs = now / 1000;

    // В простое лента дышит от суммы синусоид: блок обязан выглядеть живым и до первого нажатия.
    if (!live) {
      for (let i = 0; i < BINS; i++) {
        const u = i / (BINS - 1);
        const v =
          0.2 + 0.12 * Math.sin(secs * 0.8 + u * 5.2) + 0.07 * Math.sin(secs * 1.9 - u * 8.1);
        target[i] = Math.max(0.04, v);
      }
    }

    // Вверх быстро, вниз медленно: удар должен выстреливать, а спад — оседать. Одинаковая
    // скорость в обе стороны даёт дрожание, в котором не читается ни ритм, ни мелодия.
    let sum = 0;
    for (let i = 0; i < BINS; i++) {
      const k = target[i] > level[i] ? 0.34 : 0.09;
      level[i] += (target[i] - level[i]) * k;
      sum += level[i];
    }
    const energy = Math.min(1, sum / BINS);

    // Сглаженная копия уровня: две задержки по времени, затем усреднение с соседями по
    // ширине. Разбор коэффициентов — у объявления `glow`/`glow2`/`soft`.
    for (let i = 0; i < BINS; i++) {
      glow[i] += (level[i] - glow[i]) * 0.3;
      glow2[i] += (glow[i] - glow2[i]) * 0.3;
    }
    for (let i = 0; i < BINS; i++) {
      const prev = glow2[i > 0 ? i - 1 : 0];
      const next = glow2[i < BINS - 1 ? i + 1 : BINS - 1];
      soft[i] = prev * 0.25 + glow2[i] * 0.5 + next * 0.25;
    }

    const w = cssWidth;
    const h = cssHeight;
    const cy = h * 0.5;
    const maxAmp = h * (expanded ? 0.35 : 0.32);
    const stageScale = expanded ? 1.28 : 1;

    ensureGradients(w);
    ctx.clearRect(0, 0, w, h);

    const env = (u: number) => {
      // Затухание к краям: без него лента обрублена вертикальной стенкой у кромки блока.
      const edge = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, u))), 0.7);
      // Без поправочного множителя, и это проверено, а не лень. Мерил на четырёх типах
      // материала (перкуссия, тянущийся пэд, обычный трек, плотное сведение): средняя высота
      // у двух стилей и так совпадает с точностью до трёх десятых процента — плавная волна
      // не мельче ритмичной. Ниже у неё только пики, на 2% (пэд) — 16% (голая перкуссия), но
      // срезанный пик и есть тот самый резкий скачок, который тут убирается: возвращать его
      // множителем — значит отменять смысл стиля. Пробовал 1.12: догоняет пик перкуссии, но
      // ценой того, что ВСЯ волна на любом материале становится на 12% выше правды.
      if (smoothWave) return ampSmoothed(u) * maxAmp * edge;
      return ampAt(u) * maxAmp * edge;
    };

    // Заливка под лентами: зеркальная полоса, из которой ленты как бы вырастают. Ведём
    // кривую через середины отрезков (`quadraticCurveTo` к точке между предыдущей и
    // следующей) — ломаная из 72 отрезков читалась как мелкие треугольники.
    const envAt = (u: number, sign: number) => {
      const pulse = 0.55 + 0.3 * Math.sin(u * 6.1 + secs * sign);
      return env(u) * pulse;
    };
    ctx.beginPath();
    ctx.moveTo(0, cy);
    let prevX = 0;
    let prevY = cy;
    for (let s = 1; s <= FILL_STEPS; s++) {
      const u = s / FILL_STEPS;
      const x = u * w;
      const y = cy - envAt(u, 0.5);
      ctx.quadraticCurveTo(prevX, prevY, (prevX + x) / 2, (prevY + y) / 2);
      prevX = x;
      prevY = y;
    }
    prevX = w;
    prevY = cy;
    for (let s = FILL_STEPS; s >= 1; s--) {
      const u = s / FILL_STEPS;
      const x = u * w;
      const y = cy + envAt(u, -0.4);
      ctx.quadraticCurveTo(prevX, prevY, (prevX + x) / 2, (prevY + y) / 2);
      prevX = x;
      prevY = y;
    }
    ctx.closePath();
    ctx.fillStyle = fillGrad!;
    ctx.globalAlpha = 0.5 + energy * 0.5;
    ctx.fill();

    // Сами ленты. `lighter` — чтобы пересечения светились, а не перекрывали друг друга.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let n = 0; n < RIBBONS.length; n++) {
      const ribbon = RIBBONS[n];
      // Та же кривая через середины, что у заливки: гладкий волнистый штрих вместо
      // ломаной, вершины которой и читались как треугольнички.
      ctx.beginPath();
      let rx = 0;
      let ry = 0;
      for (let s = 0; s <= RIBBON_STEPS; s++) {
        const u = s / RIBBON_STEPS;
        const x = u * w;
        const y =
          cy +
          Math.sin(u * Math.PI * ribbon.freq + secs * ribbon.speed * 2.2) * env(u) * ribbon.amp;
        if (s === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.quadraticCurveTo(rx, ry, (rx + x) / 2, (ry + y) / 2);
        }
        rx = x;
        ry = y;
      }
      ctx.strokeStyle = ribbonGrads[n];

      // Путь после `stroke()` никуда не девается, поэтому подсветка — это второй проход по
      // тому же пути, без пересчёта точек.
      if (ribbon.halo > 0) {
        ctx.globalAlpha = 0.16 + energy * 0.2;
        ctx.lineWidth = ribbon.width * ribbon.halo * stageScale;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = ribbon.width * stageScale;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function startLoop() {
    if (reduceMotion || raf !== 0) return;
    if (!awake || !onScreen) return;
    // Пока цикл стоял, `performance.now()` уехал вперёд, и первый же кадр увидел бы огромную
    // «задолженность» по времени. Ограничителю частоты это безразлично, а вот отметку рисуем
    // заново, чтобы кадр после пробуждения не считался опоздавшим.
    lastDrawAt = 0;
    raf = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
  }

  /**
   * Пересчёт «стоит ли вообще считать». Два независимых условия: блок на экране (за это
   * отвечает IntersectionObserver) и окно на переднем плане.
   *
   * `document.hasFocus()`, а не только `visibilityState`: игра поверх окна — это для браузера
   * не «скрыто», он продолжает выдавать кадры на полной частоте. Именно из-за этого лента и
   * подъедала производительность игры, хотя смотреть на неё в тот момент было некому.
   */
  function syncAwake() {
    if (typeof document === 'undefined') return;
    awake = onPage && document.visibilityState !== 'hidden' && document.hasFocus();
    if (awake && onScreen) startLoop();
    else stopLoop();
  }

  /**
   * Переход на другой раздел и обратно. Через `mounted`, а не напрямую: реактивные выражения
   * в Svelte считаются и до `onMount`, а `startLoop` внутри требует уже готового полотна.
   */
  let mounted = false;
  $: if (mounted) {
    void onPage;
    syncAwake();
  }

  onMount(() => {
    reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    readAccent();
    resize();

    if (canvas) {
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
    }

    if (reduceMotion) {
      // Уважаем системную настройку: один кадр вместо непрерывного движения. Спектр тогда
      // тоже не слушаем — иначе «уменьшить анимацию» ничего бы не уменьшило.
      frame(performance.now());
      return;
    }

    // Кадры не крутятся, пока блок не на экране: уйдя вниз по главной, человек всё равно
    // платил бы за 60 кадров в секунду в невидимом углу.
    if (canvas && 'IntersectionObserver' in window) {
      inView = new IntersectionObserver(
        (entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
          if (onScreen && awake) startLoop();
          else stopLoop();
        },
        { threshold: 0.01 }
      );
      inView.observe(canvas);
    }

    document.addEventListener('visibilitychange', syncAwake);
    window.addEventListener('focus', syncAwake);
    window.addEventListener('blur', syncAwake);
    syncAwake();

    if ('__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/event')
        .then(({ listen }) =>
          listen<number[]>('audio:fft', (event) => {
            // Пока цикл спит, писать в буфер незачем: по возвращении картинка всё равно
            // догонит звук за пару кадров, а разбор события и так уже случился.
            if (!awake) return;
            // Полосы приходят как доли единицы, а не как байты. См. lib/fft.ts — раньше здесь
            // стояло деление на 255, и с началом трека лента схлопывалась в прямую линию.
            if (readFftInto(event.payload, target)) lastFftAt = performance.now();
          })
        )
        .then((un) => {
          unlistenFft = un;
        })
        .catch((e) => console.warn('[волна] спектр недоступен', e));
    }

    // В самом конце: до этой отметки реактивное выражение выше не имеет права звать
    // `startLoop` — полотна и наблюдателей ещё нет.
    mounted = true;
  });

  onDestroy(() => {
    detachTuneListeners();
    detachExpandedListeners();
    setPageScrollLocked(false);
    expandAnimation?.cancel();
    stopLoop();
    observer?.disconnect();
    inView?.disconnect();
    unlistenFft?.();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', syncAwake);
      window.removeEventListener('focus', syncAwake);
      window.removeEventListener('blur', syncAwake);
    }
  });
</script>

<div
  class="wave-hero-slot"
  class:is-expanded={expanded}
  class:is-overlay-active={overlayActive}
  bind:this={slotEl}
>
{#if overlayActive}
  <button
    type="button"
    class="wave-expand-backdrop"
    class:is-active={overlayActive}
    on:click={() => setExpanded(false)}
    aria-label="Закрыть развёрнутую волну"
    tabindex="-1"
  ></button>
{/if}
<section
  id="my-wave-hero"
  class="wave-hero"
  class:is-live={active && $isPlaying}
  class:is-idle={!awake}
  class:is-expanded={expanded}
  bind:this={hostEl}
  aria-label="Моя волна"
  aria-busy={expansionBusy}
>
  <div class="wave-hero-bg" aria-hidden="true">
    {#if cover}
      <img class="wave-hero-cover" src={cover} alt="" />
    {/if}
    <span class="wave-blob wave-blob-a"></span>
    <span class="wave-blob wave-blob-b"></span>
    <span class="wave-blob wave-blob-c"></span>
    <div class="wave-hero-veil"></div>
  </div>

  <canvas class="wave-hero-canvas" bind:this={canvas} aria-hidden="true"></canvas>

  <div class="wave-hero-body">
    <div class="wave-hero-text">
      {#if greeting}
        <div class="wave-hero-greeting">
          {greeting}{username ? `, ${username}` : ''}
        </div>
      {/if}

      <h1 class="wave-hero-title">Моя волна</h1>

      <div class="wave-hero-meta">
        <span class="wave-chip">
          <Radio size={12} aria-hidden="true" />
          {sourceLabel}
        </span>
        {#if active}
          <span class="wave-chip wave-chip-live">
            <span class="wave-dot" aria-hidden="true"></span>
            {$isPlaying ? 'Играет' : 'На паузе'}
          </span>
        {/if}
        {#if waveFilterLabel}
          <span class="wave-chip wave-chip-filter">
            <SlidersHorizontal size={12} aria-hidden="true" />
            {waveFilterLabel}
          </span>
        {/if}
      </div>

      <p class="wave-hero-hint">
        {#if active && $currentTrack}
          {$currentTrack.title} — {$currentTrack.artist}
        {:else if yandexWave}
          Бесконечная станция Яндекс Музыки: подстраивается под то, что вы слушаете и
          пропускаете.
        {:else}
          Бесконечный поток по вашим трекам — лайки, прослушанное, поиск и плейлисты.
        {/if}
      </p>

      {#if ignoredLocalFilters}
        <p class="wave-hero-note">
          <Info class="wave-note-icon" size={13} aria-hidden="true" />
          Жанр работает и здесь, а условие «только с текстом» доступно для Яндекс Музыки —
          SoundCloud не сообщает наличие слов надёжно.
        </p>
      {/if}
    </div>

    <div class="wave-hero-actions">
      <button
        type="button"
        class="wave-expand"
        bind:this={expandTrigger}
        on:click={() => setExpanded(!expanded)}
        disabled={expansionBusy}
        aria-expanded={expanded}
        aria-controls="my-wave-hero"
        aria-label={expanded ? 'Свернуть Мою волну' : 'Развернуть Мою волну'}
        title={expanded ? 'Свернуть' : 'Развернуть'}
      >
        <MorphIcon
          icon={expanded ? Minimize2Data : Maximize2Data}
          size={17}
          spring="snappy"
          reducedMotion="user"
        />
        {#if expanded}
          <span>Свернуть</span>
        {:else}
          <span>Развернуть</span>
        {/if}
      </button>

      <button
        type="button"
        class="wave-tune-trigger"
        class:is-open={tuneOpen}
        bind:this={tuneTrigger}
        on:pointerdown|stopPropagation={onTuneTriggerPointerDown}
        on:click|stopPropagation={onTuneTriggerClick}
        aria-haspopup="dialog"
        aria-expanded={tuneOpen}
        aria-label="Настроить Мою волну"
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        <span>Настроить</span>
        {#if activeFilterCount > 0}
          <span class="wave-tune-count">{activeFilterCount}</span>
        {/if}
      </button>

      <button
        type="button"
        class="wave-play"
        on:click={primary}
        disabled={busy}
        title={active ? ($isPlaying ? 'Пауза' : 'Продолжить') : 'Включить мою волну'}
      >
        {#if busy}
          <Loader2 size={28} class="animate-spin" />
        {:else}
          <MorphIcon
            icon={active && $isPlaying ? PauseData : PlayData}
            size={28}
            strokeWidth={2.25}
            fill="currentColor"
            class="play-pause-morph"
            spring="snappy"
            reducedMotion="user"
          />
        {/if}
      </button>

      {#if active}
        <!-- Собрать заново — осознанный жест, а не перезапуск того же: станция Яндекса
             отдаёт новую порцию с учётом всего, что человек успел пропустить и дослушать. -->
        <button type="button" class="wave-recollect" on:click={collect} disabled={busy} title="Собрать волну заново">
          <RefreshCw size={15} />
          Собрать заново
        </button>
      {/if}
    </div>
  </div>
</section>
</div>

{#if tuneOpen}
  <div
    bind:this={tunePanel}
    use:portalToBody
    transition:tunePop
    class="wave-tune-pop"
    style="left: {tuneLeft}px; top: {tuneTop}px"
    role="dialog"
    aria-modal="false"
    aria-labelledby="wave-tune-title"
    tabindex="-1"
  >
    <div class="wave-tune-head">
      <div class="wave-tune-heading">
        <span class="wave-tune-icon" aria-hidden="true"><SlidersHorizontal size={17} /></span>
        <div>
          <h2 id="wave-tune-title">Настроить волну</h2>
          <p>Выбор сохраняется для следующих запусков</p>
        </div>
      </div>
      {#if activeFilterCount > 0}
        <button type="button" class="wave-tune-clear" on:click={clearWaveFilters}>Сбросить</button>
      {/if}
    </div>

    <div class="wave-tune-section">
      <div class="wave-tune-label">Текст песни</div>
      <div
        class="seg-control"
        style="--seg-count: 2; --seg-index: {$settings.waveContent === 'lyrics' ? 1 : 0}"
        role="radiogroup"
        aria-label="Наличие текста в Моей волне"
      >
        <span class="seg-pill" aria-hidden="true"></span>
        <button
          type="button"
          role="radio"
          aria-checked={$settings.waveContent !== 'lyrics'}
          class="seg-item"
          class:is-active={$settings.waveContent !== 'lyrics'}
          on:click={() => setWaveContent('all')}
        >Любые</button>
        <button
          type="button"
          role="radio"
          aria-checked={$settings.waveContent === 'lyrics'}
          class="seg-item"
          class:is-active={$settings.waveContent === 'lyrics'}
          on:click={() => setWaveContent('lyrics')}
        >Только с текстом</button>
      </div>
    </div>

    <div class="wave-tune-section wave-tune-genres">
      <div class="wave-tune-section-head">
        <span class="wave-tune-label">Жанр</span>
        <span class="wave-tune-current">{selectedGenre}</span>
      </div>
      <div class="wave-genre-menu" role="radiogroup" aria-label="Жанр Моей волны">
        <button
          type="button"
          role="radio"
          aria-checked={!$settings.waveGenre}
          class="wave-genre-item"
          class:is-selected={!$settings.waveGenre}
          on:click={() => setWaveGenre('')}
        >
          <span>
            <strong>Любой жанр</strong>
            <small>Не ограничивать подборку</small>
          </span>
          {#if !$settings.waveGenre}<Check size={16} aria-hidden="true" />{/if}
        </button>
        {#each WAVE_GENRES as genre}
          <button
            type="button"
            role="radio"
            aria-checked={$settings.waveGenre === genre.id}
            class="wave-genre-item"
            class:is-selected={$settings.waveGenre === genre.id}
            on:click={() => setWaveGenre(genre.id)}
          >
            <span>
              <strong>{genre.label}</strong>
              <small>{genre.hint}</small>
            </span>
            {#if $settings.waveGenre === genre.id}<Check size={16} aria-hidden="true" />{/if}
          </button>
        {/each}
      </div>
    </div>

    <div class="wave-tune-note">
      <Info size={14} aria-hidden="true" />
      <span>
        {yandexWave
          ? 'Фильтр учитывает жанры альбомов и исполнителей и проверяет до двенадцати порций станции.'
          : 'SoundCloud фильтруется по жанру; проверка наличия текста включится с Яндекс Музыкой.'}
      </span>
    </div>

    <button type="button" class="wave-tune-apply" disabled={busy} on:click={applyWaveFilters}>
      {#if busy}
        <Loader2 size={16} class="animate-spin" />
        Собираю…
      {:else if active}
        Применить и пересобрать
      {:else}
        Готово
      {/if}
    </button>
  </div>
{/if}

<style>
  .wave-hero-slot {
    width: 100%;
  }

  /* Слот сохраняет место карточки, пока та развёрнута и временно стала fixed. */
  .wave-hero-slot.is-expanded {
    min-height: 244px;
  }

  :global(body.wave-overlay-open main) {
    overflow-y: hidden !important;
    overscroll-behavior: none;
  }

  /* Родитель карточки создаёт собственный stacking context. Без его подъёма трековые полки
     с собственным z-index могли рисоваться поверх уже развёрнутой волны. */
  :global(.wave-hero-host:has(.wave-hero-slot.is-overlay-active)) {
    z-index: 90;
  }

  .wave-expand-backdrop {
    position: fixed;
    /* Cover the whole app chrome. Leaving a hard left edge at the sidebar boundary
       produced a second rectangular frame while the card was moving to its fixed slot. */
    inset: 36px 0 96px;
    z-index: 110;
    padding: 0;
    border: 0;
    pointer-events: none;
    touch-action: none;
    overscroll-behavior: contain;
    /* Невидимая зона закрытия. Отдельный полупрозрачный scrim выглядел как ещё одна
       кривая карточка под волной, особенно во время FLIP-масштабирования. */
    background: transparent;
    cursor: default;
  }

  .wave-expand-backdrop.is-active {
    pointer-events: auto;
  }

  :global(body[data-perf="light"]) .wave-expand-backdrop {
    background: transparent;
  }

  .wave-hero {
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: 1.75rem;
    min-height: 244px;
    display: flex;
    align-items: flex-end;
    background: rgba(255, 255, 255, 0.028);
    border: 1px solid rgba(255, 255, 255, 0.055);
    isolation: isolate;
    /* Композитору незачем перепроверять, не вылезло ли размытие пятен за края блока: рамка
       обрезки и так здесь. С `contain` он перерисовывает только этот прямоугольник. */
    contain: paint;
    transition: border-color var(--duration-slow, 700ms) var(--ease-smooth-out, ease);
  }

  .wave-hero.is-expanded {
    position: fixed;
    /* Оверлей перекрывает всё приложение, значит и центр у него должен быть центром окна,
       а не правой колонки после сайдбара. Ограничение ширины не даёт сцене растянуться на
       ультрашироком мониторе, симметричная формула сохраняет точный центр. */
    inset: 52px max(24px, calc((100vw - 1180px) / 2)) 112px;
    width: auto;
    z-index: 120;
    min-height: 0;
    border-radius: 32px;
    background: #07070b;
    /* `contain: paint` on the compact card made the fixed FLIP frame clip its own
       canvas during expansion, which showed up as black strips along the edges. */
    contain: none;
    overflow: hidden;
    border: 0;
    border-color: transparent;
    box-shadow:
      0 42px 110px -34px rgba(0, 0, 0, 0.92),
      0 0 80px -46px color-mix(in srgb, var(--color-primary) 74%, transparent);
    transform-origin: top left;
  }

  .wave-hero.is-live {
    border-color: color-mix(in srgb, var(--color-primary) 34%, transparent);
  }

  /* Окно не на переднем плане. Полотно в это время не рисуется вообще (см. `syncAwake`), а
     здесь замирает фон: три размытых пятна со `mix-blend-mode` — это, в отличие от обычного
     сдвига, пересборка слоёв на каждом кадре, и платить за неё, пока человек в другом окне,
     не за что. `will-change` тоже снимаем — иначе три слоя остаются висеть в памяти GPU. */
  .wave-hero.is-idle .wave-blob {
    animation-play-state: paused;
    will-change: auto;
  }

  .wave-hero.is-idle .wave-dot {
    animation-play-state: paused;
  }

  .wave-hero-bg {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
  }

  .wave-hero-cover {
    position: absolute;
    inset: -25%;
    width: 150%;
    height: 150%;
    object-fit: cover;
    filter: blur(58px) saturate(1.5);
    opacity: 0.5;
    transform: scale(1.1);
    transition: opacity var(--duration-slow, 700ms) ease;
  }

  /* Три пятна цвета темы, каждое со своим ходом. Один слой смотрелся бы плоским
     градиентом, а движение в разных направлениях даёт то самое «переливается». */
  .wave-blob {
    position: absolute;
    width: 46%;
    aspect-ratio: 1;
    border-radius: 50%;
    filter: blur(46px);
    opacity: 0.55;
    mix-blend-mode: screen;
    will-change: transform;
  }

  .wave-blob-a {
    left: -6%;
    top: -34%;
    background: radial-gradient(circle, var(--color-primary) 0%, transparent 68%);
    animation: wave-drift-a 17s ease-in-out infinite;
  }

  .wave-blob-b {
    right: 4%;
    bottom: -40%;
    background: radial-gradient(
      circle,
      color-mix(in srgb, var(--color-primary) 55%, #6b5bff) 0%,
      transparent 68%
    );
    animation: wave-drift-b 23s ease-in-out infinite;
  }

  .wave-blob-c {
    left: 38%;
    top: -20%;
    width: 34%;
    background: radial-gradient(
      circle,
      color-mix(in srgb, var(--color-primary) 40%, #ff5aa8) 0%,
      transparent 70%
    );
    animation: wave-drift-c 29s ease-in-out infinite;
  }

  @keyframes wave-drift-a {
    0%,
    100% {
      transform: translate3d(0, 0, 0) scale(1);
    }
    50% {
      transform: translate3d(14%, 12%, 0) scale(1.18);
    }
  }

  @keyframes wave-drift-b {
    0%,
    100% {
      transform: translate3d(0, 0, 0) scale(1.05);
    }
    50% {
      transform: translate3d(-18%, -14%, 0) scale(0.9);
    }
  }

  @keyframes wave-drift-c {
    0%,
    100% {
      transform: translate3d(0, 0, 0) scale(0.95);
    }
    50% {
      transform: translate3d(10%, 22%, 0) scale(1.25);
    }
  }

  /* Тексту нужен ровный тёмный низ: поверх пятен и обложки читаемость иначе гуляет. */
  .wave-hero-veil {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(100deg, rgba(10, 10, 12, 0.9) 0%, rgba(10, 10, 12, 0.42) 52%, transparent 100%),
      linear-gradient(to top, rgba(10, 10, 12, 0.82) 0%, transparent 62%);
  }

  .wave-hero.is-expanded .wave-hero-veil {
    background:
      radial-gradient(70% 90% at 72% 48%, transparent 18%, rgba(6, 6, 10, 0.2) 74%),
      linear-gradient(100deg, rgba(6, 6, 10, 0.94) 0%, rgba(7, 7, 11, 0.36) 57%, rgba(7, 7, 11, 0.18) 100%),
      linear-gradient(to top, rgba(6, 6, 10, 0.88) 0%, transparent 64%);
  }

  .wave-hero-canvas {
    position: absolute;
    inset: 0;
    z-index: 1;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .wave-hero-body {
    position: relative;
    z-index: 2;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    padding: 28px 32px;
    flex-wrap: wrap;
  }

  .wave-hero.is-expanded .wave-hero-body {
    min-height: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    padding: clamp(40px, 5vw, 64px);
    gap: clamp(28px, 4vw, 56px);
  }

  .wave-hero.is-expanded .wave-hero-text {
    width: 100%;
    max-width: 680px;
  }

  .wave-hero-text {
    min-width: 0;
    flex: 1 1 320px;
  }

  .wave-hero-greeting {
    font-size: 12.5px;
    font-weight: 500;
    letter-spacing: 0.01em;
    color: rgba(255, 255, 255, 0.44);
    margin-bottom: 10px;
  }

  .wave-hero-title {
    font-size: 42px;
    font-weight: 400;
    letter-spacing: -0.035em;
    line-height: 1.05;
    color: rgba(255, 255, 255, 0.97);
    margin: 0;
  }

  .wave-hero.is-expanded .wave-hero-title {
    max-width: none;
    font-size: clamp(58px, 6.6vw, 104px);
    font-weight: 350;
    letter-spacing: -0.055em;
    white-space: nowrap;
    text-shadow: 0 18px 60px rgba(0, 0, 0, 0.42);
  }

  .wave-hero.is-expanded .wave-hero-greeting {
    margin-bottom: 16px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.56);
  }

  .wave-hero-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .wave-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    color: rgba(255, 255, 255, 0.72);
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .wave-chip :global(svg) {
    display: block;
    flex: 0 0 auto;
  }

  .wave-chip-live {
    color: color-mix(in srgb, var(--color-primary) 82%, white);
    background: color-mix(in srgb, var(--color-primary) 16%, transparent);
    border-color: color-mix(in srgb, var(--color-primary) 34%, transparent);
  }

  .wave-chip-filter {
    color: rgba(255, 255, 255, 0.82);
    background: rgba(0, 0, 0, 0.18);
    border-color: rgba(255, 255, 255, 0.11);
  }

  .wave-dot {
    display: block;
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: wave-pulse 1.9s ease-in-out infinite;
  }

  @keyframes wave-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }

  .wave-hero-hint {
    font-size: 13.5px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.5);
    margin: 12px 0 0;
    max-width: 52ch;
    /* Название играющего трека бывает любой длины — две строки и обрыв. Одна строка с
       `nowrap` резала и обычную подпись про то, из чего собран поток. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  .wave-hero.is-expanded .wave-hero-hint {
    max-width: 58ch;
    margin-top: 18px;
    font-size: 16px;
    color: rgba(255, 255, 255, 0.62);
  }

  .wave-hero-note {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    max-width: 58ch;
    margin: 9px 0 0;
    color: rgba(255, 205, 128, 0.68);
    font-size: 11.5px;
    line-height: 1.4;
  }

  :global(.wave-note-icon) {
    flex: 0 0 auto;
    margin-top: 1px;
  }

  .wave-hero-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .wave-hero.is-expanded .wave-hero-actions {
    position: relative;
    z-index: 4;
    gap: 10px;
    padding: 0;
    background: none;
    border: 0;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .wave-expand {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 15px;
    border-radius: 999px;
    color: rgba(255, 255, 255, 0.76);
    background: rgba(255, 255, 255, 0.055);
    border: 1px solid rgba(255, 255, 255, 0.09);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition:
      color 160ms var(--ease-out, ease-out),
      background-color 160ms var(--ease-out, ease-out),
      border-color 160ms var(--ease-out, ease-out),
      transform 160ms var(--ease-out, ease-out);
  }

  .wave-expand:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.105);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .wave-expand:active {
    transform: scale(0.97);
  }

  .wave-expand:disabled {
    cursor: default;
    opacity: 0.72;
  }

  .wave-hero.is-expanded .wave-expand,
  .wave-hero.is-expanded .wave-tune-trigger,
  .wave-hero.is-expanded .wave-recollect {
    background: rgba(255, 255, 255, 0.065);
    border-color: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .wave-hero.is-expanded .wave-expand:hover,
  .wave-hero.is-expanded .wave-tune-trigger:hover,
  .wave-hero.is-expanded .wave-tune-trigger.is-open,
  .wave-hero.is-expanded .wave-recollect:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.11);
    border-color: transparent;
  }

  .wave-tune-trigger {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 15px;
    border-radius: 999px;
    color: rgba(255, 255, 255, 0.82);
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition:
      color var(--duration-micro, 120ms) var(--ease-out, ease-out),
      background-color var(--duration-micro, 120ms) var(--ease-out, ease-out),
      border-color var(--duration-micro, 120ms) var(--ease-out, ease-out);
  }

  .wave-tune-trigger:hover,
  .wave-tune-trigger.is-open {
    color: #fff;
    background: color-mix(in srgb, var(--color-primary) 15%, rgba(255, 255, 255, 0.07));
    border-color: color-mix(in srgb, var(--color-primary) 28%, rgba(255, 255, 255, 0.1));
  }

  .wave-tune-trigger:focus-visible,
  .wave-expand:focus-visible,
  .wave-tune-clear:focus-visible,
  .wave-genre-item:focus-visible,
  .wave-tune-apply:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .wave-tune-count {
    min-width: 19px;
    height: 19px;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    color: #0a0a0c;
    background: var(--color-primary);
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
  }

  .wave-play {
    width: 62px;
    height: 62px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #0a0a0c;
    background: var(--color-primary);
    border: none;
    cursor: pointer;
    box-shadow: 0 12px 34px color-mix(in srgb, var(--color-primary) 38%, transparent);
    transition:
      transform var(--duration-micro, 120ms) var(--ease-out, ease-out),
      box-shadow var(--duration-micro, 120ms) var(--ease-out, ease-out);
  }

  .wave-hero.is-expanded .wave-play {
    width: 72px;
    height: 72px;
  }

  .wave-play:hover:not(:disabled) {
    transform: scale(1.06);
    box-shadow: 0 16px 44px color-mix(in srgb, var(--color-primary) 52%, transparent);
  }

  .wave-play:active:not(:disabled) {
    transform: scale(0.96);
  }

  .wave-play:disabled {
    cursor: progress;
    opacity: 0.65;
  }

  .wave-recollect {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 16px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.8);
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.09);
    cursor: pointer;
    transition: background-color var(--duration-micro, 120ms) var(--ease-out, ease-out);
  }

  .wave-recollect:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }

  .wave-recollect:disabled {
    opacity: 0.55;
    cursor: progress;
  }

  .wave-tune-pop {
    position: fixed;
    z-index: 160;
    width: min(360px, calc(100vw - 24px));
    max-height: calc(100vh - 130px);
    max-height: calc(100dvh - 130px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    overflow: hidden;
    color: #fff;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-primary) 5%, transparent), transparent 45%),
      rgba(9, 9, 13, 0.97);
    backdrop-filter: blur(28px) saturate(145%);
    -webkit-backdrop-filter: blur(28px) saturate(145%);
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 20px;
    box-shadow: 0 28px 80px -20px rgba(0, 0, 0, 0.88), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    transform-origin: top right;
  }

  .wave-tune-head,
  .wave-tune-heading,
  .wave-tune-section-head {
    display: flex;
    align-items: center;
  }

  .wave-tune-head {
    justify-content: space-between;
    gap: 12px;
  }

  .wave-tune-heading {
    min-width: 0;
    gap: 10px;
  }

  .wave-tune-icon {
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border-radius: 11px;
    color: color-mix(in srgb, var(--color-primary) 72%, white);
    background: color-mix(in srgb, var(--color-primary) 13%, rgba(255, 255, 255, 0.04));
    border: 1px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
  }

  .wave-tune-heading h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }

  .wave-tune-heading p {
    margin: 3px 0 0;
    color: rgba(255, 255, 255, 0.42);
    font-size: 11px;
    line-height: 1.3;
  }

  .wave-tune-clear {
    min-height: 32px;
    padding: 0 9px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 9px;
    color: rgba(255, 255, 255, 0.48);
    background: transparent;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .wave-tune-clear:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.07);
  }

  .wave-tune-section {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .wave-tune-label {
    color: rgba(255, 255, 255, 0.46);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .wave-tune-pop :global(.seg-control) {
    width: 100%;
  }

  .wave-tune-genres {
    min-height: 0;
    flex: 0 0 auto;
  }

  .wave-tune-section-head {
    justify-content: space-between;
    gap: 12px;
  }

  .wave-tune-current {
    min-width: 0;
    overflow: hidden;
    color: rgba(255, 255, 255, 0.75);
    font-size: 11.5px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wave-genre-menu {
    height: 184px;
    min-height: 136px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid rgba(255, 255, 255, 0.065);
  }

  .wave-genre-item {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 10px;
    border: 0;
    border-radius: 10px;
    color: rgba(255, 255, 255, 0.68);
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition:
      color var(--duration-micro, 120ms) var(--ease-out, ease-out),
      background-color var(--duration-micro, 120ms) var(--ease-out, ease-out);
  }

  .wave-genre-item > span {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .wave-genre-item strong {
    overflow: hidden;
    font-size: 12.5px;
    font-weight: 650;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wave-genre-item small {
    overflow: hidden;
    color: rgba(255, 255, 255, 0.34);
    font-size: 10.5px;
    font-weight: 450;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wave-genre-item:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.075);
  }

  .wave-genre-item.is-selected {
    color: color-mix(in srgb, var(--color-primary) 42%, white);
    background: color-mix(in srgb, var(--color-primary) 13%, rgba(255, 255, 255, 0.035));
  }

  .wave-genre-item :global(svg) {
    flex: 0 0 auto;
    color: var(--color-primary);
  }

  .wave-tune-note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 11px;
    border-radius: 12px;
    color: rgba(255, 255, 255, 0.48);
    background: rgba(255, 255, 255, 0.035);
    font-size: 10.5px;
    line-height: 1.4;
  }

  .wave-tune-note :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
    color: color-mix(in srgb, var(--color-primary) 55%, white);
  }

  .wave-tune-apply {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 13px;
    color: #09090b;
    background: var(--color-primary);
    font-size: 12.5px;
    font-weight: 750;
    cursor: pointer;
    box-shadow: 0 12px 30px -16px color-mix(in srgb, var(--color-primary) 80%, transparent);
  }

  .wave-tune-apply:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .wave-tune-apply:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  @media (max-width: 720px) {
    .wave-hero-title {
      font-size: 32px;
    }
    .wave-hero-body {
      padding: 22px 20px;
    }
    .wave-hero-actions {
      width: 100%;
      justify-content: flex-start;
    }
    .wave-tune-trigger span:not(.wave-tune-count) {
      display: none;
    }
    .wave-expand span {
      display: none;
    }
    .wave-expand,
    .wave-tune-trigger {
      width: 44px;
      padding: 0;
    }
    .wave-genre-menu {
      height: 164px;
    }
    .wave-hero.is-expanded {
      inset: 48px 12px 104px;
      border-radius: 24px;
    }
    .wave-expand-backdrop {
      inset: 36px 0 92px;
    }
    .wave-hero.is-expanded .wave-hero-body {
      grid-template-columns: minmax(0, 1fr);
      padding: 56px 20px 24px;
      align-content: flex-end;
      gap: 28px;
    }
    .wave-hero.is-expanded .wave-hero-title {
      font-size: clamp(48px, 16vw, 72px);
    }
    .wave-hero.is-expanded .wave-hero-actions {
      width: 100%;
      justify-content: flex-start;
      padding: 0;
    }
  }

  @media (min-width: 721px) and (max-width: 1080px) {
    .wave-hero.is-expanded {
      inset: 52px 18px 108px;
    }
  }

  /* Системная настройка «уменьшить анимацию»: гасим декоративное движение. Кадры ленты
     останавливает сам скрипт — здесь остаются пятна и точка «играет». */
  @media (prefers-reduced-motion: reduce) {
    .wave-blob,
    .wave-dot {
      animation: none;
    }
    .wave-play:hover:not(:disabled),
    .wave-play:active:not(:disabled),
    .wave-expand:active,
    .wave-tune-pop {
      transform: none;
    }
  }
</style>
