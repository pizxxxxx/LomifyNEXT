<script lang="ts">
  /**
   * Меню «в плейлист». Раньше это была одна и та же разметка, скопированная трижды, и все три
   * копии успели разойтись: в медиатеке — тёмная плашка без заголовка, раскрывалась по
   * наведению; в плеере — та же по наведению, но другого цвета и с заголовком; в поиске — по
   * клику и с третьим набором отступов. Наведение здесь худший из вариантов: меню исчезало
   * от любого движения мыши мимо, а выбрать в нём плейлист можно только доехав до строки.
   *
   * Один компонент на все места: клик открывает, клик вне и Esc закрывают, а оформление — то
   * же стекло, что у настроек в полноэкранном режиме.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { Plus, Check, ListMusic } from 'lucide-svelte';
  import { cubicOut } from 'svelte/easing';
  import { playlists, notify } from '$lib/stores';

  export let track: any;
  /** Вверх — для нижних строк и плеера, вниз — для списков. */
  export let placement: 'top' | 'bottom' = 'bottom';
  export let align: 'left' | 'right' = 'right';
  export let iconSize = 18;
  /** Классы кнопки-открывашки: у каждого списка своя логика показа по наведению. */
  export let buttonClass = '';
  export let open = false;

  // Хозяину строки нужно знать про открытое меню: он поднимает строку по z-index и не
  // прячет ряд кнопок, пока меню на экране. Без этого меню закрывалось бы «само» от того,
  // что курсор ушёл со строки, а вместе с ней погас весь ряд.
  const dispatch = createEventDispatcher<{ toggle: boolean }>();

  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    dispatch('toggle', next);
  }

  function toggle(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!open);
  }

  let root: HTMLElement;

  function onDocPointerDown(e: PointerEvent) {
    if (root && !root.contains(e.target as Node)) setOpen(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') setOpen(false);
  }

  // Слушатели живут только у открытого меню: строк в списке сотни, и держать на каждой по
  // два обработчика окна — это те самые «сотни подписок ни для чего».
  function attach() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onKey);
  }

  function detach() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', onDocPointerDown, true);
    window.removeEventListener('keydown', onKey);
  }

  $: if (open) attach();
    else detach();

  onDestroy(detach);

  // Сравнение по id, а если его нет — по названию с автором. Локальные файлы и треки из
  // поиска приходят без id, поэтому одного признака мало.
  function same(a: any, b: any) {
    return (a?.id && b?.id && a.id === b.id) || (a?.title === b?.title && a?.artist === b?.artist);
  }

  function isIn(pl: any, t: any) {
    return Boolean(pl?.tracks?.some((x: any) => same(x, t)));
  }

  /**
   * Одно действие на оба случая: в плейлисте — убрать, нет — добавить. Раньше это были две
   * функции с `p[idx].tracks.push(track)` внутри `playlists.update` — то есть правка массива
   * на месте. Стор при этом рассылал ТОТ ЖЕ объект, и подписчики, сравнивающие по ссылке,
   * ничего не перерисовывали: галочка появлялась только после следующего чужого изменения.
   */
  function toggleMembership(e: MouseEvent, pl: any) {
    e.preventDefault();
    e.stopPropagation();
    const inside = isIn(pl, track);
    playlists.update(list =>
      list.map(p => {
        if (p.id !== pl.id) return p;
        const tracks = inside
          ? (p.tracks || []).filter((x: any) => !same(x, track))
          : [...(p.tracks || []), track];
        return { ...p, tracks };
      })
    );
    notify(inside ? `Убрал из «${pl.title}»` : `Добавил в «${pl.title}»`, inside ? 'info' : 'success');
  }

  // Та же анимация, что у попапа настроек в полноэкранном режиме: подъём из точки клика
  // масштабом и прозрачностью, без сдвига — сдвиг у прижатого к краю меню читается как рывок.
  //
  // Помимо этого переход отдаёт свой прогресс наружу — готовым значением `filter` в
  // `--pop-blur`. Оформление меню задаёт дизайн, и материализовать стекло расфокусом (слой
  // приходит размытым и на глазах становится плотным) уместно там, где меню и есть стекло, —
  // поэтому решение остаётся за CSS, а переход только сообщает, где он сейчас. Значение
  // передаётся целиком, а не числом: пока переход не идёт, переменной нет вовсе, и правило
  // сводится к `filter: none` — иначе на меню навсегда остался бы `blur(0)`, то есть лишний
  // композиторский слой под текстом.
  function popFade(node: HTMLElement, params: { duration?: number } = {}) {
    const duration = params.duration ?? 220;
    return {
      duration,
      easing: cubicOut,
      css: (t: number) =>
        `opacity: ${t}; transform: scale(${0.94 + 0.06 * t}); --pop-blur: blur(${((1 - t) * 6).toFixed(2)}px);`
    };
  }
</script>

<span class="pl-menu" bind:this={root}>
  <button
    type="button"
    class="pl-menu-trigger {buttonClass}"
    class:is-open={open}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label="Добавить в плейлист"
    title="Добавить в плейлист"
    on:click={toggle}
  >
    <Plus size={iconSize} />
  </button>

  {#if open}
    <div
      transition:popFade
      class="pl-menu-pop is-{placement} is-{align}"
      role="menu"
      tabindex="-1"
    >
      <div class="pl-menu-head">
        <ListMusic size={12} />
        Плейлисты
      </div>

      {#if $playlists.length > 0}
        <div class="pl-menu-list">
          {#each $playlists as pl (pl.id)}
            {@const inside = isIn(pl, track)}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={inside}
              class="pl-menu-item"
              class:is-in={inside}
              on:click={(e) => toggleMembership(e, pl)}
            >
              <span class="pl-menu-item-title">{pl.title}</span>
              {#if inside}
                <Check size={15} class="text-primary shrink-0" />
              {:else}
                <Plus size={15} class="pl-menu-item-add" />
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="pl-menu-empty">Плейлистов ещё нет — первый заводится в медиатеке.</div>
      {/if}
    </div>
  {/if}
</span>
