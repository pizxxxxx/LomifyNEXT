<script lang="ts">
  import { Search, X } from 'lucide-svelte';

  let { value, total, matches, onChange }: {
    value: string;
    total: number;
    matches: number;
    onChange: (value: string) => void;
  } = $props();
  let input: HTMLInputElement;

  function clear() {
    onChange('');
    input.focus();
  }
</script>

<div class="playlist-search">
  <div class="search-field">
    <Search size={17} aria-hidden="true" />
    <input
      bind:this={input}
      type="search"
      aria-label="Поиск в плейлисте"
      placeholder="Название или исполнитель"
      {value}
      autocomplete="off"
      spellcheck="false"
      oninput={(event) => onChange(event.currentTarget.value)}
      onkeydown={(event) => {
        if (event.key === 'Escape' && value) {
          event.preventDefault();
          event.stopPropagation();
          clear();
        }
      }}
    />
    {#if value}
      <button type="button" onclick={clear} aria-label="Очистить поиск" title="Очистить поиск">
        <X size={16} aria-hidden="true" />
      </button>
    {/if}
  </div>
  <p class="search-count tnum" role="status">
    {#if value.trim()}Найдено: {matches} из {total}{:else}Всего треков: {total}{/if}
  </p>
</div>

<style>
  .playlist-search {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem 1rem;
    margin: 1rem 0;
  }

  .search-field {
    display: flex;
    flex: 1 1 15rem;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    min-height: 2.75rem;
    padding: 0 0.65rem 0 0.85rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.8rem;
    background: rgba(255, 255, 255, 0.035);
    color: rgba(255, 255, 255, 0.65);
  }

  .search-field:focus-within {
    border-color: var(--color-primary);
    outline: 1px solid var(--color-primary);
    outline-offset: 1px;
  }

  input {
    width: 100%;
    min-width: 0;
    height: 2.65rem;
    background: transparent;
    color: #f5f5f5;
    font: inherit;
    font-size: 0.82rem;
    outline: none;
  }

  input::placeholder { color: rgba(255, 255, 255, 0.6); }
  input::-webkit-search-cancel-button { display: none; }

  button {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    color: #f5f5f5;
    cursor: pointer;
  }

  button:hover { background: rgba(255, 255, 255, 0.08); }
  button:focus-visible { outline: 2px solid var(--color-primary); }

  .search-count {
    min-width: 10rem;
    margin: 0;
    color: rgba(255, 255, 255, 0.65);
    font-size: 0.75rem;
    text-align: right;
  }
</style>
