/** Existing sections move after a layout change, without a permanent frame loop. */
export function layoutPosition(node: HTMLElement, enabled = true) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let animation: Animation | undefined;
  let frame = 0;
  function position() {
    let x = 0, y = 0;
    for (let element: HTMLElement | null = node; element; element = element.offsetParent as HTMLElement | null) {
      x += element.offsetLeft; y += element.offsetTop;
    }
    return { x, y };
  }
  let previous = position();
  function measure() {
    frame = 0;
    const next = position();
    if (enabled && !motion.matches && document.visibilityState === 'visible') {
      if (Math.abs(previous.x - next.x) + Math.abs(previous.y - next.y) > .5) {
        const transform = animation ? new DOMMatrixReadOnly(getComputedStyle(node).transform) : undefined;
        const x = previous.x - next.x + (transform?.m41 || 0);
        const y = previous.y - next.y + (transform?.m42 || 0);
        animation?.cancel();
        animation = node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0px, 0px)' }],
          { duration: 260, easing: 'cubic-bezier(.32,.72,0,1)' });
        animation.onfinish = () => { animation = undefined; };
      }
    } else { animation?.cancel(); animation = undefined; }
    previous = next;
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(measure); }
  const resize = new ResizeObserver(schedule);
  function observeSiblings() {
    resize.disconnect();
    if (node.parentElement) for (const sibling of node.parentElement.children) resize.observe(sibling);
    resize.observe(node); schedule();
  }
  const mutation = new MutationObserver(observeSiblings);
  if (node.parentElement) mutation.observe(node.parentElement, { childList: true });
  observeSiblings();
  window.addEventListener('resize', schedule, { passive: true });
  motion.addEventListener('change', schedule);
  return {
    update(next: boolean) { enabled = next; schedule(); },
    destroy() {
      resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame); animation?.cancel();
      window.removeEventListener('resize', schedule); motion.removeEventListener('change', schedule);
    }
  };
}
