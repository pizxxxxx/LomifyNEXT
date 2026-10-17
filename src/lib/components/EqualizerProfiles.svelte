<script lang="ts">
  import { tick } from 'svelte';
  import { Check, Plus, Save, Trash2, X } from 'lucide-svelte';
  import {
    activeEqualizerPreset, equalizerBands, equalizerProfiles, equalizerSaveError,
    saveEqualizerProfile, applyEqualizerProfile, updateEqualizerProfile,
    deleteEqualizerProfile, restoreEqualizerProfile, notify
  } from '$lib/stores';
  import { equalizerProfileKey } from '$lib/equalizer';

  let creating = $state(false);
  let name = $state('');
  let error = $state('');
  let message = $state('');
  let nameInput = $state<HTMLInputElement>();
  let createButton = $state<HTMLButtonElement>();
  let activeProfile = $derived($equalizerProfiles.find(profile => equalizerProfileKey(profile.id) === $activeEqualizerPreset));
  let changed = $derived(activeProfile?.gains.some((gain, i) => gain !== $equalizerBands[i]) ?? false);

  async function startCreating() {
    creating = true;
    error = '';
    message = '';
    await tick();
    nameInput?.focus();
  }

  function cancelCreating() {
    creating = false;
    name = '';
    error = '';
    createButton?.focus();
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const result = saveEqualizerProfile(name);
    if (!result.ok) {
      error = result.error;
      nameInput?.focus();
      return;
    }
    message = `Профиль «${result.profile.name}» сохранён.`;
    cancelCreating();
  }

  function remove(id: string) {
    const removed = deleteEqualizerProfile(id);
    if (!removed) return;
    message = `Профиль «${removed.name}» удалён. Текущие полосы сохранены.`;
    notify(`Профиль «${removed.name}» удалён.`, 'info', {
      label: 'Отменить',
      run: () => {
        if (!restoreEqualizerProfile(removed)) {
          notify('Профиль с таким названием уже есть. Удаление отменить не удалось.', 'error');
        }
      }
    });
    createButton?.focus();
  }
</script>

