<script lang="ts">
  import { fade } from 'svelte/transition';
  import { currentTrack, currentView, pageAtmosphere, settings } from '$lib/stores';
  import { mattePalette } from '$lib/mattePalettes';
  import { coverUrlAtSize, coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';
  import { extractGlassPalette, DEFAULT_GLASS_PALETTE } from '$lib/utils/glassPalette';
  const cover = $derived(coverUrlAtSize(($currentView === 'fullscreen' ? '' : $pageAtmosphere?.url) || coverUrlForTrack($currentTrack, $downloadedCoverCache), 200));
  let reduced = $state(false);
  $effect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => reduced = media.matches;
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  });
  $effect(() => {
    let active = true;
    if ($settings.glassMaterial === 'matte') {
      const palette = mattePalette($settings.mattePalette);
      for (const [key, value] of Object.entries({ accent: palette.accent, glow: palette.primary, shade: palette.background })) document.body.style.setProperty(`--lg-${key}`, value);
      document.body.style.setProperty('--matte-background', palette.background);
      document.body.style.setProperty('--matte-primary', palette.primary);
      return () => { active = false; };
    }
    const source = cover;
    void extractGlassPalette(source).then(palette => {
      if (!active) return;
      for (const [key, value] of Object.entries(palette)) document.body.style.setProperty(`--lg-${key}`, value);
    });
    return () => { active = false; };
  });
  $effect(() => () => {
    for (const key of Object.keys(DEFAULT_GLASS_PALETTE)) document.body.style.removeProperty(`--lg-${key}`);
    document.body.style.removeProperty('--matte-background'); document.body.style.removeProperty('--matte-primary');
  });
</script>

<div class="lg-backdrop" aria-hidden="true">
  {#key cover}
    {#if cover && $settings.glassMaterial !== 'matte'}<img src={cover} alt="" class="lg-backdrop-art" transition:fade={{ duration: reduced ? 0 : 620 }} />{/if}
  {/key}
  <div class="lg-backdrop-glow"></div>
  <div class="lg-backdrop-grain"></div>
</div>
