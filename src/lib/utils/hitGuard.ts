/**
 * Защита от нажатия «не туда, куда указывает курсор».
 *
 * Движок окна держит дерево попаданий отдельно от нарисованного кадра. После переверстки -
 * ухода в настройки и обратно, переключения вкладок внутри настроек, дописывания строк в
 * сетку порциями - дерево какое-то время отвечает по старой геометрии. Человек целится в
 * обложку, а нажатие уходит в нижнюю панель действий: в лучшем случае не происходит ничего,
 * в худшем срабатывает «убрать из любимых» и трек исчезает из лайков сам собой.
 *
 * Починить дерево попаданий изнутри страницы нельзя, зато можно не верить ему на слово.
 * У события есть точка курсора, у элемента - `getBoundingClientRect`, то есть свежая
 * разметка. Если точка вне рамки элемента, попадание посчитано по устаревшему дереву, и
 * обработчик запускать нельзя.
 *
 * Это страховка, а не замена нормальной верстке: когда дерево в порядке, проверка просто
 * всегда проходит и ничего не стоит, кроме одного чтения рамки на нажатие.
 */

/**
 * Запас в пикселях. Масштаб интерфейса делает границы дробными, плюс рамка в один пиксель
 * не должна превращать попадание по самому краю кнопки в промах.
 */
const EDGE_SLACK = 3;

/** Ругаемся в журнал ограниченное число раз: это диагностика, а не поток ошибок. */
let loggedMisses = 0;
const MAX_LOGGED_MISSES = 5;

/**
 * Нажатие пришло мимо элемента.
 *
 * @param event нажатие мыши; координаты берутся из него
 * @param element рамку чего проверяем; по умолчанию - элемент с обработчиком
 */
export function pointerMissed(event: MouseEvent, element?: Element | null): boolean {
  const target = element ?? (event.currentTarget instanceof Element ? event.currentTarget : null);
  if (!target) return false;

  // Нажатие с клавиатуры (Enter, пробел) и программный `click()` приходят без координат.
  // Курсор в них не участвует вообще, проверять нечего.
  if (event.detail === 0 && event.clientX === 0 && event.clientY === 0) return false;

  const box = target.getBoundingClientRect();
  // An invisible or detached action cannot be a valid pointer target.
  if (box.width === 0 || box.height === 0) return true;

  const overX = Math.max(box.left - event.clientX, event.clientX - box.right);
  const overY = Math.max(box.top - event.clientY, event.clientY - box.bottom);
  if (overX <= EDGE_SLACK && overY <= EDGE_SLACK) return false;

  if (loggedMisses < MAX_LOGGED_MISSES) {
    loggedMisses += 1;
    console.warn(
      '[hit] нажатие пришло мимо элемента и отклонено: ' +
        `курсор ${Math.round(event.clientX)}x${Math.round(event.clientY)}, ` +
        `рамка ${Math.round(box.left)}..${Math.round(box.right)} по горизонтали и ` +
        `${Math.round(box.top)}..${Math.round(box.bottom)} по вертикали ` +
        `(расхождение ${Math.round(Math.max(overX, 0))}x${Math.round(Math.max(overY, 0))})`
    );
  }
  return true;
}

const GUARDED_ACTIONS = 'button.library-tile-action, button.track-row-action, button.tile-like-button, .library-playlist-track-actions button';

function actionAt(event: Event): HTMLElement | null {
  return event.target instanceof Element
    ? event.target.closest<HTMLElement>(GUARDED_ACTIONS)
    : null;
}

function actionVisible(button: HTMLElement): boolean {
  if (!button.isConnected || button.matches(':disabled')) return false;
  if (getComputedStyle(button).pointerEvents === 'none') return false;
  for (let node: HTMLElement | null = button; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) return false;
  }
  return true;
}

/** A pointer action must begin and end on the same visible, stationary button. */
export function trackPointerActions(): () => void {
  let pressed: HTMLElement | null = null;
  const reset = () => { pressed = null; };
  const down = (event: PointerEvent) => {
    const button = actionAt(event);
    pressed = event.button === 0 && button && actionVisible(button) && !pointerMissed(event, button)
      ? button : null;
  };
  const click = (event: MouseEvent) => {
    const button = actionAt(event);
    const startedOn = pressed;
    reset();
    // Keyboard and assistive activation do not have a pointerdown.
    if (!button || event.detail === 0) return;
    if (startedOn === button && actionVisible(button) && !pointerMissed(event, button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('click', click, true);
  window.addEventListener('pointercancel', reset, true);
  window.addEventListener('blur', reset);
  return () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('pointercancel', reset, true);
    window.removeEventListener('blur', reset);
    reset();
  };
}
