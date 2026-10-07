<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Loader2, Radio } from 'lucide-svelte';
  import { currentView } from '$lib/stores';
  import { startWave } from '$lib/wave';

  let { track, buttonClass = '', iconSize = 18, label = '' }: {
    track: { id?: string | number; title: string; artist?: string; source: string };
    buttonClass?: string;
    iconSize?: number;
    label?: string;
  } = $props();

  let starting = $state(false);
  let controller: AbortController | null = null;

  async function play(event: MouseEvent) {
    event.stopPropagation();
    if (starting) return;
    const request = new AbortController();
    controller = request;
    starting = true;
    try {
      if (await startWave(track, { signal: request.signal })) currentView.set('home');
    } finally {
      if (controller === request) {
        starting = false;
        controller = null;
      }
    }
  }

  onDestroy(() => controller?.abort());
</script>

{#if track.source === 'yandex' || track.source === 'soundcloud'}
  <button
    type="button"
    class={`${buttonClass} ui-tip`}
    aria-label={`Моя волна по треку: ${track.title}`}
    aria-busy={starting}
    data-tip={starting ? 'Собираю волну по треку...' : 'Моя волна по треку'}
    disabled={starting}
    onclick={play}
  >
    {#if starting}<Loader2 size={iconSize} class="animate-spin" />{:else}<Radio size={iconSize} />{/if}
    {#if label}<span>{starting ? 'Собираю волну...' : label}</span>{/if}
  </button>
{/if}
