<script lang="ts">
  import { notifications } from '$lib/stores';
  import { CheckCircle2, AlertCircle, Info } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut, cubicIn } from 'svelte/easing';

  /**
   * Уведомление приезжало снизу (`fly y:20`), а уходило растворением на месте — то есть
   * появлялось из угла экрана и исчезало ниоткуда. Путь входа и выхода должен совпадать:
   * если предмет пришёл снизу, туда же он и уходит, иначе взгляд не связывает исчезнувшую
   * плашку с той, что была.
   *
   * Уход быстрее прихода и на другой кривой: приходящему нужно дать себя прочитать, поэтому
   * он тормозит у цели (`cubicOut`), а уходящее уже прочитано — оно разгоняется прочь
   * (`cubicIn`). Одна и та же кривая в обе стороны читается как откат назад по той же
   * дорожке, а это другой смысл — «отменилось», а не «закончилось».
   */
  const ENTER = 300;
  const EXIT = 200;

  /**
   * При «меньше движения» плашка не едет, а просто проявляется: сдвиг обнуляется, а
   * длительности остаются — прозрачность и есть тот кроссфейд, которым положено заменять
   * перемещение. Читается на каждом переходе, а не один раз при загрузке: настройку системы
   * меняют не перезапуская приложение. Тот же приём, что в `sheen.ts` и `tilt.ts`.
   */
  function shift(): number {
    if (typeof window === 'undefined') return 20;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 20;
  }
</script>

<div class="fixed bottom-24 right-6 z-[110] flex flex-col gap-2 pointer-events-none">
  {#each $notifications as notification (notification.id)}
    <div
      in:fly={{ y: shift(), duration: ENTER, easing: cubicOut }}
      out:fly={{ y: shift(), duration: EXIT, easing: cubicIn }}
      class="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl glass-panel border {notification.type === 'success' ? 'border-primary/30 bg-primary/5' : notification.type === 'error' ? 'border-red-500/30 bg-red-500/5' : 'border-white/10'} min-w-[250px] backdrop-blur-xl"
    >
      {#if notification.type === 'success'}
        <CheckCircle2 size={18} class="text-primary" />
      {:else if notification.type === 'error'}
        <AlertCircle size={18} class="text-red-500" />
      {:else}
        <Info size={18} class="text-blue-400" />
      {/if}
      <span class="text-sm font-medium text-white">{notification.message}</span>
    </div>
  {/each}
</div>
