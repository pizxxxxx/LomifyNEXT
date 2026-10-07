<script lang="ts">
  import { settings } from '$lib/stores';
  import { glassPanelDragWidth } from '$lib/liquidGlass';
  let handle = $state<HTMLDivElement>();
  let width = $state(248);
  let viewport = $state(typeof window === 'undefined' ? 1400 : window.innerWidth);
  let drag: { id: number; x: number; width: number } | null = null;
  function maximum() {
    const sidebar = document.querySelector('.lg-sidebar')?.getBoundingClientRect().width || 0;
    return Math.max(180, Math.min(560, viewport - sidebar - 430));
  }
  const bounded = (value: number) => Math.round(Math.max(180, Math.min(maximum(), value)));
  $effect(() => {
    const panel = handle?.closest('aside');
    if (!panel) return;
    const observer = new ResizeObserver(() => width = Math.round(panel.getBoundingClientRect().width));
    observer.observe(panel);
    return () => { observer.disconnect(); glassPanelDragWidth.set(null); };
  });
  function start(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, width };
    event.currentTarget && (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (drag?.id === event.pointerId) glassPanelDragWidth.set(bounded(drag.width + drag.x - event.clientX));
  }
  function finish(event: PointerEvent) {
    if (drag?.id !== event.pointerId) return;
    const next = bounded(drag.width + drag.x - event.clientX);
    settings.update(value => ({ ...value, glassPanelWidth: next }));
    drag = null;
    glassPanelDragWidth.set(null);
    if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }
  function key(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 180 : event.key === 'End' ? maximum() : width + (event.key === 'ArrowLeft' ? 24 : -24);
    settings.update(value => ({ ...value, glassPanelWidth: bounded(next) }));
  }
</script>
<svelte:window onresize={() => viewport = window.innerWidth} />
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (A focusable WAI-ARIA window splitter supports arrow keys.) -->
<div bind:this={handle} class="lg-panel-resize" role="separator" tabindex="0" aria-controls="lomify-side-panel" aria-label="Ширина боковой панели" aria-orientation="vertical" aria-valuemin="180" aria-valuemax={maximum()} aria-valuenow={width} title="Потяни для изменения ширины. Двойной щелчок вернёт обычную ширину."
  onpointerdown={start} onpointermove={move} onpointerup={finish} onpointercancel={() => { drag = null; glassPanelDragWidth.set(null); }} onkeydown={key} ondblclick={() => settings.update(value => ({ ...value, glassPanelWidth: null }))}></div>
