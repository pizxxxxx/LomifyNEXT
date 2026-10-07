<script lang="ts">
  import { Music2 } from 'lucide-svelte';
  import MusicServiceIcon from './MusicServiceIcon.svelte';
  let { source, size = 13 }: { source?: string; size?: number } = $props();
  const label = $derived(source === 'yandex' ? 'Яндекс Музыка' : source === 'soundcloud' ? 'SoundCloud' : 'Локальный файл');
</script>
<span class="lg-source" title={label} aria-label={label} role="img">
  {#if source === 'soundcloud' || source === 'yandex'}<MusicServiceIcon service={source} {size} />{:else}<Music2 {size} />{/if}
</span>
