/**
 * Locks the WebView down so a shipped build behaves like an app, not like a browser
 * tab: no F12 / Ctrl+Shift+I inspector, no view-source, no reload, no "Inspect element"
 * in the right-click menu.
 *
 * This is a UX lock, not a security boundary — anything in the frontend is reachable by
 * someone determined. The real switch is the `devtools` Cargo feature in
 * `src-tauri/Cargo.toml`: without it Tauri only compiles the inspector into debug
 * builds, so in a release build there is nothing for these shortcuts to open anyway.
 *
 * `import.meta.env.DEV` is inlined by Vite at build time, so during `tauri dev`
 * everything below is dead code and the devtools keep working normally.
 */

const BLOCKED_WITH_CTRL_SHIFT = new Set(['I', 'J', 'C', 'E', 'M']);
const BLOCKED_WITH_CTRL = new Set(['U', 'P', 'R']);

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

function onKeyDown(e: KeyboardEvent) {
  const key = e.key.toUpperCase();

  if (key === 'F12' || e.key === 'F12') {
    e.preventDefault();
    return;
  }
  // Refresh would wipe the current view's state for no gain — this is not a web page.
  if (e.key === 'F5') {
    e.preventDefault();
    return;
  }
  if (e.ctrlKey && e.shiftKey && BLOCKED_WITH_CTRL_SHIFT.has(key)) {
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && BLOCKED_WITH_CTRL.has(key)) {
    // Ctrl+P/Ctrl+R/Ctrl+U have no meaning here; typing them in a field should still
    // do nothing rather than open a print dialog.
    e.preventDefault();
  }
}

function onContextMenu(e: MouseEvent) {
  // Text fields keep their native cut/copy/paste menu — that one is genuinely useful.
  if (isTextEntry(e.target)) return;
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) return;
  e.preventDefault();
}

function onDragStart(e: DragEvent) {
  // Dragging covers out of the window into Explorer looks broken; nothing here is a
  // drag source on purpose.
  if (e.target instanceof HTMLImageElement) e.preventDefault();
}

/** Returns a teardown function, so callers can register it from `onMount`. */
export function lockDevTools(): () => void {
  if (import.meta.env.DEV || typeof window === 'undefined') {
    return () => {};
  }

  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('contextmenu', onContextMenu, { capture: true });
  window.addEventListener('dragstart', onDragStart, { capture: true });

  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('contextmenu', onContextMenu, { capture: true });
    window.removeEventListener('dragstart', onDragStart, { capture: true });
  };
}
