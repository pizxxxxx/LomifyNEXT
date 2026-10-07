<script lang="ts">
  import { Headphones, Check, Loader2 } from 'lucide-svelte';
  import { listOutputs, applyOutput, type AudioOutput } from '$lib/audioOutput';
  import { settings, notify, effectivePerformanceMode } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  let open = $state(false);
  let loading = $state(false);
  let outputs = $state.raw<AudioOutput[]>([]);
  let root: HTMLDivElement;
  async function toggle() {
    open = !open;
    if (!open) return;
    loading = true;
    try { outputs = await listOutputs(); }
    catch { notify('Не удалось получить устройства. Повтори попытку.', 'error'); }
    finally { loading = false; }
  }
  async function select(name: string | null, label: string) {
    loading = true;
    try {
      await applyOutput(name);
      settings.update(s => ({ ...s, outputDevice: name, outputDeviceLabel: label }));
      open = false;
    } catch { notify('Устройство недоступно. Проверь подключение и повтори выбор.', 'error'); }
    finally { loading = false; }
  }
</script>
<svelte:window onpointerdown={event => { if (event.target instanceof Node && !root?.contains(event.target)) open = false; }} onkeydowncapture={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); open = false; } }} />
<div class="lg-output" bind:this={root}>
  <button type="button" aria-label="Устройство вывода" title="Устройство вывода" aria-expanded={open} onclick={toggle}><Headphones size={16} /></button>
  {#if open}
    <div class="lg-popover lg-output-pop lg-optical" use:glassRefraction={$effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal'} role="dialog" aria-label="Устройство вывода">
      <strong>Устройство вывода</strong>
      {#if loading}<Loader2 size={18} class="animate-spin" />{:else}
        <button type="button" onclick={() => select(null, '')}>Системное устройство {#if !$settings.outputDevice}<Check size={14} />{/if}</button>
        {#each outputs as output (output.name)}<button type="button" onclick={() => select(output.name, output.description)}>{output.description}{#if $settings.outputDevice === output.name}<Check size={14} />{/if}</button>{/each}
      {/if}
    </div>
  {/if}
</div>
