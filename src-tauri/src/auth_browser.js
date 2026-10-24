// Keep one-time authorization parameters out of the visible URL and this history entry.
try { history.replaceState(null, '', location.pathname); } catch { /* The page still works without history access. */ }
if (/Mac|iPhone|iPad/.test(navigator.platform)) document.getElementById('close-shortcut').textContent = 'Command + W';
document.getElementById('close-tab').addEventListener('click', () => {
  window.close();
  setTimeout(() => { document.getElementById('close-hint').hidden = false; }, 150);
});
