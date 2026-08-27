/**
 * 3D-Tilt по карточкам: обложка наклоняется вслед за курсором и приподнимается над
 * поверхностью, по матовому стеклу карточки ходит мягкое свечение, на уходе всё возвращается
 * пружиной, а не «щелчком».
 *
 * ── Почему наклоняется НЕ сама карточка ──────────────────────────────────────────────
 * Требование «зона наведения не сужается» — не пожелание, а условие работоспособности.
 * `rotateY` с перспективой уводит дальнюю кромку в глубину, и в проекции она едет ВНУТРЬ.
 * Величина сдвига растёт квадратом размера: для строки «Любимого» шириной ~900px
 * (полуширина h=450) при 7° и P=900 дальняя кромка смещается на
 *   h·cosθ·P/(P + h·sinθ) = 446.6·900/954.9 ≈ 421  →  29px внутрь.
 * Курсор, стоявший у кромки, оказывается вне строки: `:hover` снимается, наклон уходит,
 * строка возвращается в полный размер, курсор снова внутри — та самая незатухающая
 * пульсация, из-за которой из проекта убрали и `scale(1.01)`, и `perspective+translateZ`
 * на ховере (разбор в app.css). Уменьшить угол до безопасного нельзя: условие
 * «сдвиг < 1px» даёт θ ≤ D·P/h² ≈ 0.25° — наклон, которого не видно.
 *
 * Поэтому трансформируется слой обложки внутри карточки (`.tile-art` / `.art-glow`), а
 * хозяином ховера остаётся обёртка, геометрию которой мы не трогаем вообще. Это снимает
 * проблему целиком, а не смягчает её: попадание курсора считается по боксу обёртки, и
 * ушедшая в глубину обложка просто открывает под курсором её же фон — `:hover` обёртки
 * (а с ним и тень, и specular, и все `group-hover:` утилиты в разметке) не дёргается.
 *
 * По той же причине обложке разрешён и подъём по Z, хотя карточке он запрещён: `translateZ`
 * с перспективой — это масштаб P/(P−z), то есть при P=620 и z=18px обложка становится на 3%
 * БОЛЬШЕ. Для хозяина ховера любое изменение размера — источник пульсации, а для слоя
 * внутри него это просто «поднялся над поверхностью»: бокс обёртки не меняется, попадание
 * курсора считается по нему. Заодно расширение почти гасит уход дальней кромки внутрь от
 * поворота (при 10° и полуширине 90px это 3.55px ухода против 2.69px расширения), поэтому
 * обложка не выглядит съезжающей в одну сторону.
 *
 * ── Блик на обложке: отражение, а не полоса поверх ───────────────────────────────────
 * По обложке ходит ровно ОДИН белый блик, и его положение считается из отражения. Раньше их
 * было два: бегущая по входу полоса (`.sheen-art::after`) и specular от наклона — две белые
 * ленты на одном слое, под похожими углами и по разным законам, читались рябью. Осталось
 * одно отражение, которое и вбегает на входе, и живёт по наклону:
 *
 *   Взгляд v = (0, 0, 1) (ось x вправо, y ВНИЗ, z на зрителя). Нормаль наклонённой обложки
 *   при углах CSS `rotateX(rx) rotateY(ry)`:  N ≈ (−sin ry, sin rx, 1) — положительный
 *   `rotateY` уводит правую кромку от зрителя, значит нормаль клонится влево; положительный
 *   `rotateX` уводит верхнюю (ось y вниз), значит нормаль клонится вниз.
 *   Отражённый луч взгляда:  r = 2(N·v)N − v ≈ (−2 sin ry, 2 sin rx, 1) — угол отражения
 *   удваивает наклон, это и есть причина, по которой блик едет заметно быстрее самой плитки.
 *   Источник — точечный, на оси взгляда, на расстоянии lz перед плоскостью. Луч из точки P
 *   доходит до его плоскости при t = lz, отсюда точка блика:
 *     Px = lx + 2·lz·sin(ry),   Py = ly − 2·lz·sin(rx).
 *
 * Знаки складываются в то, что видно на настоящей глянцевой карточке: отклоняешь правую
 * кромку от себя — отражение уезжает к правой кромке. Курсор наклоняет обложку к себе,
 * поэтому блик идёт ЗА курсором, а не против него, и с мягким свечением стекла карточки
 * (`--mouse-x/-y`) спорить ему нечем: оба следуют одному источнику.
 *
 * `SPEC_SWING` — это и есть 2·lz, только сразу в процентах по оси градиента: 26% хода на
 * полный наклон 10° отвечают источнику примерно в одной ширине плитки перед ней.
 *
 * Вбегание на входе — тот же конверт `env`, что ведёт подъём: при env = 0 блик стоит за
 * ближней кромкой (`SPEC_ENTRY`), при env = 1 — в расчётной точке отражения. Пружина env
 * успокаивается за ~300 мс, ровно как поднимается карточка, поэтому вход читается одним
 * жестом, а не двумя. На уходе блик тем же путём уезжает за кромку и гаснет.
 *
 * Мягкое свечение стекла КАРТОЧКИ (`--mouse-x/-y`, `--glare`) осталось: это рассеянный свет
 * по обёртке, которая не поворачивается. Диффузная составляющая и specular одного источника
 * — они и должны быть вместе.
 *
 * ── Почему пружина в скрипте, а не `transition` ──────────────────────────────────────
 * Переход интерполирует к цели по фиксированной кривой за фиксированное время. У слежения
 * за курсором цель меняется каждый кадр, поэтому переход всё время перезапускается с новой
 * кривой — движение получается вязким и «резиновым», без инерции. Пружина с затуханием
 * ζ≈0.84 даёт то, что просили: догон с лёгким перелётом, продолжение движения по инерции
 * после остановки курсора и такой же живой возврат домой из любой точки хода.
 *
 * ── Чего это стоит ──────────────────────────────────────────────────────────────────
 * Один делегированный слушатель на окно (карточек в полках сотни, они постоянно
 * создаются и уничтожаются), одна запись стилей за кадр и ровно на один элемент —
 * обёртку. Все величины уезжают в CSS-переменные, а они наследуются, поэтому слой обложки
 * читает их сам, без второй записи. `getBoundingClientRect` вызывается один раз на вход в
 * карточку, а не на каждое движение мыши.
 *
 * Атрибут `data-tilt` ставится на время движения и снимается, когда пружина успокоилась.
 * Это не косметика: постоянный `transform` на всех обложках держал бы шесть десятков
 * композитных слоёв в памяти GPU ради анимации одной карточки под курсором — ровно то,
 * из-за чего отсюда убирали `will-change: transform`. С атрибутом слой живёт только у той
 * обложки, которая реально движется.
 *
 * Оба эффекта выключаются в настройках (`coverTilt` и `coverGlare`). Выключенный эффект не
 * «анимируется в ноль», а не выполняется вовсе: переменные не пишутся, атрибут не ставится,
 * кадр не заказывается. Наклон и свечение независимы — при выключенном наклоне свечение
 * остаётся, и наоборот.
 */

