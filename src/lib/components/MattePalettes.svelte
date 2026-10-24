<script lang="ts">
  import { Check } from 'lucide-svelte';
  import { settings } from '$lib/stores';
  import { MATTE_PALETTES } from '$lib/mattePalettes';
</script>
<fieldset class="matte-palettes"><legend>Палитра матового стиля</legend><p>Шесть цветовых пар. Цвета остаются постоянными при смене обложки.</p><div class="palette-grid">
  {#each MATTE_PALETTES as palette (palette.id)}
    <button type="button" style:--palette-bg={palette.background} style:--palette-primary={palette.primary} style:--palette-accent={palette.accent} aria-pressed={$settings.mattePalette === palette.id} onclick={() => settings.update(value => ({ ...value, mattePalette: palette.id }))}>
      <span class="palette-preview" aria-hidden="true"><i></i><b></b><small>{#if $settings.mattePalette === palette.id}<Check size={14} />{/if}</small></span><strong>{palette.name}</strong><span class="palette-values">{palette.background} + {palette.primary}</span>
    </button>
  {/each}
</div><label class="matte-blur-switch"><input type="checkbox" bind:checked={$settings.matteBlur} />Размытие панелей</label><p>В режиме производительности размытие временно отключается.</p></fieldset>
<style>
  fieldset { margin-top:24px; } legend { font-size:14px; font-weight:650; } p { font-size:12px; line-height:1.6; color:#b8b2bf; margin-block:8px 16px; }
  .palette-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,165px),1fr)); gap:10px; }
  button { border:1px solid #ffffff20; border-radius:12px; background:#ffffff03; padding:9px; text-align:left; min-width:0; }
  button[aria-pressed="true"] { border-color:var(--palette-accent); box-shadow:0 0 0 1px var(--palette-accent); }
  button:hover { background:#ffffff0a; } button strong { display:block; font-size:12px; font-weight:550; margin-top:9px; }
  .palette-values { display:block; font-size:10px; color:#b8b2bf; margin-top:4px; }
  .palette-preview { position:relative; display:block; height:54px; border-radius:7px; overflow:hidden; background:var(--palette-bg); }
  i { position:absolute; right:0; top:0; bottom:0; width:38%; background:var(--palette-primary); }
  b { position:absolute; left:11px; top:16px; width:32%; height:5px; border-radius:5px; background:var(--palette-accent); }
  small { position:absolute; right:8px; bottom:8px; display:grid; place-items:center; border-radius:50%; width:21px; height:21px; color:var(--palette-bg); background:var(--palette-accent); }
  small:empty { display:none; } .matte-blur-switch { margin-top:20px; display:flex; align-items:center; gap:10px; font-size:13px; } input { accent-color:var(--color-primary); }
</style>
