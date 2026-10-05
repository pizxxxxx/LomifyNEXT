<script lang="ts">
  import { localMixDay, type DailyMix } from '$lib/dailyMixesCore';
  let { mix, id }: { mix: DailyMix; id: string } = $props();
  const labels = { favorites: 'для\nтебя', repeat: 'на\nповторе', discover: 'новые\nоткрытия', releases: 'свежие\nрелизы' };
  const date = $derived(mix.day === localMixDay() ? 'Сегодня' : new Date(`${mix.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }));
</script>

<div class="mix-poster" data-kind={mix.kind} data-mix-cover={id}>
  <svg class="mix-art" viewBox="0 0 280 280" aria-hidden="true">
    {#if mix.kind === 'favorites'}
      {#each [48, 80, 112, 144] as radius}<circle cx="215" cy="65" r={radius} fill="none" stroke="currentColor" stroke-width="2" />{/each}
      <path d="m120 28 13 39 42 12-39 13-12 42-14-39-42-13 39-13Z" fill="currentColor" />
    {:else if mix.kind === 'repeat'}
      {#each [44, 68, 92, 116, 140, 164] as radius}<circle cx="230" cy="55" r={radius} fill="none" stroke="currentColor" stroke-width="2" />{/each}
      <path d="m77 17 19 3-7 19M185 251l-19-3 7-19" fill="none" stroke="currentColor" stroke-width="3" />
    {:else if mix.kind === 'discover'}
      <path d="m160 18 23 68 73 21-68 23-21 74-24-68-73-22 68-24Z" fill="currentColor" />
      <circle cx="105" cy="188" r="110" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="105" cy="188" r="84" fill="none" stroke="currentColor" stroke-width="1.5" />
    {:else}
      {#each [0, 1, 2, 3, 4] as index}<path d={`M${80 + index * 28} -20Q${190 - index * 28} 115 ${80 + index * 28} 300`} fill="none" stroke="currentColor" stroke-width="13" />{/each}
    {/if}
  </svg>
  <span class="mix-poster-top">{date}</span>
  <strong class="mix-poster-title">{labels[mix.kind]}</strong>
  <span class="mix-poster-brand">LOMIFY</span>
</div>

<style>
  .mix-poster { position: relative; width: 100%; aspect-ratio: 1; container-type: inline-size; overflow: hidden; border-radius: 1.15rem; isolation: isolate; color: white; background: linear-gradient(135deg, #db4b68, #86243e); }
  .mix-poster[data-kind="repeat"] { background: linear-gradient(135deg, #686bb7, #353861); }
  .mix-poster[data-kind="discover"] { background: linear-gradient(135deg, #299190, #164e61); }
  .mix-poster[data-kind="releases"] { color: #1e3c2d; background: linear-gradient(135deg, #c2d887, #8bb299); }
  .mix-art { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .2; }
  .mix-poster-top { position: absolute; top: 9%; left: 9%; font-size: 5cqi; font-weight: 650; letter-spacing: .02em; }
  .mix-poster-title { position: absolute; left: 9%; right: 7%; bottom: 20%; font-size: 21cqi; font-weight: 850; line-height: .95; letter-spacing: -.06em; white-space: pre-line; text-align: left; }
  .mix-poster[data-kind="discover"] .mix-poster-title { font-size: 16.8cqi; line-height: 1.03; letter-spacing: -.045em; }
  .mix-poster[data-kind="releases"] .mix-poster-title { font-size: 19cqi; }
  .mix-poster-brand { position: absolute; bottom: 8%; left: 9%; font-size: 4cqi; font-weight: 750; letter-spacing: .15em; opacity: .75; }
</style>
