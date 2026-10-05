import { tick } from 'svelte';

let flying: { node: HTMLElement; animation: Animation; target: HTMLElement } | null = null;
let generation = 0;
export function cancelDailyMixMotion() {
  generation++;
  if (!flying) return;
  flying.animation.cancel();
  flying.target.style.removeProperty('visibility');
  flying.node.remove();
  flying = null;
}

/** Measure the old view before Svelte replaces it, then animate one decorative copy. */
export async function transitionDailyMix(id: string, afterRender: () => void, light: boolean) {
  if (!id) { cancelDailyMixMotion(); await tick(); afterRender(); return; }
  const selector = `[data-mix-cover="${CSS.escape(id)}"]`;
  const origin = flying?.node || document.querySelector<HTMLElement>(selector);
  const start = origin?.getBoundingClientRect();
  const copy = origin?.cloneNode(true) as HTMLElement | undefined;
  cancelDailyMixMotion();
  const run = generation;
  await tick();
  if (run !== generation) return;
  afterRender();
  let target = document.querySelector<HTMLElement>(selector);
  // Home cards wait for the already-started credential/playlist hydration on remount.
  for (let frame = 0; !target && frame < 3; frame++) {
    await new Promise(requestAnimationFrame);
    if (run !== generation) return;
    afterRender();
    target = document.querySelector<HTMLElement>(selector);
  }
  if (!copy || !target || !start?.width || light || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const end = target.getBoundingClientRect();
  if (!end.width || end.bottom < 0 || end.top > innerHeight) return;
  const tokens = getComputedStyle(document.documentElement);
  const duration = parseFloat(tokens.getPropertyValue('--duration-quick')) || 250;
  const easing = tokens.getPropertyValue('--ease-smooth-out').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)';
  copy.removeAttribute('data-mix-cover');
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('data-mix-flight', '');
  Object.assign(copy.style, { position: 'fixed', left: `${end.left}px`, top: `${end.top}px`, width: `${end.width}px`, height: `${end.height}px`, zIndex: '1000', pointerEvents: 'none', transformOrigin: '0 0', margin: '0' });
  document.body.append(copy);
  target.style.visibility = 'hidden';
  const animation = copy.animate([
    { transform: `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${start.width / end.width}, ${start.height / end.height})` },
    { transform: 'translate(0, 0) scale(1)' }
  ], { duration, easing });
  flying = { node: copy, animation, target };
  try { await animation.finished; } catch { /* An interrupted navigation owns the next flight. */ }
  if (run === generation) {
    target.style.removeProperty('visibility');
    copy.remove();
    flying = null;
  }
}
