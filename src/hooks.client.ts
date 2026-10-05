import { installConsoleRedaction, redactText } from '$lib/logRedaction';

installConsoleRedaction();
window.addEventListener('error', (event) => {
  if (!event.error) return;
  event.preventDefault();
  console.error('[app]', redactText(String(event.error?.stack || event.message)));
});
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  console.error('[app] необработанная ошибка', event.reason);
});
