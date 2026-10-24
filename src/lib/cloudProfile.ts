import { get, writable } from 'svelte/store';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { CloudApi, CloudConflict, type CloudHead, type CloudSession } from './cloudApi';
import { captureLomiBackup, saveLomiBackup, restoreLomiBackup, backupRestoreInProgress } from './lomiBackup';
import { getTracks } from './db';
import { getSecret, saveSecret, deleteSecret, whenSecretsReady } from './secretStorage';
import { listenStats, likedTracks, dislikedTracks, playlists, settings, equalizerBands, equalizerProfiles, activeEqualizerPreset, globalVolume, searchHistory } from './stores';
import { achievementUnlocks } from './achievements';
import type { LomiBackup } from './lomiBackupCore';
import { CLOUD_CONFIG as config, GOOGLE_DESKTOP_CLIENT_ID } from './cloudConfig';
export const cloudGoogleConfigured = Boolean(GOOGLE_DESKTOP_CLIENT_ID);
export const cloudGoogleReady = writable(false);
export function cloudDesktopAvailable() { return isTauri(); }

const SESSION_KEY = 'lomifynext_cloud_account';
const PREFERENCE_KEY = 'lomifynext_cloud_preferences';
const SECRET = 'lomify_cloud_refresh_token';
interface CloudState { email: string; busy: boolean; ready: boolean; auto: boolean; accepted: boolean; message: string; error: string; head: CloudHead | null; preview: LomiBackup | null; conflict: boolean }
export const cloudProfile = writable<CloudState>({ email: '', busy: false, ready: false, auto: false, accepted: false, message: '', error: '', head: null, preview: null, conflict: false });
let session: CloudSession | null = null, baseline: CloudHead | null = null;
let generation = 0, changeVersion = 0, dirty = false, startup: Promise<void> | null = null;
const api = (() => { try { return new CloudApi(config); } catch { return null; } })();
export const cloudConfigured = Boolean(api);
function patch(value: Partial<CloudState>) { cloudProfile.update(current => ({ ...current, ...value })); }
function assertCurrent(id: number) { if (id !== generation) throw new Error('Аккаунт изменился. Повтори действие.'); }
export function cancelPendingCloudSignIn() {
  if (!session && get(cloudProfile).busy) {
    generation++;
    patch({ busy: false, error: '', message: 'Можно продолжить без аккаунта и войти позже.' });
  }
}
function preferenceKey() { return `${config.projectId}/${session?.uid || ''}`; }
function readPreference(): { revision: string; auto: boolean } | null {
  try { return JSON.parse(localStorage.getItem(PREFERENCE_KEY) || '{}')[preferenceKey()] || null; } catch { return null; }
}
function savePreference(auto: boolean) {
  const values = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || '{}');
  values[preferenceKey()] = { revision: baseline?.revision || '', auto };
  localStorage.setItem(PREFERENCE_KEY, JSON.stringify(values));
}
async function credentials(): Promise<CloudSession> {
  if (!api || !session) throw new Error('Сначала войди в облачный аккаунт.');
  if (session.expiresAt > Date.now() + 60000) return session;
  const id = generation, previous = session;
  const next = await api.refresh(previous.refreshToken, previous.email); assertCurrent(id);
  if (next.uid !== previous.uid) throw new Error('Не удалось подтвердить владельца аккаунта. Войди заново.');
  if (isTauri()) await saveSecret(SECRET, next.refreshToken);
  assertCurrent(id); session = next; return next;
}
async function run(operation: (id: number) => Promise<void>) {
  if (get(cloudProfile).busy) return;
  const id = generation; patch({ busy: true, error: '', message: '' });
  try { await operation(id); }
  catch (error) {
    if (id === generation) {
      const conflict = error instanceof CloudConflict;
      patch({ error: error instanceof Error ? error.message : typeof error === 'string' ? error.slice(0, 500) : 'Не удалось выполнить действие. Повтори попытку.', ...(conflict ? { conflict: true, auto: false } : {}) });
      if (conflict) { try { savePreference(false); } catch { /* Session remains in memory. */ } }
    }
  } finally { if (id === generation) patch({ busy: false }); }
}
export async function cloudSignIn(email: string, password: string, register = false) {
  await run(async id => {
    if (!api) throw new Error('Облако появится после подключения проекта Firebase.');
    if (session) throw new Error('Сначала выйди из текущего аккаунта.');
    const next = await api.signIn(email, password, register); await acceptSession(next, id);
  });
}
async function acceptSession(next: CloudSession, id: number) {
    assertCurrent(id);
    if (isTauri()) {
      await saveSecret(SECRET, next.refreshToken); assertCurrent(id);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ uid: next.uid, email: next.email, projectId: config.projectId }));
    }
    session = next; baseline = null;
    patch({ email: next.email, auto: false, accepted: false, preview: null, head: null, ready: true });
    await check(id);
    if (baseline === null) {
      patch({ message: 'Сохраняем данные с этого компьютера в твой аккаунт…' });
      await upload(id); assertCurrent(id);
      savePreference(true);
      patch({ auto: true, message: 'Данные с компьютера сохранены в аккаунте. Автосохранение включено.' });
    }
}
export async function cloudSignInGoogle() {
  await run(async id => {
    if (!api || !cloudGoogleConfigured) throw new Error('Вход Google ещё не подключён. Можно войти по почте и паролю.');
    if (!isTauri()) throw new Error('Вход Google доступен в установленном приложении Lomify.');
    if (session) throw new Error('Сначала выйди из текущего аккаунта.');
    patch({ message: 'Выбери аккаунт Google в открывшемся браузере. После входа вернись в Lomify.' });
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(48)), n => n.toString(16).padStart(2, '0')).join('');
    const token = await invoke<string>('google_sign_in', { clientId: GOOGLE_DESKTOP_CLIENT_ID, state: crypto.randomUUID() + crypto.randomUUID(), verifier });
    assertCurrent(id); const next = await api.signInGoogle(token); await acceptSession(next, id);
  });
}
export async function cloudResetPassword(email: string) {
  await run(async () => {
    if (!api || !email.trim()) throw new Error('Введи почту своего аккаунта.');
    await api.resetPassword(email);
    patch({ message: 'Если аккаунт с этой почтой существует, придёт письмо для смены пароля. Проверь также папку Спам.' });
  });
}
async function check(id: number, resume = false) {
  const current = await credentials(); assertCurrent(id);
  const head = await api!.head(current); assertCurrent(id);
  const pref = readPreference();
  const accepted = Boolean(head && ((resume && pref?.revision === head.revision) || (get(cloudProfile).accepted && baseline?.revision === head.revision)));
  baseline = head;
  // A different cloud revision requires a deliberate choice before autosaving.
  const auto = Boolean((resume || get(cloudProfile).auto) && head && pref?.auto && pref.revision === head.revision);
  patch({ head, auto, accepted, preview: null, conflict: false, message: head ? 'В аккаунте есть копия. Посмотри её перед загрузкой на этот компьютер.' : 'В аккаунте пока пусто. Нажми Сохранить в облако, чтобы перенести сюда свои данные.' });
}
export async function cloudCheck() { await run(id => check(id)); }
export async function cloudPreview() {
  await run(async id => {
    const current = await credentials(); assertCurrent(id);
    const head = await api!.head(current); assertCurrent(id);
    if (!head) { baseline = null; patch({ head: null, preview: null, auto: false, message: 'Облачной копии пока нет.' }); return; }
    const preview = await api!.download(current, head); assertCurrent(id);
    baseline = head;
    patch({ head, preview, auto: false, accepted: false, conflict: false, message: 'Копия проверена. Загрузка заменит данные на этом компьютере.' });
    savePreference(false);
  });
}
async function upload(id: number) {
  const current = await credentials(); assertCurrent(id);
  const capturedVersion = changeVersion;
  const backup = await captureLomiBackup(); assertCurrent(id);
  if (backupRestoreInProgress()) throw new Error('Дождись завершения восстановления.');
  const head = await api!.upload(current, backup, baseline); assertCurrent(id);
  baseline = head; dirty = changeVersion !== capturedVersion;
  savePreference(get(cloudProfile).auto);
  patch({ head, preview: null, accepted: true, conflict: false, message: 'Копия сохранена в аккаунте. На другом компьютере войди с той же почтой и нажми Посмотреть копию.' });
}
export async function cloudUpload(replaceExisting = false) {
  await run(async id => {
    const firstChoice = !get(cloudProfile).accepted;
    if (baseline && !get(cloudProfile).accepted && !replaceExisting) throw new Error('Подтверди замену копии в аккаунте или сначала загрузи её на компьютер.');
    await upload(id);
    if (firstChoice) { savePreference(true); patch({ auto: true }); }
  });
}
export async function cloudRestore() {
  await run(async id => {
    const preview = get(cloudProfile).preview;
    if (!preview) throw new Error('Сначала нажми Посмотреть копию.');
    patch({ message: 'Сначала сохрани текущие данные в отдельный .lomi.' });
    if (!await saveLomiBackup(await captureLomiBackup(), true)) { patch({ message: 'Загрузка отменена. Данные не изменены.' }); return; }
    assertCurrent(id);
    // Cloud copies never erase this PC's local audio metadata or import paths from another PC.
    const localTracks = await getTracks(), local = new Map(localTracks.map(track => [String(track.id), track]));
    const names = new Map<string, any>();
    const trackName = (track: any) => `${track.title}\u0000${track.artist}`.normalize('NFKC').toLocaleLowerCase('ru');
    for (const track of localTracks) { const key = trackName(track); names.set(key, names.has(key) ? null : track); }
    const data = structuredClone(preview.data); data.localTracks = localTracks;
    for (const list of [data.likes, data.dislikes, ...data.playlists.map(list => list.tracks)]) {
      for (const track of list) if (track.isLocal || track.source === 'Локальный') {
        const match = local.get(String(track.id)) || names.get(trackName(track));
        track.audioUrl = match?.audioUrl || ''; if (match) track.id = match.id;
      }
    }
    assertCurrent(id); await restoreLomiBackup({ ...preview, data }); assertCurrent(id);
    dirty = false; savePreference(true);
    patch({ auto: true, accepted: true, preview: null, message: 'Данные из аккаунта загружены. Автосохранение включено. Подключения музыкальных сервисов настраиваются на каждом компьютере отдельно.' });
  });
}
export function cloudSetAuto(auto: boolean) {
  if (!session || !baseline || !get(cloudProfile).accepted || get(cloudProfile).conflict || get(cloudProfile).busy) return;
  try { savePreference(auto); dirty = auto; patch({ auto, error: '' }); }
  catch { patch({ auto: false, error: 'Не удалось сохранить настройку на этом компьютере.' }); }
}
export async function cloudSignOut() {
  if (get(cloudProfile).busy) return;
  await run(async () => {
    if (isTauri()) await deleteSecret(SECRET);
    localStorage.removeItem(SESSION_KEY);
    generation++; session = null; baseline = null; dirty = false;
    patch({ email: '', head: null, preview: null, auto: false, accepted: false, busy: false, conflict: false, error: '', message: 'Выход выполнен. Данные на компьютере сохранены.' });
  });
}
export function startCloudProfile() {
  if (!startup) startup = (async () => {
    if (!api || !isTauri()) { patch({ ready: true }); return; }
    try { cloudGoogleReady.set(await invoke<boolean>('google_sign_in_available')); } catch { cloudGoogleReady.set(false); }
    await whenSecretsReady();
    await run(async id => {
      const account = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!account || account.projectId !== config.projectId) return;
      const token = await getSecret(SECRET); if (!token) return;
      const next = await api.refresh(token, account.email); assertCurrent(id);
      if (next.uid !== account.uid) throw new Error('Аккаунт изменился. Войди заново.');
      await saveSecret(SECRET, next.refreshToken); assertCurrent(id); session = next;
      patch({ email: next.email }); await check(id, true);
    });
    patch({ ready: true });
  })();
  const subscriptions = [listenStats, likedTracks, dislikedTracks, playlists, settings, equalizerBands, equalizerProfiles, activeEqualizerPreset, globalVolume, searchHistory, achievementUnlocks]
    .map(store => store.subscribe(() => { if (!backupRestoreInProgress()) { changeVersion++; dirty = true; } }));
  // One bounded copy per five minutes at most, only when data changed.
  const timer = setInterval(() => {
    const state = get(cloudProfile);
    if (session && state.auto && !state.busy && dirty && !backupRestoreInProgress()) void run(upload);
  }, 5 * 60 * 1000);
  return () => { subscriptions.forEach(unsubscribe => unsubscribe()); clearInterval(timer); };
}
