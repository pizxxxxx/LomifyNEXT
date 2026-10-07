import { currentView, notify } from './stores';
import { activeDailyMix } from './dailyMixActions';
import { parseShareLink } from './shareLinksCore';

export async function copyMusicLink(url: string) {
  try { await navigator.clipboard.writeText(url); notify('Веб-ссылка скопирована. На странице можно открыть Lomify или музыкальный сервис.', 'success'); }
  catch { notify('Не удалось скопировать ссылку. Попробуй ещё раз.', 'error'); }
}
export function openMusicLink(url: string): boolean {
  const selection = parseShareLink(url);
  if (!selection) { notify('Ссылка Lomify повреждена или имеет неизвестный формат.', 'error'); return false; }
  activeDailyMix.set(selection);
  currentView.set('daily-mix');
  return true;
}
export function startMusicLinks() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  let disposed = false;
  let cleanup: (() => void) | undefined;
  void (async () => {
    const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
    // Subscribe first so a link arriving during bootstrap cannot be lost.
    cleanup = await onOpenUrl(urls => { if (!disposed && urls[0]) openMusicLink(urls[0]); });
    if (disposed) { cleanup(); return; }
    const urls = await getCurrent();
    if (!disposed && urls?.[0]) openMusicLink(urls[0]);
  })().catch(() => { if (!disposed) notify('Не удалось подключить открытие ссылок Lomify. Перезапусти приложение.', 'error'); });
  return () => { disposed = true; cleanup?.(); };
}
