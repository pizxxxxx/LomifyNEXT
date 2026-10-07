<script lang="ts">
  import { notifications, dismissNotification, currentView, effectivePerformanceMode, settings } from '$lib/stores';
  import { CheckCircle2, AlertCircle, Info, X } from 'lucide-svelte';
  import { flip } from 'svelte/animate';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  let root = $state<HTMLDivElement>();
  let reduced = $state(false);
  let shapes = $state<{ id: number; top: number; height: number }[]>([]);
  let height = $state(0);
  $effect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => reduced = query.matches;
    sync(); query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  });
  $effect(() => {
    if (!root) return;
    const panel = root;
    const measure = () => {
      height = panel.offsetHeight;
      shapes = Array.from(panel.querySelectorAll<HTMLElement>('[data-notice-id]')).map(row => {
        const top = row.offsetTop - panel.scrollTop;
        return { id: Number(row.dataset.noticeId), top: Math.max(0, top), height: Math.max(0, Math.min(top + row.offsetHeight, panel.clientHeight) - Math.max(0, top)) };
      }).filter(shape => shape.height > 0);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(panel);
    // Text/actions can wrap without changing the overall number of notices.
    const mutation = new MutationObserver(measure);
    mutation.observe(panel, { childList: true, subtree: true, characterData: true });
    panel.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => { resize.disconnect(); mutation.disconnect(); panel.removeEventListener('scroll', measure); };
  });
  const flat = $derived($effectivePerformanceMode || $settings.glassQuality === 'off');
  function droplet(_node: Element) {
    return { duration: reduced ? 0 : 340, easing: cubicOut, css: (t: number) => `transform:translateY(${(1 - t) * -52}px) scale(${.82 + .18 * t});opacity:${t}` };
  }
</script>

{#if $notifications.length}
  <div class="lg-notices" class:is-fullscreen={$currentView === 'fullscreen'} class:is-flat={flat}>
    <div class="lg-notice-fluid" style={`height:${height}px;filter:${reduced || flat ? 'none' : 'url(#lomify-notice-merge)'}`} aria-hidden="true">
      {#each shapes as shape (shape.id)}
        <div class="lg-notice-drop" style={`top:${shape.top}px;height:${shape.height}px`} in:droplet out:fly={{ y: -12, duration: reduced ? 0 : 160 }}></div>
      {/each}
    </div>
    <div class="lg-notice-panel" bind:this={root} role="status" aria-live="polite" aria-relevant="additions text">
      {#each $notifications as notification (notification.id)}
        <div class="lg-notice-row" data-notice-id={notification.id} animate:flip={{ duration: reduced ? 0 : 240 }} in:fly={{ y: reduced ? 0 : -16, duration: reduced ? 0 : 280, easing: cubicOut }} out:fly={{ y: reduced ? 0 : -8, duration: reduced ? 0 : 150 }}>
          {#if notification.type === 'success'}<CheckCircle2 size={17} class="lg-notice-success" />{:else if notification.type === 'error'}<AlertCircle size={17} class="lg-notice-error" />{:else}<Info size={17} />{/if}
          <span>{notification.message}</span>
          {#if notification.action}<button class="lg-notice-action" data-press-late onclick={() => { notification.action?.run(); dismissNotification(notification.id); }}>{notification.action.label}</button>{/if}
          <button class="lg-notice-dismiss" data-press-late aria-label={`Закрыть уведомление: ${notification.message}`} onclick={() => dismissNotification(notification.id)}><X size={14} /></button>
        </div>
      {/each}
    </div>
  </div>
{/if}
<svg width="0" height="0" aria-hidden="true" class="lg-notice-defs">
  <filter id="lomify-notice-merge" x="-15%" y="-100%" width="130%" height="300%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="soft" />
    <feColorMatrix in="soft" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
  </filter>
</svg>

<style>
  .lg-notices { position: fixed; z-index: 130; top: 16px; left: calc(var(--lg-sidebar-width) + var(--lg-gap) + 14px); right: calc(var(--lg-queue-width) + var(--lg-gap) + 14px); display: grid; justify-items: center; pointer-events: none; }
  .lg-notices.is-fullscreen { left: 16px; right: 16px; }
  .lg-notice-fluid, .lg-notice-panel { width: min(460px, 100%); }
  .lg-notice-fluid { position: absolute; top: 0; left: 50%; transform: translateX(-50%); z-index: -1; pointer-events: none; }
  .lg-notice-drop { position: absolute; left: 0; width: 100%; border-radius: 24px; background: #222126; box-shadow: inset 0 1px 0 rgb(255 255 255 / 20%); }
  .lg-notice-panel { position: relative; pointer-events: auto; isolation: isolate; max-height: min(360px, 45vh); overflow-y: auto; scrollbar-width: thin; border-radius: 24px; background: rgb(19 18 23 / 62%); border: 1px solid rgb(255 255 255 / 18%); box-shadow: 0 12px 32px rgb(0 0 0 / 35%); backdrop-filter: blur(12px) saturate(1.2); }
  .lg-notice-row { display: flex; align-items: center; gap: 9px; padding: 12px 13px; min-height: 46px; color: #eee9ef; font-size: 12px; line-height: 1.4; }
  .lg-notice-row > :global(svg) { flex-shrink: 0; color: #bed2ed; }
  .lg-notice-row > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .lg-notice-row > :global(.lg-notice-success) { color: var(--lg-accent); }
  .lg-notice-row > :global(.lg-notice-error) { color: #f89099; }
  .lg-notice-row + .lg-notice-row { border-top: 1px solid rgb(255 255 255 / 7%); }
  .lg-notice-action { flex-shrink: 0; padding: 5px 9px; color: var(--lg-accent); border: 1px solid var(--lg-edge); border-radius: 999px; font-weight: 600; }
  .lg-notice-dismiss { display: grid; place-items: center; flex-shrink: 0; width: 23px; height: 23px; border-radius: 50%; color: #aaa4b0; }
  .lg-notice-dismiss:hover { background: rgb(255 255 255 / 8%); color: white; }
  .lg-notices.is-flat .lg-notice-panel { backdrop-filter: none; background: #222126; box-shadow: none; }
  .lg-notice-defs { position: absolute; pointer-events: none; }
</style>
