/** WebView's synthetic early click can keep a keyboard focus ring after a mouse
 * press. Record the actual input source before choosing its visual treatment. */
export function trackInputModality(): () => void {
  const pointer = () => document.body.dataset.inputMode = 'pointer';
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'Tab' || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
      if (event.key !== 'Tab' && event.target instanceof Element && event.target.matches('input, textarea, [contenteditable="true"]')) return;
      document.body.dataset.inputMode = 'keyboard';
    }
  };
  pointer();
  window.addEventListener('pointerdown', pointer, true);
  window.addEventListener('keydown', keyboard, true);
  return () => {
    window.removeEventListener('pointerdown', pointer, true);
    window.removeEventListener('keydown', keyboard, true);
    delete document.body.dataset.inputMode;
  };
}
