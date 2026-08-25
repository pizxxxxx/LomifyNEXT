/**
 * Russian plural agreement. "Скачано треков: 1" is the single loudest tell that
 * nobody wrote the copy — a sentence has to agree with its own number, so the
 * count strings pick the right form instead of freezing the genitive plural.
 *
 *   plural(1, 'трек', 'трека', 'треков')  → 'трек'
 *   plural(3, 'трек', 'трека', 'треков')  → 'трека'
 *   plural(11, 'трек', 'трека', 'треков') → 'треков'
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(count));
  const mod100 = n % 100;
  // 11-14 take the "many" form despite ending in 1-4.
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** `plural` with the number glued on: `withCount(2, …)` → `'2 трека'`. */
export function withCount(count: number, one: string, few: string, many: string): string {
  return `${count} ${plural(count, one, few, many)}`;
}
