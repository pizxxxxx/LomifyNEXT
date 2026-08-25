/**
 * Horizontal drag for slider-like strips (progress bar, volume).
 *
 * A plain `on:click` handler only ever gives you one value per press, which is why the
 * timeline and the volume bar could be tapped but not dragged. This action tracks the
 * pointer from press to release:
 *
 *   • `setPointerCapture` keeps events flowing even after the cursor leaves the 4px-tall
 *     track — without it the drag would die the moment you moved a few pixels up or down,
 *     or the moment the pointer left the window.
 *   • `onChange` fires continuously (cheap: repaint only), `onCommit` fires once on
 *     release — so we don't fire an `audio_seek` IPC call for every mouse move.
 *   • A press without movement still ends in `onCommit`, so tapping keeps working exactly
 *     as it did before.
 */
export interface DragValueParams {
  /** Called on press and on every move with a 0..1 ratio along the element's width. */
  onChange: (ratio: number) => void;
  /** Called once when the pointer is released. Defaults to `onChange`. */
  onCommit?: (ratio: number) => void;
  /** Called on press, before the first `onChange`. */
  onStart?: () => void;
  /** Called after `onCommit`, even if the drag was cancelled. */
  onEnd?: () => void;
  /** When true the element ignores pointers entirely. */
  disabled?: boolean;
}

export function dragValue(node: HTMLElement, params: DragValueParams) {
  let current = params;
  let dragging = false;
  let activePointer = -1;

  function ratioFor(clientX: number) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  }

  function finish(clientX: number, pointerId: number) {
    if (!dragging) return;
    dragging = false;
    activePointer = -1;
    try {
      if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
    } catch {
      /* pointer already gone */
    }
    (current.onCommit ?? current.onChange)(ratioFor(clientX));
    current.onEnd?.();
  }

  function onPointerDown(e: PointerEvent) {
    if (current.disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    activePointer = e.pointerId;
    try {
      node.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety, the drag still works without it */
    }
    // Stops the browser from starting a text selection or an image drag mid-scrub.
    e.preventDefault();
    current.onStart?.();
    current.onChange(ratioFor(e.clientX));
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || e.pointerId !== activePointer) return;
    current.onChange(ratioFor(e.clientX));
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    finish(e.clientX, e.pointerId);
  }

  function onPointerCancel(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    finish(e.clientX, e.pointerId);
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerCancel);

  return {
    update(next: DragValueParams) {
      current = next;
    },
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}
