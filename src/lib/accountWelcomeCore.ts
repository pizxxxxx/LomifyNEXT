export const ACCOUNT_WELCOME_KEY = 'lomifynext_account_welcome_v1';
export const ACCOUNT_WELCOME_PENDING_KEY = 'lomifynext_account_welcome_pending_v1';
export function accountWelcomeKind(storage: Pick<Storage, 'getItem'>): 'new' | 'upgrade' | 'done' {
  if (storage.getItem(ACCOUNT_WELCOME_KEY)) return 'done';
  const pending = storage.getItem(ACCOUNT_WELCOME_PENDING_KEY);
  if (pending === 'new' || pending === 'upgrade') return pending;
  // Inspect before initStore writes fresh defaults. Existing data always stays local
  // until its owner explicitly chooses an upload or a restore.
  return ['lomifynext_settings', 'lomifynext_stats', 'lomifynext_likes', 'lomifynext_last_seen_notice_version', 'lomifynext_cloud_account']
    .some(key => storage.getItem(key) !== null) ? 'upgrade' : 'new';
}
