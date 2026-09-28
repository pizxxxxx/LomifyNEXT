<script lang="ts">
  import { activeBackdropAdlib, departingBackdropAdlib, settings } from '$lib/stores';
  import { getBackdropFontSize } from '$lib/lyrics';

  export let isFullscreen = false;
</script>

{#if $settings.lyricsAdlibs !== false && $settings.lyricsAdlibStyle === 'backdrop'}
  <div
    class="lyrics-backdrop-stage"
    class:is-fullscreen={isFullscreen}
    aria-hidden="true"
  >
    {#if $activeBackdropAdlib}
      {#key $activeBackdropAdlib.id}
        <div
          class="lyrics-backdrop-callout is-active is-{$activeBackdropAdlib.side}"
          class:is-long={$activeBackdropAdlib.text.length > 14}
          style="--backdrop-font-size: {getBackdropFontSize($activeBackdropAdlib.text)}; --base-x: {$activeBackdropAdlib.xOffsetVw}vw; --base-y: {$activeBackdropAdlib.yOffsetPx}px; --base-rotate: {$activeBackdropAdlib.rotateDeg}deg;"
        >
          <span class="lyrics-backdrop-text">{$activeBackdropAdlib.text}</span>
        </div>
      {/key}
    {/if}
    {#if $departingBackdropAdlib}
      {#key $departingBackdropAdlib.id}
        <div
          class="lyrics-backdrop-callout is-departing is-{$departingBackdropAdlib.side}"
          class:is-long={$departingBackdropAdlib.text.length > 14}
          style="--backdrop-font-size: {getBackdropFontSize($departingBackdropAdlib.text)}; --base-x: {$departingBackdropAdlib.xOffsetVw}vw; --base-y: {$departingBackdropAdlib.yOffsetPx}px; --base-rotate: {$departingBackdropAdlib.rotateDeg}deg;"
        >
          <span class="lyrics-backdrop-text">{$departingBackdropAdlib.text}</span>
        </div>
      {/key}
    {/if}
  </div>
{/if}
