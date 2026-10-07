<script lang="ts">
  import { onMount } from 'svelte';
  import { X } from 'lucide-svelte';
  import Settings from './Settings.svelte';
  import { isChangelogModalOpen } from '$lib/changelog';
  import { effectivePerformanceMode } from '$lib/stores';
  let { onclose }: { onclose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let closing = $state(false);
  let animations: Animation[] = [];
  let generation = 0;
  let disposed = false;

  function cancelMotion() {
    generation++;
    for (const animation of animations) animation.cancel();
    animations = [];
  }

  async function dissolve(opening: boolean) {
    const columns = [...dialog.querySelectorAll<HTMLElement>('.lg-settings-nav, .settings-page > h2, .settings-tab-panels')];
    const nodes: HTMLElement[] = [dialog, ...columns];
    // Read the current pose before cancellation so closing during entry never jumps.
    const current = nodes.map(node => {
      const style = getComputedStyle(node);
      return { opacity: style.opacity, transform: style.transform, filter: style.filter };
    });
    cancelMotion();
    const run = generation;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = $effectivePerformanceMode ? 0 : reduced ? 100 : 250;
    if (!duration) return true;
    const easing = getComputedStyle(dialog).getPropertyValue('--lg-spring').trim() || 'ease-out';
    animations = nodes.map((node, index) => {
      const spread = index === 0 ? 'scale(1.015)' : `translateX(${node.matches('.lg-settings-nav') ? -7 : 7}px)`;
      const dissolved = {
        opacity: index === 0 ? 0 : 1,
        transform: reduced ? 'none' : spread,
        filter: index === 0 && !reduced ? 'blur(5px)' : 'none'
      };
      const solid = { opacity: 1, transform: 'none', filter: 'none' };
      return node.animate([opening ? dissolved : current[index], opening ? solid : dissolved], {
        duration, easing: reduced ? 'ease-out' : easing, fill: 'both'
      });
    });
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    if (disposed || run !== generation) return false;
    cancelMotion();
    return true;
  }

  async function closeSettings() {
    if (closing || disposed) return;
    closing = true;
    if (await dissolve(false)) onclose();
  }

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    const unsubscribe = isChangelogModalOpen.subscribe(open => {
      if (open) { cancelMotion(); dialog.close(); if (closing) onclose(); }
      else if (!dialog.open && !closing) { dialog.showModal(); void dissolve(true); }
    });
    return () => {
      disposed = true;
      cancelMotion();
      unsubscribe();
      dialog.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  });
</script>
<dialog bind:this={dialog} class="lg-settings-dialog" aria-label="Настройки" aria-busy={closing} onkeydown={event => event.stopPropagation()} oncancel={event => { event.preventDefault(); void closeSettings(); }} onclick={event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) void closeSettings();
}}>
  <button class="lg-settings-close" aria-label="Закрыть настройки" disabled={closing} onclick={closeSettings}><X size={18} /></button>
  <div class="lg-settings-content" inert={closing}><Settings inDialog={true} /></div>
</dialog>
