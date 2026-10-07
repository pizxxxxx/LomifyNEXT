/** Two percentage points per mouse detent, smaller steps for a trackpad. */
export function volumeAfterWheel(volume: number, delta: number, mode: number): number {
  if (!Number.isFinite(delta) || !delta) return volume;
  const pixels = delta * (mode === 1 ? 40 : mode === 2 ? 120 : 1);
  const change = Math.max(-.03, Math.min(.03, -pixels * .0002));
  return Math.max(0, Math.min(1, volume + change));
}
