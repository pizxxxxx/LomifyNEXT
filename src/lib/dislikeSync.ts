import { get, writable } from 'svelte/store';
import { settings } from './stores';
import { normalizeYandexToken, yandexAccountStatus, yandexSetDislikes } from './yandex';
import { drainDislikeIntents, replaceDislikeIntent, type DislikeIntent, type DislikeAccount } from './dislikeSyncCore';

const KEY = 'lomifynext_dislike_sync';
export const dislikeSyncPending = writable<DislikeIntent[]>([]);
let account: DislikeAccount | null = null;
let running: Promise<void> | null = null;
let active = false;
let started = false;
const intentVersions = new Map<string, number>();

function load(): DislikeIntent[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => Number.isSafeInteger(item?.uid) && item.uid > 0 && /^\d+$/.test(item?.id) && typeof item?.disliked === 'boolean' && Number.isSafeInteger(item?.revision) && item.revision > 0) : [];
  } catch { return []; }
}
function save(entries: DislikeIntent[]) {
  // Remains in memory if storage is full, so a temporary write failure doesn't
  // prevent a send in this session. Account tokens are never saved here.
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* next retry uses memory */ }
  dislikeSyncPending.set(entries);
}
export function yandexDislikeId(track: any): string | null {
  if (track?.source && track.source !== 'yandex' && track.service !== 'yandex') return null;
  const id = String(track?.id || '').split(':')[0];
  return /^\d+$/.test(id) ? id : null;
}
function currentAccount() {
  return active && account?.token === normalizeYandexToken(get(settings).yandexToken) ? account : null;
}
function flush(): Promise<void> {
  if (running) return running;
  running = drainDislikeIntents({ read: () => get(dislikeSyncPending), write: save, account: currentAccount, send: yandexSetDislikes }).then(() => {}).finally(() => { running = null; });
  return running;
}

export async function rememberYandexDislike(track: any, disliked: boolean): Promise<void> {
  const config = get(settings), token = normalizeYandexToken(config.yandexToken), id = yandexDislikeId(track);
  if (!token || !id) return;
  const key = `${token}:${id}`;
  const version = (intentVersions.get(key) || 0) + 1;
  intentVersions.set(key, version);
  let uid = account?.token === token ? account.uid : config.yandexUser?.uid;
  if (!uid) {
    try { uid = (await yandexAccountStatus(token)).uid; } catch { return; }
  }
  if (!uid) return;
  if (intentVersions.get(key) !== version) return;
  save(replaceDislikeIntent(get(dislikeSyncPending), uid, id, disliked));
  // UI hiding/restoring is immediate; sending cannot hold an action open while offline.
  void flush();
}

/** Owned by layout after secret hydration. Retries at launch, reconnect, focus,
 * and once a minute. Only the account confirmed by the service can drain its lane. */
export function startDislikeSync(): () => void {
  if (started) return () => {};
  started = active = true;
  dislikeSyncPending.set(load());
  let lastToken = '';
  let checking: Promise<void> | null = null;
  async function confirmAccount() {
    const token = normalizeYandexToken(get(settings).yandexToken);
    if (!active || !token) { account = null; return; }
    if (account?.token === token) { void flush(); return; }
    if (checking) return;
    checking = (async () => {
      try {
        const result = await yandexAccountStatus(token);
        if (active && token === normalizeYandexToken(get(settings).yandexToken) && result.uid) {
          account = { uid: result.uid, token };
          await flush();
        }
      } catch { /* retained for reconnect */ }
    })().finally(() => { checking = null; });
    await checking;
    if (active && token !== normalizeYandexToken(get(settings).yandexToken)) void confirmAccount();
  }
  const unsubscribe = settings.subscribe(config => {
    const token = normalizeYandexToken(config.yandexToken);
    if (token === lastToken) return;
    lastToken = token; account = null;
    void confirmAccount();
  });
  const retry = () => void confirmAccount();
  window.addEventListener('online', retry); window.addEventListener('focus', retry);
  const interval = setInterval(retry, 60_000);
  return () => {
    active = started = false; account = null;
    unsubscribe(); clearInterval(interval);
    window.removeEventListener('online', retry); window.removeEventListener('focus', retry);
  };
}
