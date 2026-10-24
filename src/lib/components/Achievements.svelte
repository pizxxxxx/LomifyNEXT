<script lang="ts">
  import { Trophy, Headphones, Music2, Compass, Heart, ListMusic, Users, Check } from 'lucide-svelte';
  import { achievements } from '$lib/achievements';
  let onlyUnlocked = $state(false);
  const icons = { time: Headphones, music: Music2, explore: Compass, heart: Heart, playlist: ListMusic, artists: Users };
  const earned = $derived($achievements.filter(item => item.unlocked).length);
  const visible = $derived(onlyUnlocked ? $achievements.filter(item => item.unlocked) : $achievements);
  function amount(value: number, metric: string) {
    return metric === 'seconds' ? `${Math.floor(value / 3600)} ч ${Math.floor(value % 3600 / 60)} мин` : value.toLocaleString('ru-RU');
  }
</script>
<section class="achievements-section" aria-labelledby="achievements-title">
  <header><div><span class="profile-section-kicker">Твой путь в музыке</span><h2 id="achievements-title" class="section-title"><Trophy size={19} aria-hidden="true" />Достижения <small>{earned} / {$achievements.length}</small></h2></div><button type="button" class="glass-button" aria-pressed={onlyUnlocked} onclick={() => onlyUnlocked = !onlyUnlocked}>{onlyUnlocked ? 'Показать все' : 'Только открытые'}</button></header>
  <p class="achievement-hint">Часы и прослушивания берутся из статистики Lomify. Ранее накопленный прогресс тоже учитывается.</p>
  <div class="achievement-grid">
    {#each visible as item (item.id)}
      {@const Icon = icons[item.kind]}
      <article class="achievement-card" class:is-unlocked={item.unlocked}>
        <div class="achievement-icon"><Icon size={21} aria-hidden="true" />{#if item.unlocked}<Check class="achievement-check" size={12} aria-hidden="true" />{/if}</div>
        <h3>{item.title}</h3><p>{item.description}</p>
        <div class="achievement-progress"><span>{item.unlocked ? 'Открыто' : amount(item.value, item.metric)}</span><span>{amount(item.goal, item.metric)}</span></div>
        <progress max={item.goal} value={item.unlocked ? item.goal : item.value} aria-label={item.description}>{Math.floor(item.value / item.goal * 100)}%</progress>
      </article>
    {:else}<p class="achievement-hint">Пока нет открытых достижений. Первое появится после засчитанного прослушивания.</p>{/each}
  </div>
</section>
<style>
  .achievements-section { margin-block: 36px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  h2 { display:flex; gap:9px; align-items:center; flex-wrap:wrap; }
  h2 small { font-size:12px; color:#aaa5b0; font-weight:500; }
  header button { padding:8px 12px; border-radius:10px; font-size:12px; }
  .achievement-hint { font-size:12px; color:#aaa5b0; line-height:1.6; margin:12px 0 18px; }
  .achievement-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr)); gap:12px; }
  .achievement-card { padding:18px; border:1px solid #ffffff14; border-radius:16px; background:#ffffff04; min-width:0; }
  .achievement-card.is-unlocked { border-color:color-mix(in srgb,var(--color-primary) 32%,transparent); background:color-mix(in srgb,var(--color-primary) 6%,transparent); }
  .achievement-icon { position:relative; width:38px; height:38px; border-radius:12px; display:grid; place-items:center; color:#aaa5b0; background:#ffffff09; margin-bottom:14px; }
  .is-unlocked .achievement-icon { color:var(--color-primary); }
  .achievement-icon :global(.achievement-check) { position:absolute; bottom:-3px; right:-3px; color:#111; background:var(--color-primary); border-radius:50%; padding:2px; box-sizing:content-box; }
  h3 { font-size:14px; font-weight:650; margin-bottom:5px; overflow-wrap:anywhere; }
  .achievement-card p { color:#aaa5b0; font-size:12px; min-height:38px; line-height:1.6; }
  .achievement-progress { display:flex; justify-content:space-between; gap:8px; font-size:11px; color:#bab5c0; margin-top:16px; font-variant-numeric:tabular-nums; }
  progress { appearance:none; width:100%; height:4px; display:block; border:0; border-radius:5px; overflow:hidden; margin-top:7px; background:#ffffff12; accent-color:var(--color-primary); }
  progress::-webkit-progress-bar { background:#ffffff12; } progress::-webkit-progress-value { background:var(--color-primary); border-radius:5px; } progress::-moz-progress-bar { background:var(--color-primary); }
</style>
