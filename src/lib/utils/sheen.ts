/**
 * Держит класс блика (Steam-style shine) на карточке, пока курсор на ней.
 *
 * Зачем скрипт для чисто визуального эффекта. На входе полоса один раз проходит вправо, а
 * на уходе быстро растворяется; CSS возвращает её к старту уже невидимой. От скрипта нужно
 * понять границы карточки и держать на ней класс ровно пока курсор внутри.
 *
 * Полоса — блик ПЛОСКИХ поверхностей: строк, кнопок, плиток без обложки. Обложки носят
 * `spec-art` и отражение, которое считает `$lib/utils/tilt` из угла наклона: наклонённому
 * глянцу проход не годится, он о наклоне не знает. Один блик на поверхность — поэтому здесь
 * ищутся только `.sheen-art`, и на обложке этот скрипт не находит ничего.
 *
 * Казалось бы, ровно это умеет `:hover` — и тогда скрипт не нужен вовсе. Не выходит по
 * двум причинам. Первая: хозяин ховера у карточки не один. Обёртка бывает `.group`,
 * `.interactive-item` или именованной группой Tailwind (`group/track`, `group/info`) —
 * это отдельные классы, под `.group` они не попадают, и селектор пришлось бы дописывать
 * под каждый новый вид карточки. Вторая: полоса лежит накладкой внутри карточки, а
 * реагировать должна вся карточка целиком, включая подпись, — то есть `:hover` нужен на
 * предке, которого в разметке может не быть общего.
 *
 * Обработчики висят на документе, а не по одному на карточку: карточек в полках сотни, они
 * постоянно создаются и уничтожаются при переходах, и делегирование избавляет от
 * подписки/отписки на каждой.
 *
 * Полоса выключается в настройках (`cardSheen`). Выключенная — это не «прозрачная полоса»,
 * а полное отсутствие работы: класс не ставится, переход не запускается, композитный слой
 * под полосу не создаётся.
 */

import { settings } from '$lib/stores';

/** Класс, по которому CSS дизайна переводит полосу в конечное положение. */
const RUNNING = 'is-sheening';

/**
 * Элементы, ховер по которым считается ховером по карточке. `.group` — обычная
 * Tailwind-группа, `.interactive-item` — носитель физики наведения, `[class*="group/"]`
 * добирает именованные группы Tailwind.
 */
const CARD_ROOTS = '.sheen-art, .group, .interactive-item, [class*="group/"]';

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Что включено в настройках. Читается из стора, см. `trackSheen`. */
let enabled = true;

/** Снимает класс со всех полос, которые сейчас в движении. */
function clearRunning() {
  for (const band of Array.from(document.querySelectorAll(`.${RUNNING}`))) {
    band.classList.remove(RUNNING);
  }
}

/**
 * По любому элементу под курсором находит карточку: какие полосы в ней зажигать (`bands`) и
 * какую область считать «внутри» (`scope`).
 *
 * Второй шаг — расширение области вверх — не украшательство, а необходимость. Вход и выход
 * курсора приходят на разные элементы: вошёл на обложку, вышел с подписи. Если брать
 * ближайший корень, обложка (она же `.sheen-art`) дала бы `scope` размером в саму обложку,
   * и переход курсора с обложки на подпись выглядел бы как уход с карточки — блик погас бы,
   * хотя курсор ещё на плитке. Поэтому от найденного корня поднимаемся вверх, пока
 * очередной предок описывает ту же самую карточку, то есть не добавляет новых полос: так
 * область получается одинаковой, с какой бы точки её ни искали.
 */
function resolveCard(target: Element): { scope: Element; bands: Element[] } | null {
  let node: Element | null = target.closest(CARD_ROOTS);
  let bands: Element[] = [];
  while (node && bands.length === 0) {
    bands = node.matches('.sheen-art') ? [node] : Array.from(node.querySelectorAll('.sheen-art'));
    if (bands.length === 0) node = node.parentElement?.closest(CARD_ROOTS) ?? null;
  }
  if (!node || bands.length === 0) return null;

  let scope: Element = node;
  for (
    let up: Element | null = scope.parentElement?.closest(CARD_ROOTS) ?? null;
    up;
    up = up.parentElement?.closest(CARD_ROOTS) ?? null
  ) {
    // Больше полос — значит предок накрыл уже не одну карточку, а полку. Останавливаемся:
    // иначе ховер по одной плитке зажигал бы блик на всех соседних.
    if (up.querySelectorAll('.sheen-art').length !== bands.length) break;
    scope = up;
  }

  return { scope, bands };
}

function onPointerOver(e: PointerEvent) {
  if (!enabled || prefersReducedMotion()) return;
  if (!(e.target instanceof Element)) return;

  const card = resolveCard(e.target);
  if (!card) return;

  // Движение курсора внутри той же карточки — не новый вход. Без этой проверки
  // `pointerover` сыпался бы на каждом внутреннем элементе (обложка → подпись → кнопка).
  if (e.relatedTarget instanceof Node && card.scope.contains(e.relatedTarget)) return;

  for (const band of card.bands) band.classList.add(RUNNING);
}

function onPointerOut(e: PointerEvent) {
  if (!(e.target instanceof Element)) return;

  const card = resolveCard(e.target);
  if (!card) return;

  // `pointerout` всплывает и от перехода на вложенный элемент тоже, поэтому уходом
  // считается только выход за пределы карточки. `relatedTarget === null` — курсор ушёл за
  // окно, это тоже уход.
  if (e.relatedTarget instanceof Node && card.scope.contains(e.relatedTarget)) return;

  for (const band of card.bands) band.classList.remove(RUNNING);
}

/** Returns a teardown function, so callers can register it from `onMount`. */
export function trackSheen(): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  // Настройку читаем подпиской, а не разово: переключатель должен срабатывать сразу, а не
  // после перезапуска. Выключение снимает класс с полос, которые сейчас едут, — иначе
  // полоса под курсором осталась бы стоять в конечном положении навсегда.
  const stopSettings = settings.subscribe((value) => {
    // Режим производительности выключает полосу вместе с остальными эффектами: её слой во всю
    // обложку CSS убирает из дерева отрисовки, и вешать на него класс по каждому наведению
    // курсора там уже незачем.
    enabled = value?.cardSheen !== false && value?.perfMode !== true;
    if (!enabled) clearRunning();
  });

  document.addEventListener('pointerover', onPointerOver);
  document.addEventListener('pointerout', onPointerOut);

  return () => {
    stopSettings();
    document.removeEventListener('pointerover', onPointerOver);
    document.removeEventListener('pointerout', onPointerOut);
    clearRunning();
  };
}
