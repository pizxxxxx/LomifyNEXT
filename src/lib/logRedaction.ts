const MASK = '[скрыто]';
const knownSecrets = new Set<string>();
const sensitiveKey = /^(?:authorization|cookie|setcookie|xsessionid|accesstoken|refreshtoken|token|sessionkey|sk|sharedsecret|clientsecret|password|apisig|yandextoken|spotifyaccesstoken|spotifyrefreshtoken|lastfmsessionkey|lastfmsharedsecret)$/i;

export function rememberSecret(value: string): void {
  if (value.length < 6) return;
  knownSecrets.add(value);
  knownSecrets.add(encodeURIComponent(value));
  if (knownSecrets.size > 512) knownSecrets.delete(knownSecrets.values().next().value!);
}

export function redactText(value: string): string {
  let text = value.slice(0, 65_536);
  for (const secret of knownSecrets) text = text.split(secret).join(MASK);
  text = text.replace(/\b((?:authorization)["']?\s*[:=]\s*["']?\s*(?:(?:Bearer|OAuth|Basic)\s+)?)[^"'\s,;}]+/gi, `$1${MASK}`);
  text = text.replace(/\b(Bearer|OAuth|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`);
  text = text.replace(/\b((?:access[_ -]?token|refresh[_ -]?token|yandexToken|spotifyAccessToken|spotifyRefreshToken|lastfmSharedSecret|lastfmSessionKey|token|session[_ -]?key|shared[_ -]?secret|client[_ -]?secret|api_sig|sk|x-session-id)["']?\s*[:=]\s*["']?)[^"'&,;\s}\]]+/gi, `$1${MASK}`);
  text = text.replace(/\b((?:access_token|refresh_token|token|session_key|sk)%3[Dd])[^%&\s]+/gi, `$1${MASK}`);
  text = text.replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, `$1${MASK}`);
  return text;
}

export function redactForLog(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value) || depth > 8) return '[объект]';
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: redactText(value.message), stack: redactText(value.stack || '') };
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => redactForLog(entry, seen, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 200)) {
    output[key] = sensitiveKey.test(key.replace(/[^a-z]/gi, '')) ? MASK
      : 'value' in descriptor ? redactForLog(descriptor.value, seen, depth + 1) : '[свойство]';
  }
  return output;
}

let installed = false;
export function installConsoleRedaction(): void {
  if (installed) return;
  installed = true;
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'] as const) {
    const original = console[method].bind(console);
    console[method] = (...values: unknown[]) => original(...values.map((value) => redactForLog(value)));
  }
}