import { settings } from '$lib/stores';

/** Хозяин ховера. Его геометрию мы не меняем — см. заголовок файла. */
const CARD_ROOT = '.interactive-item';

/** Угол на самой кромке карточки, в градусах. */
const MAX_TILT = 10;

/** Подъём обложки над поверхностью в пикселях; с перспективой это ещё и +3% размера. */
const MAX_LIFT = 18;

/* ── Блик обложки ───────────────────────────────────────────────────────────────────────
   Ход блика на полный наклон, в процентах по оси градиента (это 2·lz из вывода в заголовке:
   источник примерно в одной ширине плитки перед ней). Проекция наклона доходит до ±1.33, то
   есть на угловой кромке блик уезжает на ±34% от центра — заметно, но не за край.

   Ось градиента — `--sheen-angle` из app.css, 115°: единый источник света на всё приложение,
   тот же, по которому идёт полоса на плоских поверхностях. Отсюда единичный вектор оси
   (sin φ, −cos φ) при y, направленной вниз. Величины зашиты числом, потому что тригонометрию
   в CSS не спросить; при смене токена их надо пересчитать — на это указывает LIGHT_ANGLE. */
const LIGHT_ANGLE = 115;
const AXIS_X = Math.sin((LIGHT_ANGLE * Math.PI) / 180);
const AXIS_Y = -Math.cos((LIGHT_ANGLE * Math.PI) / 180);
const SPEC_SWING = 26;

/** Где блик стоит до входа курсора: за ближней кромкой, целиком вне плитки. */
const SPEC_ENTRY = -35;

/**
 * Мягкая доля отражения теперь имеет собственную точку на плоскости обложки. Полоса и
 * пятно остаются одним источником света: первое даёт яркое ядро, второе — объём вокруг
 * него. Стартовая точка лежит за кромкой вдоль той же оси, что и диагональная полоса.
 */
const SPEC_SPOT_SWING = 30;
const SPEC_SPOT_ENTRY_DISTANCE = 112;
const SPEC_ENTRY_X = 50 - AXIS_X * SPEC_SPOT_ENTRY_DISTANCE;
const SPEC_ENTRY_Y = 50 - AXIS_Y * SPEC_SPOT_ENTRY_DISTANCE;

