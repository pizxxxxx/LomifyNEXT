<script context="module" lang="ts">
  let menuSequence = 0;
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { Check, ChevronDown } from 'lucide-svelte';

  type SelectMenuOption = {
    value: string | number;
    label: string;
  };

  export let value: string | number;
  export let options: SelectMenuOption[] = [];
  export let ariaLabel: string;
  export let disabled = false;

  let root: HTMLElement;
  let trigger: HTMLButtonElement;
  let optionButtons: HTMLButtonElement[] = [];
  let open = false;
  let activeIndex = 0;

  const menuId = `select-menu-${++menuSequence}`;

  $: selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  $: selectedLabel = options[selectedIndex]?.label ?? '';

  function attach() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pointerdown', onOutsidePointer, true);
  }

  function detach() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', onOutsidePointer, true);
  }

  $: if (open) attach();
  else detach();

  onDestroy(detach);

  function onOutsidePointer(event: PointerEvent) {
    if (root && !root.contains(event.target as Node)) close();
  }

  function close() {
    open = false;
  }

  async function openAt(index = selectedIndex) {
    if (disabled || !options.length) return;
    activeIndex = Math.min(options.length - 1, Math.max(0, index));
    open = true;
    await tick();
    optionButtons[activeIndex]?.focus();
  }

  function toggle() {
    if (open) close();
    else void openAt();
  }

  function onTriggerPointerDown(event: PointerEvent) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    if (open) {
      close();
      void tick().then(() => trigger?.focus());
    } else {
      void openAt();
    }
  }

  function onTriggerClick(event: MouseEvent) {
    if (event.detail === 0) toggle();
  }

  function choose(option: SelectMenuOption) {
    value = option.value;
    close();
    void tick().then(() => trigger?.focus());
  }

  function focusOption(index: number) {
    if (!options.length) return;
    activeIndex = (index + options.length) % options.length;
    optionButtons[activeIndex]?.focus();
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void openAt(selectedIndex);
    } else if (event.key === 'Home') {
      event.preventDefault();
      void openAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      void openAt(options.length - 1);
    }
  }

  function onMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOption(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(activeIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      trigger?.focus();
    } else if (event.key === 'Tab') {
      close();
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      const needle = event.key.toLocaleLowerCase('ru');
      const match = options.findIndex((option, index) =>
        index !== activeIndex && option.label.toLocaleLowerCase('ru').startsWith(needle)
      );
      if (match >= 0) focusOption(match);
    }
  }
</script>

<div class="select-menu" class:is-open={open} bind:this={root}>
  <button
    type="button"
    class="select-menu-trigger"
    bind:this={trigger}
    aria-label={ariaLabel}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={menuId}
    disabled={disabled}
    on:pointerdown|stopPropagation={onTriggerPointerDown}
    on:click|stopPropagation={onTriggerClick}
    on:keydown={onTriggerKeydown}
  >
    <span>{selectedLabel}</span>
    <ChevronDown size={16} aria-hidden="true" />
  </button>

  {#if open}
    <div id={menuId} class="select-menu-pop" role="menu" tabindex="-1" aria-label={ariaLabel} on:keydown={onMenuKeydown}>
      {#each options as option, index (option.value)}
        {@const selected = option.value === value}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          class="select-menu-option"
          class:is-selected={selected}
          bind:this={optionButtons[index]}
          on:focus={() => activeIndex = index}
          on:click={() => choose(option)}
        >
          <span>{option.label}</span>
          {#if selected}<Check size={15} strokeWidth={2.4} aria-hidden="true" />{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
