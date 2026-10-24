import { writable } from 'svelte/store';
import { ACCOUNT_WELCOME_KEY, ACCOUNT_WELCOME_PENDING_KEY, accountWelcomeKind } from './accountWelcomeCore';
export const accountWelcome = writable({ kind: 'upgrade' as 'new' | 'upgrade', open: false, nudge: false });
let initialized = false;
export function initializeAccountWelcome() {
  if (initialized) return;
  initialized = true;
  try {
    const kind = accountWelcomeKind(localStorage);
    if (kind !== 'done') {
      accountWelcome.set({ kind, open: kind === 'new', nudge: kind === 'upgrade' });
      try { localStorage.setItem(ACCOUNT_WELCOME_PENDING_KEY, kind); } catch { /* Keep the choice in memory. */ }
    }
  } catch { /* Unavailable storage must never prevent access to the local library. */ }
}
export function openAccountWelcome() { accountWelcome.update(value => ({ ...value, open: true, nudge: false })); }
export function finishAccountWelcome(choice: 'offline' | 'account' | 'later') {
  try { localStorage.setItem(ACCOUNT_WELCOME_KEY, JSON.stringify({ choice, completedAt: Date.now() })); localStorage.removeItem(ACCOUNT_WELCOME_PENDING_KEY); } catch { /* Continue in memory. */ }
  accountWelcome.update(value => ({ ...value, open: false, nudge: false }));
}
