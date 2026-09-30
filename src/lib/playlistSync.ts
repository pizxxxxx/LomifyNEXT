import { get, writable } from 'svelte/store';
import { playlists, settings } from '$lib/stores';
import { playlistSyncReady, persistSyncedPlaylists } from '$lib/playlistSyncStorage';
import { snapshot, same, mergeSnapshots, tracksForKeys, type PlaylistLink, type PlaylistSnapshot } from '$lib/playlistSyncCore';
import { normalizeYandexToken } from '$lib/yandex';
import { playlistAccount, listYandexPlaylists, readYandexPlaylist, changeYandexTracks, renameYandexPlaylist, createYandexPlaylist, prepareYandexTracks, isRevisionConflict } from '$lib/yandexPlaylists';
import { getSoundCloudSyncPlaylists } from '$lib/api';
type Provider = 'yandex' | 'soundcloud';
type Status = { busy: boolean; error: string; message: string; lastSynced: number };
const empty = (): Status => ({ busy: false, error: '', message: '', lastSynced: 0 });
export const playlistSyncStatus = writable<Record<Provider, Status>>({ yandex: empty(), soundcloud: empty() });
let tail = Promise.resolve();
let applying = false;
let wake: (() => void) | null = null;
const EXCLUDED = 'lomifynext_playlist_sync_excluded';
function exclusions(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(EXCLUDED) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}
function excluded(provider: Provider, accountId: string, remoteId: string): boolean {
  if (exclusions().includes([provider, accountId, remoteId].join(':'))) return true;
  try { return JSON.parse(localStorage.getItem('lomifynext_mobile_removed_imported_playlists') || '[]').includes(remoteId); } catch { return false; }
}
function rememberRemoval(link: PlaylistLink) {
  const key = [link.provider, link.accountId, link.remoteId].join(':');
  localStorage.setItem(EXCLUDED, JSON.stringify([...new Set([...exclusions(), key])]));
}
function status(provider: Provider, changes: Partial<Status>) {
  playlistSyncStatus.update(value => ({ ...value, [provider]: { ...value[provider], ...changes } }));
}
function enabled(provider: Provider): boolean {
  const value = get(settings);
  return provider === 'yandex' ? value.syncYandexPlaylists : value.syncSoundCloudPlaylists;
}
function credential(provider: Provider): string {
  const value = get(settings);
  return provider === 'yandex' ? normalizeYandexToken(value.yandexToken) : String(value.scUser?.id || '');
}
function current(id: string): any { return get(playlists).find(item => String(item.id) === id); }
function update(id: string, transform: (value: any) => any) {
  applying = true;
  try { playlists.update(items => items.map(item => String(item.id) === id ? transform(item) : item)); }
  finally { applying = false; }
}
function add(item: any) {
  applying = true;
  try { playlists.update(items => [item, ...items]); } finally { applying = false; }
}
function serial<T>(action: () => Promise<T>): Promise<T> {
  const next = tail.then(action, action);
  tail = next.then(() => {}, () => {});
  return next;
}
function accountGuard(provider: Provider, originalCredential: string, requireEnabled = true) {
  return () => {
    if (credential(provider) !== originalCredential || (requireEnabled && !enabled(provider))) {
      throw new Error('Подключение изменилось. Сверка остановлена, местные правки сохранены.');
    }
  };
}
function commit(id: string, started: PlaylistSnapshot, remote: any, link: PlaylistLink) {
  update(id, latest => {
    const newest = snapshot(latest);
    const incoming = snapshot(remote);
    const merged = same(started, newest) ? { value: incoming } : mergeSnapshots(started, newest, incoming);
    return { ...latest, title: merged.conflict ? latest.title : merged.value.title,
      tracks: merged.conflict ? latest.tracks : tracksForKeys(merged.value.keys, latest.tracks || [], remote.tracks || []),
      coverUrl: remote.coverUrl || latest.coverUrl,
      sync: { ...link, paused: latest.sync?.paused, baseline: incoming, lastSynced: Date.now(), conflict: merged.conflict, error: '' } };
  });
}
async function reconcileYandex(id: string, token: string, accountId: string, guard: () => void,
  resolve?: 'local' | 'remote'): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    guard();
    const local = current(id), link: PlaylistLink | undefined = local?.sync;
    if (!local || !link || link.paused || link.accountId !== accountId) return;
    const started = snapshot(local);
    let remote = await readYandexPlaylist(token, link.ownerId!, link.kind!);
    guard();
    // Include edits that happened during the fetch before any server write.
    const latest = current(id);
    if (!latest || latest.sync?.paused) return;
    const localSnapshot = snapshot(latest);
    const merged = resolve ? { value: resolve === 'local' ? localSnapshot : snapshot(remote) }
      : mergeSnapshots(link.baseline, localSnapshot, snapshot(remote));
    if (merged.conflict) {
      update(id, item => ({ ...item, sync: { ...item.sync, conflict: merged.conflict, error: '' } }));
      return;
    }
    if (link.ownerId !== accountId) {
      update(id, item => ({ ...item, title: merged.value.title,
        tracks: tracksForKeys(merged.value.keys, item.tracks || [], remote.tracks),
        sync: { ...item.sync, baseline: snapshot(remote), revision: remote.revision, conflict: undefined, error: '', lastSynced: Date.now() } }));
      return;
    }
    let mergedTracks = tracksForKeys(merged.value.keys, latest.tracks || [], remote.tracks);
    try {
      if (!same(merged.value, snapshot(remote))) {
        mergedTracks = await prepareYandexTracks(token, mergedTracks);
        guard();
        if (!current(id) || current(id).sync?.paused) return;
        if (merged.value.title !== remote.title) {
          // The name endpoint has no revision parameter. Recheck the name just before sending.
          const beforeRename = await readYandexPlaylist(token, link.ownerId!, link.kind!);
          guard();
          if (beforeRename.title !== remote.title || beforeRename.revision !== remote.revision) continue;
          await renameYandexPlaylist(token, beforeRename, merged.value.title);
          remote = await readYandexPlaylist(token, link.ownerId!, link.kind!);
          guard();
          // A concurrent content edit must go through the three-way merge again.
          if (JSON.stringify(snapshot(remote).keys) !== JSON.stringify(snapshot(beforeRename).keys)) continue;
        }
        if (JSON.stringify(merged.value.keys) !== JSON.stringify(snapshot(remote).keys)) {
          guard();
          await changeYandexTracks(token, remote, mergedTracks);
        }
        remote = await readYandexPlaylist(token, link.ownerId!, link.kind!);
        guard();
        // An edit made by another device after our write becomes the next baseline.
      }
      commit(id, localSnapshot, remote, { ...link, revision: remote.revision, conflict: undefined, error: '' });
      if (!same(started, snapshot(current(id) || local))) wake?.();
      return;
    } catch (error) {
      if (isRevisionConflict(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error('Плейлист меняется на другом устройстве. Повтори сверку через несколько секунд.');
}
async function run(provider: Provider, importOnly: boolean): Promise<number> {
  await playlistSyncReady;
  const originalCredential = credential(provider);
  if (!originalCredential) throw new Error('Сначала подключи аккаунт в разделе «Музыка».');
  const guard = accountGuard(provider, originalCredential, !importOnly);
  status(provider, { busy: true, error: '', message: 'Сверяем плейлисты...' });
  let imported = 0;
  let failed = 0;
  try {
    guard();
    const accountId = provider === 'yandex' ? await playlistAccount(originalCredential) : originalCredential;
    guard();
    const summaries = provider === 'yandex' ? await listYandexPlaylists(originalCredential, accountId)
      : await getSoundCloudSyncPlaylists(Number(accountId));
    guard();
    const visited = new Set<string>();
    for (const entry of summaries) {
      guard();
      const remoteId = provider === 'yandex' ? 'ym_playlist_' + entry.ownerId + '_' + entry.kind : String(entry.id);
      if (visited.has(remoteId) || excluded(provider, accountId, remoteId)) continue;
      visited.add(remoteId);
      let local = get(playlists).find(item => item.sync?.provider === provider && item.sync?.accountId === accountId && item.sync?.remoteId === remoteId)
        || current(remoteId);
      if (local?.sync?.accountId && local.sync.accountId !== accountId) continue;
      if (local?.sync?.paused && !importOnly) continue;
      try {
        if (provider === 'yandex' && local?.sync && !importOnly) {
          const link: PlaylistLink = local.sync;
          if (!link.conflict && (link.error || !same(snapshot(local), link.baseline)
            || !Number.isFinite(entry.revision) || entry.revision !== link.revision || entry.title !== link.baseline.title)) {
            await reconcileYandex(String(local.id), originalCredential, accountId, guard);
          }
          continue;
        }
        const remote = provider === 'yandex' ? await readYandexPlaylist(originalCredential, entry.ownerId, entry.kind) : entry;
        guard();
        if (!local) {
          const link: PlaylistLink = { provider, accountId, remoteId, ownerId: entry.ownerId, kind: entry.kind,
            revision: remote.revision, baseline: snapshot(remote), paused: false, lastSynced: Date.now() };
          add({ ...remote, sync: link });
          imported++;
          continue;
        }
        const id = String(local.id);
        if (!local.sync) {
          // Unknown old copies have no deletion history. Keep every track until the first baseline.
          const merged = mergeSnapshots(null, snapshot(local), snapshot(remote));
          update(id, latest => ({ ...latest,
            tracks: tracksForKeys(merged.value.keys, latest.tracks || [], remote.tracks),
            sync: { provider, accountId, remoteId, ownerId: entry.ownerId, kind: entry.kind, revision: remote.revision,
              baseline: snapshot(remote), paused: false, conflict: merged.conflict } }));
          local = current(id);
        }
        if (provider === 'yandex' && !importOnly) {
          if (!local.sync.conflict) await reconcileYandex(id, originalCredential, accountId, guard);
        } else {
          const started = snapshot(local);
          const merged = mergeSnapshots(local.sync.baseline, started, snapshot(remote));
          if (merged.conflict) {
            update(id, latest => ({ ...latest, sync: { ...latest.sync, conflict: merged.conflict } }));
          } else {
            update(id, latest => ({ ...latest, title: merged.value.title,
              tracks: tracksForKeys(merged.value.keys, latest.tracks || [], remote.tracks),
              coverUrl: remote.coverUrl || latest.coverUrl,
              sync: { ...latest.sync, baseline: snapshot(remote), lastSynced: Date.now(), error: '' } }));
          }
        }
      } catch (error) {
        guard();
        failed++;
        const message = error instanceof Error ? error.message : 'Не удалось сверить плейлист.';
        if (local) update(String(local.id), item => ({ ...item, sync: { ...item.sync, error: message } }));
      }
    }
    // Also update linked playlists imported by URL, outside the current account's own list.
    if (provider === 'yandex' && !importOnly) {
      for (const item of get(playlists).filter(item => item.sync?.provider === provider && item.sync?.accountId === accountId
        && !item.sync.paused && !item.sync.conflict && !visited.has(item.sync.remoteId))) {
        try { await reconcileYandex(String(item.id), originalCredential, accountId, guard); }
        catch (error) { guard(); failed++; update(String(item.id), latest => ({ ...latest, sync: { ...latest.sync, error: (error as Error).message } })); }
      }
    }
    await persistSyncedPlaylists();
    const conflicts = get(playlists).filter(item => item.sync?.provider === provider && item.sync?.accountId === accountId && item.sync.conflict).length;
    status(provider, { lastSynced: Date.now(), message: conflicts ? 'Нужен выбор версии: ' + conflicts + '. Открой плейлист.'
      : 'Сверка завершена. Новых плейлистов: ' + imported + '.',
      error: failed ? 'Не удалось сверить плейлисты: ' + failed + '. Местные правки сохранены. Повтори позже.' : '' });
    return imported;
  } catch (error) {
    status(provider, { error: (error as Error).message, message: '' });
    throw error;
  } finally { status(provider, { busy: false }); }
}
export function syncPlaylists(provider: Provider): Promise<number> {
  return serial(() => run(provider, !enabled(provider)));
}
export async function publishPlaylistToYandex(id: string): Promise<void> {
  return serial(async () => {
    await playlistSyncReady;
    const token = credential('yandex');
    if (!token) throw new Error('Подключи Яндекс Музыку в настройках.');
    const guard = accountGuard('yandex', token, false);
    const local = current(id);
    if (!local || local.sync) throw new Error('Этот плейлист уже связан с сервисом.');
    await prepareYandexTracks(token, local.tracks || []);
    const accountId = await playlistAccount(token);
    guard();
    if (!current(id)) return;
    const existing = String(local.id).match(/^ym_playlist_(\d+)_(\d+)$/);
    const remote = existing ? await readYandexPlaylist(token, existing[1], existing[2])
      : await createYandexPlaylist(token, accountId, local.title);
    // Save the identity before any content write so a retry never creates another playlist.
    update(id, item => ({ ...item, sync: { provider: 'yandex', accountId, remoteId: remote.id,
      ownerId: remote.ownerId, kind: remote.kind, revision: remote.revision, baseline: snapshot(remote), paused: false } }));
    await persistSyncedPlaylists();
    guard();
    settings.update(value => ({ ...value, syncYandexPlaylists: true }));
    await reconcileYandex(id, token, accountId, accountGuard('yandex', token));
    await persistSyncedPlaylists();
  });
}
export async function resolvePlaylistConflict(id: string, choice: 'local' | 'remote'): Promise<void> {
  return serial(async () => {
    const local = current(id), link: PlaylistLink | undefined = local?.sync;
    if (!link) return;
    const provider = link.provider, token = credential(provider);
    const guard = accountGuard(provider, token);
    if (provider === 'yandex') {
      const accountId = await playlistAccount(token);
      guard();
      if (accountId !== link.accountId) throw new Error('Этот плейлист связан с другим аккаунтом.');
      await reconcileYandex(id, token, accountId, guard, choice);
    } else {
      if (token !== link.accountId) throw new Error('Этот плейлист связан с другим профилем.');
      const items = await getSoundCloudSyncPlaylists(Number(token));
      guard();
      const remote = items.find(item => String(item.id) === link.remoteId);
      if (!remote) throw new Error('Плейлист больше не доступен в публичном профиле SoundCloud.');
      update(id, latest => ({ ...latest, ...(choice === 'remote' ? { title: remote.title, tracks: remote.tracks } : {}),
        sync: { ...link, baseline: snapshot(remote), conflict: undefined, error: '', lastSynced: Date.now() } }));
    }
    await persistSyncedPlaylists();
  });
}
export function pausePlaylistSync(id: string, paused: boolean) {
  update(id, item => ({ ...item, sync: { ...item.sync, paused } }));
  wake?.();
}
export function startPlaylistSync(): () => void {
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let previous = new Map<string, PlaylistLink>();
  let settingsKey = '';
  const schedule = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || document.visibilityState === 'hidden' || !navigator.onLine) return;
      for (const provider of ['yandex', 'soundcloud'] as Provider[]) {
        if (enabled(provider) && credential(provider) && !get(playlistSyncStatus)[provider].busy) void syncPlaylists(provider).catch(() => {});
      }
    }, 1800);
  };
  wake = schedule;
  const releasePlaylists = playlists.subscribe(items => {
    const next = new Map<string, PlaylistLink>();
    for (const item of items) if (item.sync?.remoteId) next.set(String(item.id), item.sync);
    if (!applying) {
      for (const [id, link] of previous) if (!next.has(id) && !items.some(item => String(item.id) === id)) rememberRemoval(link);
      schedule();
    }
    previous = next;
  });
  const releaseSettings = settings.subscribe(value => {
    const key = [value.syncYandexPlaylists, value.yandexToken, value.syncSoundCloudPlaylists, value.scUser?.id].join('|');
    if (key !== settingsKey) { settingsKey = key; schedule(); }
  });
  const resume = () => { if (document.visibilityState !== 'hidden') schedule(); };
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', resume);
  const interval = setInterval(resume, 60000);
  void playlistSyncReady.then(schedule);
  return () => {
    disposed = true; if (timer) clearTimeout(timer);
    clearInterval(interval); releasePlaylists(); releaseSettings(); if (wake === schedule) wake = null;
    window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    document.removeEventListener('visibilitychange', resume);
  };
}