/* Жёсткость и затухание. ζ = c / (2√k): наклон 22/(2·13.04) ≈ 0.84 — догон с еле
   заметным перелётом; блик жёстче, он должен отставать лишь чуть-чуть, иначе «плавает»
   отдельно от курсора; яркость — почти без перелёта, мигание на входе не нужно. */
const TILT_K = 170;
const TILT_C = 22;
const GLARE_K = 420;
const GLARE_C = 38;
const ENV_K = 260;
const ENV_C = 30;

/** Шаг интегрирования. Фиксированный — иначе при просадке кадра пружина разносится. */
const STEP = 1 / 120;

/** Потолок кадра: после сворачивания окна `now` прыгает на минуты, dt надо обрезать. */
const MAX_DT = 1 / 30;

/** Порог покоя: ниже него движение уже не видно, слой можно отпускать. */
const EPS_POS = 0.01;
const EPS_VEL = 0.05;

const VARS = [
  '--mouse-x',
  '--mouse-y',
  '--glare',
  '--spec-pos',
  '--spec-x',
  '--spec-y',
  '--spec-a',
  '--tilt-rx',
  '--tilt-ry',
  '--tilt-lift',
];

interface Spring {
  /** Текущее значение. */
  x: number;
  /** Скорость. */
  v: number;
  /** Куда тянет. */
  to: number;
}

interface Card {
  root: HTMLElement;
  width: number;
  height: number;
  left: number;
  top: number;
  /** Наклон по осям X и Y. */
  rx: Spring;
  ry: Spring;
  /** Позиция блика карточки (не обложки) в координатах обёртки. */
  gx: Spring;
  gy: Spring;
  /** Яркость блика: 0 — карточка отпущена, 1 — курсор на ней. */
  env: Spring;
  /** Последнее положение курсора, нормированное в [-1, 1] от центра обёртки. */
  nx: number;
  ny: number;
  /** Курсор ещё на карточке. */
  held: boolean;
}

function spring(x = 0): Spring {
  return { x, v: 0, to: x };
}

/** Карточки в движении: активная плюс те, что ещё едут домой. Обычно одна-две. */
const live = new Map<HTMLElement, Card>();

let current: Card | null = null;
let frame = 0;
let lastTime = 0;
/** Скролл сдвинул карточку — закешированная геометрия больше не годится. */
let stale = false;

/** Что включено в настройках. Читается из стора, см. `trackTilt`. */
let fxTilt = true;
let fxGlare = true;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function advance(s: Spring, k: number, c: number, dt: number) {
  let left = dt;
  while (left > 0) {
    const h = Math.min(STEP, left);
    // Полуявный Эйлер: скорость обновляется до позиции. На пружине это устойчивее
    // явного при том же шаге и стоит те же две операции.
    s.v += (-k * (s.x - s.to) - c * s.v) * h;
    s.x += s.v * h;
    left -= h;
  }
}

