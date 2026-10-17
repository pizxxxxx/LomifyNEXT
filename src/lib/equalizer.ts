export const EQUALIZER_STORAGE_KEY = 'lomifynext_equalizer';

export const EQUALIZER_PRESETS = [
  { id: 'flat', label: 'Ровно', hint: 'Без коррекции', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: 'Бас', hint: 'Плотный низ', gains: [6, 5, 4, 2, 0, -1, -2, -3, -4, -5] },
  { id: 'electronic', label: 'Электроника', hint: 'Удар и воздух', gains: [5, 4, 1, 0, -2, -1, 2, 4, 5, 6] },
  { id: 'vocal', label: 'Вокал', hint: 'Голос ближе', gains: [-2, -1, 0, 2, 4, 5, 4, 2, 0, -2] },
  { id: 'rock', label: 'Рок', hint: 'Гитары и атака', gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
  { id: 'priora', label: 'Приора', hint: 'Под окном', gains: [12, 12, 12, 12, 5, -12, -12, -12, -12, -12] },
] as const;

export interface EqualizerState {
  bands: number[];
  preset: string;
  profiles: EqualizerProfile[];
}

export interface EqualizerProfile {
  id: string;
  name: string;
  gains: number[];
}

function normalizeGains(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 10) return null;
  return value.map(gain =>
    typeof gain === 'number' && Number.isFinite(gain) ? Math.max(-12, Math.min(12, gain)) : 0
  );
}

export function equalizerProfileKey(id: string): string {
  return `profile:${id}`;
}

export function normalizeProfileName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 60);
}

export function normalizeEqualizerState(value: unknown): EqualizerState {
  const saved = value as Partial<EqualizerState> | null;
  const profiles: EqualizerProfile[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  if (Array.isArray(saved?.profiles)) {
    for (const profile of saved.profiles) {
      if (!profile || typeof profile.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(profile.id)
        || typeof profile.name !== 'string') continue;
      const name = normalizeProfileName(profile.name);
      const nameKey = name.toLocaleLowerCase('ru');
      const gains = normalizeGains(profile.gains);
      if (!name || !gains || ids.has(profile.id) || names.has(nameKey)) continue;
      profiles.push({ id: profile.id, name, gains });
      ids.add(profile.id);
      names.add(nameKey);
    }
  }
  const bands = normalizeGains(saved?.bands);
  if (!bands) return { bands: [...EQUALIZER_PRESETS[0].gains], preset: 'flat', profiles };
  if (profiles.some(profile => equalizerProfileKey(profile.id) === saved?.preset)) {
    // Keep the selected profile when its current gains have been edited. The
    // saved profile changes only after the user chooses to update it explicitly.
    return { bands, preset: saved!.preset!, profiles };
  }
  // A stale/unknown preset must never label different gains as a built-in profile.
  const matching = EQUALIZER_PRESETS.find(preset => preset.gains.every((gain, i) => gain === bands[i]));
  return { bands, preset: saved?.preset === 'custom' ? 'custom' : matching?.id ?? 'custom', profiles };
}
