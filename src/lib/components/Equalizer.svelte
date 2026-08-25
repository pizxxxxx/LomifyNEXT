<script lang="ts">
  import { RotateCcw, SlidersHorizontal, Sparkles, Waves } from 'lucide-svelte';
  import { activeEqualizerPreset, equalizerBands } from '$lib/stores';

  const frequencies = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

  const presets = [
    { id: 'flat', label: 'Ровно', hint: 'Без коррекции', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bass', label: 'Бас', hint: 'Плотный низ', gains: [6, 5, 4, 2, 0, -1, -2, -3, -4, -5] },
    { id: 'electronic', label: 'Электроника', hint: 'Удар и воздух', gains: [5, 4, 1, 0, -2, -1, 2, 4, 5, 6] },
    { id: 'vocal', label: 'Вокал', hint: 'Голос ближе', gains: [-2, -1, 0, 2, 4, 5, 4, 2, 0, -2] },
    { id: 'rock', label: 'Рок', hint: 'Гитары и атака', gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
    { id: 'priora', label: 'Приора', hint: 'Под окном', gains: [12, 12, 12, 12, 5, -12, -12, -12, -12, -12] },
  ] as const;

  function setPreset(preset: typeof presets[number]) {
    $equalizerBands = [...preset.gains];
    $activeEqualizerPreset = preset.id;
  }

  function resetEq() {
    setPreset(presets[0]);
  }

  function markCustom() {
    $activeEqualizerPreset = 'custom';
  }

  function formatGain(value: number) {
    const gain = Number(value) || 0;
    return `${gain > 0 ? '+' : ''}${gain.toFixed(1)}`;
  }

  function bandPosition(value: number) {
    return ((Number(value) + 12) / 24) * 100;
  }

  function accentStart(value: number) {
    return Math.min(50, bandPosition(value));
  }

  function accentSize(value: number) {
    return Math.abs(50 - bandPosition(value));
  }

  $: activeLabel = $activeEqualizerPreset === 'custom'
    ? 'Свой профиль'
    : presets.find((preset) => preset.id === $activeEqualizerPreset)?.label || 'Ровно';
</script>

<div class="eq-page">
  <header class="eq-header">
    <div class="eq-title-block">
      <span class="eq-kicker"><SlidersHorizontal size={14} aria-hidden="true" /> Звук</span>
      <h1 class="page-title">Эквалайзер</h1>
      <p>Десять полос от глубокого баса до воздуха. Изменения слышны сразу.</p>
    </div>

    <div class="eq-header-actions">
      <div class="eq-active" aria-live="polite">
        <Sparkles size={14} aria-hidden="true" />
        <span>{activeLabel}</span>
      </div>
      <button type="button" class="eq-reset" on:click={resetEq}>
        <RotateCcw size={16} aria-hidden="true" />
        Сбросить
      </button>
    </div>
  </header>

  <section class="eq-presets" aria-label="Готовые настройки эквалайзера">
    {#each presets as preset}
      <button
        type="button"
        class="eq-preset"
        class:is-active={$activeEqualizerPreset === preset.id}
        aria-pressed={$activeEqualizerPreset === preset.id}
        on:click={() => setPreset(preset)}
      >
        <span class="eq-preset-icon" aria-hidden="true"><Waves size={15} /></span>
        <span class="eq-preset-copy">
          <strong>{preset.label}</strong>
          <small>{preset.hint}</small>
        </span>
      </button>
    {/each}
  </section>

  <section class="eq-board plate" aria-label="Полосы эквалайзера">
    <div class="eq-board-head">
      <div>
        <span>Точная настройка</span>
        <small>Диапазон каждой полосы: −12…+12 дБ</small>
      </div>
      <span class="eq-unit">дБ</span>
    </div>

    <div class="eq-chart">
      <div class="eq-scale" aria-hidden="true">
        <span>+12</span>
        <span>+6</span>
        <span>0</span>
        <span>−6</span>
        <span>−12</span>
      </div>

      <div class="eq-board-scroll">
        <div class="eq-guides" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i>
        </div>

        <div class="eq-bands">
          {#each $equalizerBands as band, i}
            <div class="eq-band" class:is-changed={Number(band) !== 0}>
              <output class="eq-value" for={`eq-band-${i}`}>{formatGain(Number(band))}</output>

              <div class="eq-control">
                <div class="eq-rail" aria-hidden="true">
                  <span
                    class="eq-accent"
                    style={`bottom:${accentStart(Number(band))}%;height:${accentSize(Number(band))}%`}
                  ></span>
                  <span class="eq-zero"></span>
                </div>
                <input
                  id={`eq-band-${i}`}
                  type="range"
                  min="-12"
                  max="12"
                  step="0.1"
                  bind:value={$equalizerBands[i]}
                  on:input={markCustom}
                  aria-label={`${frequencies[i]} Гц, ${formatGain(Number(band))} децибел`}
                />
              </div>

              <div class="eq-frequency">
                <strong>{frequencies[i]}</strong>
                <small>{i < 5 ? 'Гц' : 'кГц'}</small>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </section>
</div>

<style>
  .eq-page {
    width: 100%;
    max-width: 1120px;
    margin: 0 auto;
    padding: 16px 0 40px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  .eq-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
  }

  .eq-title-block {
    min-width: 0;
  }

  .eq-kicker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 9px;
    color: color-mix(in srgb, var(--color-primary) 65%, white);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .eq-title-block :global(.page-title) {
    margin: 0;
  }

  .eq-title-block p {
    max-width: 58ch;
    margin: 10px 0 0;
    color: rgba(255, 255, 255, 0.5);
    font-size: 13.5px;
    line-height: 1.5;
  }

  .eq-header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
  }

  .eq-active,
  .eq-reset {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 650;
  }

  .eq-active {
    padding: 0 14px;
    color: color-mix(in srgb, var(--color-primary) 46%, white);
    background: color-mix(in srgb, var(--color-primary) 12%, rgba(255, 255, 255, 0.035));
    border: 1px solid color-mix(in srgb, var(--color-primary) 20%, rgba(255, 255, 255, 0.06));
  }

  .eq-reset {
    padding: 0 15px;
    color: rgba(255, 255, 255, 0.68);
    background: rgba(255, 255, 255, 0.055);
    border: 1px solid rgba(255, 255, 255, 0.08);
    cursor: pointer;
    transition: color 160ms var(--ease-out), background-color 160ms var(--ease-out);
  }

  .eq-reset:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.1);
  }

  .eq-reset:focus-visible,
  .eq-preset:focus-visible,
  .eq-control input:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }

  .eq-presets {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 9px;
  }

  .eq-preset {
    min-width: 0;
    min-height: 62px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 11px;
    border-radius: 15px;
    color: rgba(255, 255, 255, 0.65);
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid rgba(255, 255, 255, 0.065);
    text-align: left;
    cursor: pointer;
    transition:
      color 160ms var(--ease-out),
      background-color 160ms var(--ease-out),
      border-color 160ms var(--ease-out);
  }

  .eq-preset:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.065);
  }

  .eq-preset.is-active {
    color: #fff;
    background: color-mix(in srgb, var(--color-primary) 12%, rgba(255, 255, 255, 0.035));
    border-color: color-mix(in srgb, var(--color-primary) 26%, rgba(255, 255, 255, 0.06));
  }

  .eq-preset-icon {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border-radius: 10px;
    color: rgba(255, 255, 255, 0.48);
    background: rgba(255, 255, 255, 0.055);
  }

  .eq-preset.is-active .eq-preset-icon {
    color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 14%, rgba(255, 255, 255, 0.045));
  }

  .eq-preset-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .eq-preset-copy strong,
  .eq-preset-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .eq-preset-copy strong {
    font-size: 12.5px;
    font-weight: 700;
  }

  .eq-preset-copy small {
    color: rgba(255, 255, 255, 0.34);
    font-size: 10px;
  }

  .eq-board {
    padding: 22px 24px 20px;
    overflow: hidden;
  }

  .eq-board-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }

  .eq-board-head > div {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .eq-board-head span {
    color: rgba(255, 255, 255, 0.86);
    font-size: 13.5px;
    font-weight: 700;
  }

  .eq-board-head small,
  .eq-unit {
    color: rgba(255, 255, 255, 0.36) !important;
    font-size: 10.5px !important;
    font-weight: 600 !important;
  }

  .eq-unit {
    padding-top: 2px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .eq-chart {
    position: relative;
    padding-left: 36px;
  }

  .eq-scale {
    position: absolute;
    inset: 27px auto 42px 0;
    width: 29px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    color: rgba(255, 255, 255, 0.28);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .eq-board-scroll {
    position: relative;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-inline: contain;
    scrollbar-width: thin;
  }

  .eq-guides {
    position: absolute;
    z-index: 0;
    top: 27px;
    right: 0;
    bottom: 42px;
    left: 0;
    min-width: 720px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;
  }

  .eq-guides i {
    display: block;
    width: 100%;
    height: 1px;
    background: rgba(255, 255, 255, 0.05);
  }

  .eq-guides i:nth-child(3) {
    background: rgba(255, 255, 255, 0.12);
  }

  .eq-bands {
    position: relative;
    z-index: 1;
    min-width: 720px;
    display: grid;
    grid-template-columns: repeat(10, minmax(62px, 1fr));
    gap: 8px;
  }

  .eq-band {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .eq-value {
    min-width: 45px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 3px;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.48);
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid transparent;
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    transition: color 150ms var(--ease-out), background-color 150ms var(--ease-out);
  }

  .eq-band.is-changed .eq-value {
    color: color-mix(in srgb, var(--color-primary) 42%, white);
    background: color-mix(in srgb, var(--color-primary) 10%, rgba(255, 255, 255, 0.035));
  }

  .eq-control {
    position: relative;
    width: 48px;
    height: 290px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .eq-rail {
    position: absolute;
    inset: 7px auto;
    width: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.34);
    border: 1px solid rgba(255, 255, 255, 0.07);
    box-shadow: inset 0 1px 6px rgba(0, 0, 0, 0.45);
  }

  .eq-accent {
    position: absolute;
    right: 0;
    left: 0;
    min-height: 1px;
    background: linear-gradient(to top, color-mix(in srgb, var(--color-primary) 55%, transparent), var(--color-primary));
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-primary) 28%, transparent);
  }

  .eq-zero {
    position: absolute;
    top: 50%;
    right: -2px;
    left: -2px;
    height: 1px;
    background: rgba(255, 255, 255, 0.28);
  }

  .eq-control input {
    position: relative;
    z-index: 2;
    width: 48px;
    height: 290px;
    margin: 0;
    appearance: none;
    -webkit-appearance: none;
    writing-mode: vertical-lr;
    direction: rtl;
    background: transparent;
    cursor: ns-resize;
    touch-action: none;
  }

  .eq-control input::-webkit-slider-runnable-track {
    width: 6px;
    height: 100%;
    background: transparent;
    border: 0;
  }

  .eq-control input::-webkit-slider-thumb {
    width: 23px;
    height: 23px;
    margin-left: -8px;
    appearance: none;
    -webkit-appearance: none;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--color-primary) 62%, white);
    background: #17171c;
    box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.24), 0 0 18px color-mix(in srgb, var(--color-primary) 28%, transparent);
  }

  .eq-control input:hover::-webkit-slider-thumb {
    border-color: #fff;
  }

  .eq-frequency {
    display: flex;
    align-items: baseline;
    gap: 3px;
    margin-top: 7px;
    color: rgba(255, 255, 255, 0.72);
  }

  .eq-frequency strong {
    font-size: 12px;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }

  .eq-frequency small {
    color: rgba(255, 255, 255, 0.28);
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
  }

  @media (max-width: 980px) {
    .eq-presets {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (max-width: 700px) {
    .eq-page {
      padding-top: 4px;
    }
    .eq-header {
      align-items: flex-start;
      flex-direction: column;
    }
    .eq-header-actions {
      width: 100%;
      justify-content: space-between;
    }
    .eq-presets {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .eq-board {
      padding-inline: 16px;
    }
    .eq-control,
    .eq-control input {
      height: 250px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .eq-reset,
    .eq-preset,
    .eq-value {
      transition: none;
    }
  }
</style>