function settled(s: Spring): boolean {
  return Math.abs(s.x - s.to) < EPS_POS && Math.abs(s.v) < EPS_VEL;
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function paint(card: Card) {
  const style = card.root.style;

  if (fxTilt) {
    style.setProperty('--tilt-rx', `${card.rx.x.toFixed(2)}deg`);
    style.setProperty('--tilt-ry', `${card.ry.x.toFixed(2)}deg`);
    style.setProperty('--tilt-lift', `${(card.env.x * MAX_LIFT).toFixed(1)}px`);
  }

  if (!fxGlare) return;

  // Свечение стекла карточки: диффузная часть того же источника. Обёртка не поворачивается,
  // поэтому пятно просто следует за курсором.
  style.setProperty('--mouse-x', `${card.gx.x.toFixed(1)}px`);
  style.setProperty('--mouse-y', `${card.gy.x.toFixed(1)}px`);
  style.setProperty('--glare', card.env.x.toFixed(3));

  // Отражение на обложке. Проекция наклона на ось градиента — вывод в заголовке файла:
  // блик едет вправо от положительного `rotateY` и вверх от положительного `rotateX`, то
  // есть за курсором. При выключенном наклоне обложка не поворачивается, отражать ей
  // нечего под углом — блик остаётся по центру и только вбегает.
  const swing = fxTilt
    ? ((card.ry.x / MAX_TILT) * AXIS_X + (-card.rx.x / MAX_TILT) * AXIS_Y) * SPEC_SWING
    : 0;
  const target = 50 + swing;
  // Вбегание: тот же конверт, что ведёт подъём карточки, поэтому вход — один жест.
  const pos = SPEC_ENTRY + card.env.x * (target - SPEC_ENTRY);

  // Пространственная доля блика не приклеена к курсору. Она следует нормали повернутой
  // плоскости, поэтому при движении по диагонали свет действительно описывает поверхность,
  // а не выглядит белым кружком поверх изображения.
  const normalX = fxTilt ? card.ry.x / MAX_TILT : 0;
  const normalY = fxTilt ? -card.rx.x / MAX_TILT : 0;
  const targetX = 50 + normalX * SPEC_SPOT_SWING;
  const targetY = 50 + normalY * SPEC_SPOT_SWING;
  const spotX = SPEC_ENTRY_X + card.env.x * (targetX - SPEC_ENTRY_X);
  const spotY = SPEC_ENTRY_Y + card.env.x * (targetY - SPEC_ENTRY_Y);

  style.setProperty('--spec-pos', `${pos.toFixed(2)}%`);
  style.setProperty('--spec-x', `${spotX.toFixed(2)}%`);
  style.setProperty('--spec-y', `${spotY.toFixed(2)}%`);
  style.setProperty('--spec-a', card.env.x.toFixed(3));
}

function release(card: Card) {
  card.root.removeAttribute('data-tilt');
  for (const name of VARS) card.root.style.removeProperty(name);
  live.delete(card.root);
  if (current === card) current = null;
}

function releaseAll() {
  for (const card of Array.from(live.values())) release(card);
}

function tick(now: number) {
  frame = 0;
  const dt = lastTime ? Math.min(MAX_DT, (now - lastTime) / 1000) : STEP;
  lastTime = now;

  // Кадр заказывается только если что-то ещё движется. Иначе цикл жил бы вечно на любой
  // карточке под неподвижным курсором: пружина давно успокоилась, а мы бы продолжали
  // просыпаться шестьдесят раз в секунду и переписывать те же самые значения.
  let busy = false;

  for (const card of Array.from(live.values())) {
    advance(card.rx, TILT_K, TILT_C, dt);
    advance(card.ry, TILT_K, TILT_C, dt);
    advance(card.gx, GLARE_K, GLARE_C, dt);
    advance(card.gy, GLARE_K, GLARE_C, dt);
    advance(card.env, ENV_K, ENV_C, dt);

    const still =
      settled(card.rx) &&
      settled(card.ry) &&
      settled(card.gx) &&
      settled(card.gy) &&
      settled(card.env);

    // Отпущенная и успокоившаяся карточка отдаёт композитный слой обратно.
    if (still && !card.held) {
      release(card);
      continue;
    }
    paint(card);
    if (!still) busy = true;
  }

  if (busy) frame = requestAnimationFrame(tick);
  // Сбрасываем отсчёт времени: следующее пробуждение может случиться через минуту, и
  // разница `now` пошла бы в шаг интегрирования целиком.
  else lastTime = 0;
}

function wake() {
  if (!frame) frame = requestAnimationFrame(tick);
}

function measure(card: Card) {
  const rect = card.root.getBoundingClientRect();
  card.left = rect.left;
  card.top = rect.top;
  card.width = rect.width || 1;
  card.height = rect.height || 1;
}

function letGo(card: Card | null) {
  if (!card) return;
  card.held = false;
  card.rx.to = 0;
  card.ry.to = 0;
  card.env.to = 0;
  // Блик остаётся там, где его застали, и просто гаснет: уезжающее к центру пятно
  // читалось бы как второе, самостоятельное движение.
  card.gx.to = card.gx.x;
  card.gy.to = card.gy.x;
  wake();
}

function acquire(root: HTMLElement, x: number, y: number): Card {
  const existing = live.get(root);
  if (existing) {
    // Курсор вернулся на карточку, которая ещё едет домой: подхватываем её на ходу, из
    // текущего положения — перезапуск с нуля выглядел бы как рывок.
    existing.held = true;
    measure(existing);
    return existing;
  }

  const card: Card = {
    root,
    width: 1,
    height: 1,
    left: 0,
    top: 0,
    rx: spring(),
    ry: spring(),
    gx: spring(),
    gy: spring(),
    env: spring(),
    nx: 0,
    ny: 0,
    held: true,
  };
  measure(card);
  // Блик начинается сразу под курсором, а не в центре: иначе на входе пятно пролетало бы
  // через всю карточку к точке, где мышь и так уже стоит.
  card.gx.x = card.gx.to = x - card.left;
  card.gy.x = card.gy.to = y - card.top;
  root.setAttribute('data-tilt', 'on');
  live.set(root, card);
  return card;
}

function onMouseMove(e: MouseEvent) {
  if ((!fxTilt && !fxGlare) || prefersReducedMotion()) {
    releaseAll();
    return;
  }

  const target = e.target instanceof Element ? e.target : null;
  const root = (target?.closest(CARD_ROOT) as HTMLElement | null) ?? null;

  if (!root) {
    letGo(current);
    current = null;
    return;
  }

  if (root !== current?.root) {
    letGo(current);
    current = acquire(root, e.clientX, e.clientY);
  } else if (stale) {
    // Геометрию перечитываем в обработчике события, а не в кадре: чтение внутри
    // requestAnimationFrame — это принудительный layout ровно там, где мы его и избегаем.
    measure(current);
  }
  stale = false;

  const card = current!;
  const lx = e.clientX - card.left;
  const ly = e.clientY - card.top;
  card.gx.to = lx;
  card.gy.to = ly;

  // Нормируем в [-1, 1] от центра и обрезаем: курсор может оказаться и за боксом обёртки
  // (например, на всплывающем меню внутри карточки), а угол за пределы кромки уводить
  // незачем.
  card.nx = clamp1((lx / card.width) * 2 - 1);
  card.ny = clamp1((ly / card.height) * 2 - 1);

  // Кромка под курсором уходит в глубину — карточку как будто придавливают в этом углу.
  // Знаки следуют из системы координат CSS: положительный `rotateY` уводит правую кромку
  // от зрителя, положительный `rotateX` — верхнюю (ось Y направлена вниз), отсюда минус.
  card.ry.to = card.nx * MAX_TILT;
  card.rx.to = -card.ny * MAX_TILT;
  card.env.to = 1;
  wake();
}

/** Курсор ушёл за пределы окна — `mousemove` об этом уже не сообщит. */
function onWindowLeave() {
  letGo(current);
  current = null;
}

/**
 * `mouseout` без `relatedTarget` — единственный признак того, что курсор покинул окно.
 * У переходов между элементами внутри страницы `relatedTarget` заполнен, и такие события
 * мы пропускаем: уход с карточки уже разбирает `mousemove`.
 */
function onWindowLeaveIfExited(e: MouseEvent) {
  if (e.relatedTarget === null) onWindowLeave();
}

function invalidate() {
  stale = true;
}

/** Returns a teardown function, so callers can register it from `onMount`. */
export function trackTilt(): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  // Настройки читаем подпиской, а не разово: переключатель в настройках должен срабатывать
  // сразу, а не после перезапуска. Выключение отпускает всё, что сейчас в движении, — иначе
  // карточка под курсором осталась бы повёрнутой навсегда.
  //
  // Отпускаем именно на ПЕРЕХОДЕ в «выключено», а не при каждом значении с выключенным
  // эффектом: стор настроек пишется целиком и на посторонние изменения тоже (громкость,
  // тема, токен). Условие «выключено — отпустить» срабатывало бы на каждой такой записи и
  // роняло бы наклон карточки под курсором, даже если выключен был только блик.
  const stopSettings = settings.subscribe((value) => {
    // Режим производительности выключает и наклон, и блик — независимо от их собственных
    // тумблеров. CSS их и так гасит (`data-fx-*` в +layout.svelte), но погашенный эффект
    // здесь продолжал бы считаться: mousemove → rAF → запись переменных на каждом кадре.
    // В режиме, который человек включил ради кадров, это ровно та работа, которую надо снять.
    const lite = value?.perfMode === true;
    const nextTilt = value?.coverTilt !== false && !lite;
    const nextGlare = value?.coverGlare !== false && !lite;
    const turnedOff = (fxTilt && !nextTilt) || (fxGlare && !nextGlare);
    fxTilt = nextTilt;
    fxGlare = nextGlare;
    if (turnedOff) releaseAll();
  });

  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('mouseout', onWindowLeaveIfExited, { passive: true });
  window.addEventListener('blur', onWindowLeave);
  // Всплывающий скролл ловим на фазе захвата: прокручивается вложенный контейнер полки,
  // а не окно, и до `window` такое событие в фазе всплытия не доходит.
  window.addEventListener('scroll', invalidate, { passive: true, capture: true });
  window.addEventListener('resize', invalidate, { passive: true });

  return () => {
    stopSettings();
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseout', onWindowLeaveIfExited);
    window.removeEventListener('blur', onWindowLeave);
    window.removeEventListener('scroll', invalidate, { capture: true });
    window.removeEventListener('resize', invalidate);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    releaseAll();
  };
}
