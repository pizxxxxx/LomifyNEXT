import { parseLomiBackup, type LomiBackup } from './lomiBackupCore';
import { rememberSecret } from './logRedaction';

export interface CloudConfig { apiKey: string; projectId: string }
export interface CloudSession { uid: string; email: string; idToken: string; refreshToken: string; expiresAt: number }
export interface CloudHead { revision: string; chunks: number; bytes: number; hash: string; createdAt: string; appVersion: string; updateTime: string }
export const CLOUD_MAX_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 128;
export class CloudConflict extends Error { constructor() { super('В облаке появилась другая копия. Нажми Проверить облако и выбери, какие данные сохранить.'); } }
function safeError(code: string, status: number): Error {
  if (status === 409 || ['FAILED_PRECONDITION', 'ABORTED', 'ALREADY_EXISTS'].includes(code)) return new CloudConflict();
  const messages: Record<string, string> = {
    EMAIL_EXISTS: 'Эта почта уже зарегистрирована. Нажми Войти или Восстановить пароль.',
    INVALID_LOGIN_CREDENTIALS: 'Проверь почту и пароль.', INVALID_PASSWORD: 'Проверь почту и пароль.', EMAIL_NOT_FOUND: 'Проверь почту и пароль.',
    INVALID_EMAIL: 'Введи почту полностью, например name@example.com.', WEAK_PASSWORD: 'Придумай пароль длиной от 6 символов.',
    OPERATION_NOT_ALLOWED: 'В проекте ещё не включён вход по почте и паролю.',
    ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL: 'Для этой почты уже выбран другой способ входа. Войди прежним способом.',
    INVALID_IDP_RESPONSE: 'Google не подтвердил вход в этот проект. Проверь подключение Google в Firebase.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Слишком много попыток. Подожди и повтори вход.',
    USER_DISABLED: 'Этот аккаунт отключён.', INVALID_REFRESH_TOKEN: 'Войди в аккаунт заново.', TOKEN_EXPIRED: 'Войди в аккаунт заново.',
    PERMISSION_DENIED: 'Облако закрыло доступ. Проверь вход и установленные правила Firestore.',
    RESOURCE_EXHAUSTED: 'Бесплатный лимит облака исчерпан. Повтори позже или сохрани файл .lomi.',
    API_KEY_INVALID: 'Подключение облака ещё не настроено.'
  };
  return new Error(messages[code.split(' : ')[0]] || (status === 401 ? 'Войди в аккаунт заново.' : 'Не удалось обратиться к облаку. Проверь интернет и повтори действие.'));
}
function uid(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Некорректный облачный аккаунт. Войди заново.');
  return value;
}
async function hash(source: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export class CloudApi {
  private base: string;
  constructor(private config: CloudConfig, private transport: typeof fetch = fetch) {
    if (!/^[a-z0-9][a-z0-9-]{4,60}$/.test(config.projectId) || !/^[a-zA-Z0-9_-]{20,200}$/.test(config.apiKey)) throw new Error('Подключение облака ещё не настроено.');
    this.base = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
  }
  private async request(url: string, init: RequestInit = {}, allowMissing = false): Promise<any> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await this.transport(url, { ...init, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (allowMissing && response.status === 404) return null;
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code = ['FAILED_PRECONDITION', 'ABORTED', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED'].includes(body?.error?.status)
          ? body.error.status : body?.error?.message || body?.error?.status || '';
        throw safeError(String(code), response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Облако долго не отвечает. Проверь интернет и повтори действие.');
      if (error instanceof TypeError) throw new Error('Нет связи с облаком. Проверь интернет и повтори действие.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  private auth(method: string, data: unknown) {
    return this.request(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${this.config.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
  }
  async signIn(email: string, password: string, register = false): Promise<CloudSession> {
    rememberSecret(password);
    const body = await this.auth(register ? 'signUp' : 'signInWithPassword', { email: email.trim(), password, returnSecureToken: true });
    return this.session(body.localId, body.email, body.idToken, body.refreshToken, body.expiresIn);
  }
  async refresh(refreshToken: string, email: string): Promise<CloudSession> {
    rememberSecret(refreshToken);
    const body = await this.request(`https://securetoken.googleapis.com/v1/token?key=${this.config.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
    });
    return this.session(body.user_id, email, body.id_token, body.refresh_token, body.expires_in);
  }
  private session(id: string, email: string, idToken: string, refreshToken: string, expires: string): CloudSession {
    if (typeof idToken !== 'string' || typeof refreshToken !== 'string' || !idToken || !refreshToken) throw new Error('Не удалось подтвердить вход. Повтори действие.');
    rememberSecret(idToken); rememberSecret(refreshToken);
    return { uid: uid(id), email: String(email || ''), idToken, refreshToken, expiresAt: Date.now() + Math.min(3600, Number(expires) || 3600) * 1000 };
  }
  async resetPassword(email: string) { await this.auth('sendOobCode', { requestType: 'PASSWORD_RESET', email: email.trim() }); }
  async signInGoogle(idToken: string): Promise<CloudSession> {
    rememberSecret(idToken);
    const body = await this.auth('signInWithIdp', {
      postBody: new URLSearchParams({ id_token: idToken, providerId: 'google.com' }).toString(),
      requestUri: `https://${this.config.projectId}.firebaseapp.com`, returnSecureToken: true
    });
    if (body.needConfirmation || !body.idToken) throw new Error('Для этой почты уже выбран другой способ входа. Войди прежним способом.');
    return this.session(body.localId, body.email, body.idToken, body.refreshToken, body.expiresIn);
  }
  private headers(session: CloudSession) { return { Authorization: `Bearer ${session.idToken}`, 'Content-Type': 'application/json' }; }
  private path(session: CloudSession, suffix: string) { return `${this.base}/users/${uid(session.uid)}/${suffix}`; }
  async head(session: CloudSession): Promise<CloudHead | null> {
    const doc = await this.request(this.path(session, 'state/current'), { headers: this.headers(session) }, true);
    if (!doc) return null;
    const f = doc.fields || {};
    const result = { revision: f.revision?.stringValue, chunks: Number(f.chunks?.integerValue), bytes: Number(f.bytes?.integerValue),
      hash: f.hash?.stringValue, createdAt: f.createdAt?.stringValue, appVersion: f.appVersion?.stringValue, updateTime: doc.updateTime };
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(result.revision || '') || !Number.isInteger(result.chunks) || result.chunks < 1 || result.chunks > MAX_CHUNKS
      || !Number.isInteger(result.bytes) || result.bytes < 1 || result.bytes > CLOUD_MAX_BYTES || !/^[a-f0-9]{64}$/.test(result.hash || '')
      || !Number.isFinite(Date.parse(result.createdAt)) || !Number.isFinite(Date.parse(result.updateTime)) || typeof result.appVersion !== 'string') {
      throw new Error('Облачная копия повреждена. Используй сохранённый файл .lomi.');
    }
    return result;
  }
  async download(session: CloudSession, head: CloudHead): Promise<LomiBackup> {
    const parts: string[] = [];
    // Bounded concurrency and revision checks prevent mixing two devices' snapshots.
    for (let offset = 0; offset < head.chunks; offset += 4) {
      const group = await Promise.all(Array.from({ length: Math.min(4, head.chunks - offset) }, async (_, n) => {
        const doc = await this.request(this.path(session, `chunks/part${offset + n}`), { headers: this.headers(session) });
        if (doc?.fields?.revision?.stringValue !== head.revision || typeof doc?.fields?.payload?.stringValue !== 'string' || doc.fields.payload.stringValue.length > 100001) throw new CloudConflict();
        return doc.fields.payload.stringValue as string;
      }));
      parts.push(...group);
    }
    const source = parts.join('');
    if (new TextEncoder().encode(source).byteLength !== head.bytes || await hash(source) !== head.hash) throw new Error('Облачная копия не прошла проверку целостности. Текущие данные не изменены.');
    const latest = await this.head(session);
    if (latest?.revision !== head.revision) throw new CloudConflict();
    return parseLomiBackup(source);
  }
  async upload(session: CloudSession, backup: LomiBackup, previous: CloudHead | null): Promise<CloudHead> {
    const clean = parseLomiBackup(JSON.stringify(backup));
    // Absolute local paths belong to this computer, never to a cloud account.
    clean.data.localTracks = [];
    for (const list of [clean.data.likes, clean.data.dislikes, Object.values(clean.data.stats.history), ...clean.data.playlists.map(list => list.tracks)]) {
      for (const track of list) if (track.isLocal || track.source === 'Локальный') {
        if ('audioUrl' in track) track.audioUrl = '';
        if (track.id !== undefined) track.id = `local-meta-${await hash(String(track.id))}`;
      }
    }
    const source = JSON.stringify(clean), bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > CLOUD_MAX_BYTES) throw new Error('Облачная копия больше 4 МБ. Уменьши свои обложки или используй файл .lomi: он поддерживает 64 МБ.');
    const revision = crypto.randomUUID(), digest = await hash(source), parts: string[] = [];
    for (let offset = 0; offset < source.length;) {
      let end = Math.min(offset + 100000, source.length);
      if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
      parts.push(source.slice(offset, end)); offset = end;
    }
    if (parts.length > MAX_CHUNKS) throw new Error('Облачная копия слишком велика. Сохрани файл .lomi.');
    const name = (suffix: string) => this.path(session, suffix).replace('https://firestore.googleapis.com/v1/', '');
    const fields = { revision: { stringValue: revision }, chunks: { integerValue: String(parts.length) }, bytes: { integerValue: String(bytes) },
      hash: { stringValue: digest }, createdAt: { stringValue: clean.createdAt }, appVersion: { stringValue: clean.appVersion } };
    const writes: any[] = parts.map((payload, i) => ({ update: { name: name(`chunks/part${i}`), fields: { revision: { stringValue: revision }, payload: { stringValue: payload } } } }));
    for (let i = parts.length; i < (previous?.chunks || 0); i++) writes.push({ delete: name(`chunks/part${i}`) });
    writes.push({ update: { name: name('state/current'), fields }, currentDocument: previous ? { updateTime: previous.updateTime } : { exists: false } });
    const body = JSON.stringify({ writes });
    if (new TextEncoder().encode(body).byteLength > 9 * 1024 * 1024) throw new Error('Слишком большой запрос к облаку. Используй файл .lomi.');
    const response = await this.request(`${this.base}:commit`, { method: 'POST', headers: this.headers(session), body });
    const updateTime = response?.writeResults?.at(-1)?.updateTime;
    if (!Number.isFinite(Date.parse(updateTime))) throw new Error('Облако не подтвердило сохранение. Нажми Проверить облако.');
    return { revision, chunks: parts.length, bytes, hash: digest, createdAt: clean.createdAt, appVersion: clean.appVersion, updateTime };
  }
}