<section class="eq-profiles" aria-labelledby="eq-profiles-title">
  <div class="eq-profiles-heading">
    <div>
      <h2 id="eq-profiles-title">Мои профили <span>{$equalizerProfiles.length}</span></h2>
      <p>Сохрани разные настройки для наушников, колонок или настроения.</p>
    </div>
    <button type="button" class="eq-profile-action" bind:this={createButton} onclick={startCreating} aria-expanded={creating} aria-controls="eq-profile-create">
      <Plus size={15} aria-hidden="true" /> Сохранить как...
    </button>
  </div>

  {#if creating}
    <form id="eq-profile-create" class="eq-profile-form" onsubmit={save}>
      <div class="eq-profile-field">
        <label for="eq-profile-name">Название профиля</label>
        <input id="eq-profile-name" bind:this={nameInput} bind:value={name} maxlength="60" placeholder="Например, Мои наушники" aria-invalid={Boolean(error)} aria-describedby={error ? 'eq-profile-error' : undefined} oninput={() => { error = ''; }} onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelCreating(); } }} />
      </div>
      <button type="submit" class="eq-profile-action is-primary"><Save size={15} aria-hidden="true" /> Сохранить</button>
      <button type="button" class="eq-profile-icon" onclick={cancelCreating} aria-label="Отменить создание профиля"><X size={16} aria-hidden="true" /></button>
      {#if error}<p class="eq-profile-error" id="eq-profile-error" role="alert">{error}</p>{/if}
    </form>
  {/if}

  {#if $equalizerProfiles.length}
    <div class="eq-profile-list" aria-label="Сохранённые профили">
      {#each $equalizerProfiles as profile (profile.id)}
        {@const selected = $activeEqualizerPreset === equalizerProfileKey(profile.id)}
        <div class="eq-profile" class:is-selected={selected}>
          <button type="button" class="eq-profile-select" aria-pressed={selected} onclick={() => { applyEqualizerProfile(profile.id); message = `Выбран профиль «${profile.name}».`; }}>
            <span class="eq-profile-check" aria-hidden="true">{#if selected}<Check size={15} />{:else}<Save size={14} />{/if}</span>
            <span class="eq-profile-name">{profile.name}</span>
          </button>
          <button type="button" class="eq-profile-icon eq-profile-delete" onclick={() => remove(profile.id)} aria-label={`Удалить профиль ${profile.name}`} title={`Удалить профиль ${profile.name}`}><Trash2 size={14} aria-hidden="true" /></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if activeProfile && changed}
    <div class="eq-profile-update">
      <p>Полосы изменены. Записать их в профиль «{activeProfile.name}»?</p>
      <button type="button" class="eq-profile-action" onclick={() => { if (activeProfile && updateEqualizerProfile(activeProfile.id)) message = `Профиль «${activeProfile.name}» обновлён.`; }}><Save size={14} aria-hidden="true" /> Обновить профиль</button>
    </div>
  {/if}
  <p class="eq-profile-status" class:is-error={$equalizerSaveError} role="status" aria-atomic="true">
    {$equalizerSaveError ? 'Не удалось сохранить настройки. Проверь свободное место и измени настройку ещё раз.' : message || 'Текущие полосы и сохранённые профили восстановятся после перезапуска.'}
  </p>
</section>

<style>
  .eq-profiles { --eq-profile-accent: var(--color-primary); --eq-profile-text: #eeeaf2; --eq-profile-muted: #b8afc3; padding: 16px; border: 1px solid #ffffff12; border-radius: 14px; background: #ffffff04; color: var(--eq-profile-text); }
  :global(body[data-design="liquid-glass"]) .eq-profiles { --eq-profile-accent: var(--lg-accent); border-color: var(--lg-edge); }
  .eq-profiles-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 650; }
  h2 span { color: var(--eq-profile-muted); font-size: 11px; font-weight: 500; }
  p { margin: 5px 0 0; color: var(--eq-profile-muted); font-size: 12px; line-height: 1.5; }
  button { cursor: pointer; }
  .eq-profile-action, .eq-profile-icon { min-height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid #ffffff18; border-radius: 9px; color: var(--eq-profile-text); background: #ffffff08; font-size: 12px; font-weight: 550; transition: background-color 160ms ease, border-color 160ms ease; }
  .eq-profile-action { padding: 7px 11px; flex-shrink: 0; }
  .eq-profile-icon { width: 36px; flex: 0 0 36px; padding: 0; }
  .eq-profile-action:hover, .eq-profile-icon:hover { background: #ffffff12; }
  .eq-profile-action:active, .eq-profile-icon:active { background: #ffffff1c; }
  .is-primary { background: var(--eq-profile-accent); border-color: transparent; color: #17131c; }
  .is-primary:hover { background: color-mix(in srgb, var(--eq-profile-accent) 85%, white); }
  .eq-profile-form { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .eq-profile-field { flex: 1 1 220px; min-width: 0; }
  label { display: block; margin-bottom: 6px; font-size: 12px; color: var(--eq-profile-text); }
  input { box-sizing: border-box; width: 100%; min-height: 36px; padding: 7px 10px; border: 1px solid #ffffff24; border-radius: 9px; background: #00000025; color: var(--eq-profile-text); font-size: 12px; }
  input::placeholder { color: var(--eq-profile-muted); }
  input[aria-invalid="true"] { border-color: #ffacb5; }
  .eq-profile-error { flex-basis: 100%; color: #ffacb5; }
  .eq-profile-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 8px; margin-top: 12px; }
  .eq-profile { display: flex; align-items: center; min-width: 0; border: 1px solid #ffffff16; border-radius: 10px; background: #ffffff04; padding-right: 3px; }
  .eq-profile.is-selected { border-color: color-mix(in srgb, var(--eq-profile-accent) 60%, transparent); background: color-mix(in srgb, var(--eq-profile-accent) 10%, transparent); }
  .eq-profile-select { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; min-height: 42px; padding: 9px 10px; border-radius: 9px; text-align: left; color: var(--eq-profile-text); background: transparent; font-size: 12px; line-height: 1.4; }
  .eq-profile-select:hover { background: #ffffff08; }
  .eq-profile-check { display: inline-flex; flex: 0 0 15px; color: var(--eq-profile-muted); }
  .is-selected .eq-profile-check { color: var(--eq-profile-accent); }
  .eq-profile-name { overflow-wrap: anywhere; }
  .eq-profile-delete { border: 0; background: transparent; color: var(--eq-profile-muted); }
  .eq-profile-delete:hover { color: #ffacb5; background: #ffacb510; }
  .eq-profile-update { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .eq-profile-update p { flex: 1 1 220px; margin: 0; overflow-wrap: anywhere; }
  .eq-profile-status { margin-top: 10px; font-size: 11px; overflow-wrap: anywhere; }
  .eq-profile-status.is-error { color: #ffacb5; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--eq-profile-accent); outline-offset: 3px; }
  @media (max-width: 600px) { .eq-profiles-heading { align-items: flex-start; flex-direction: column; } }
  @media (prefers-reduced-motion: reduce) { button { transition: none !important; } }
</style>
