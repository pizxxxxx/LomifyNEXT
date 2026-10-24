// Explicit opt-in smoke test. Uses only temporary test accounts and their own
// synthetic documents; removes both documents and accounts in finally.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import ts from 'typescript';
if (!process.argv.includes('--live')) throw new Error('Use --live to test the configured Firebase project.');
const configText = await readFile(new URL('../src/lib/cloudConfig.ts', import.meta.url), 'utf8');
const config = { apiKey: configText.match(/apiKey:.*?\|\| '([^']+)'/)[1], projectId: configText.match(/projectId:.*?\|\| '([^']+)'/)[1] };
const urls = new Map();
async function moduleURL(name) {
  if (!urls.has(name)) {
    let source = await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
    for (const child of ['lomiBackupCore', 'logRedaction']) if (source.includes(`'./${child}'`)) source = source.replaceAll(`'./${child}'`, JSON.stringify(await moduleURL(child)));
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    urls.set(name, `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  }
  return urls.get(name);
}
const { CloudApi } = await import(await moduleURL('cloudApi'));
const { createLomiBackup } = await import(await moduleURL('lomiBackupCore'));
const api = new CloudApi(config), accounts = [];
const base = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
let uploaded = false, cleanupFailed = false;
try {
  for (let i = 0; i < 2; i++) accounts.push(await api.signIn(`lomify-smoke-${randomUUID()}@example.invalid`, randomBytes(24).toString('hex'), true));
  assert.equal(await api.head(accounts[0]), null);
  const backup = createLomiBackup({ settings: { glassMaterial: 'matte' }, stats: { listenSeconds: 123, tracksPlayed: 1, history: {} },
    likes: [], dislikes: [], playlists: [], localTracks: [], equalizer: { bands: Array(10).fill(0), preset: 'flat', profiles: [] }, achievements: {}, searchHistory: [], volume: .3 }, '9.6.3');
  const head = await api.upload(accounts[0], backup, null); uploaded = true;
  const restored = await api.download(accounts[0], head); assert.equal(restored.data.stats.listenSeconds, 123);
  const foreign = `${base}/users/${accounts[0].uid}/state/current`;
  const other = await fetch(foreign, { headers: { Authorization: `Bearer ${accounts[1].idToken}` }, signal: AbortSignal.timeout(20000) });
  assert.equal(other.status, 403, 'another account must not read the profile');
  const anonymous = await fetch(foreign, { signal: AbortSignal.timeout(20000) }); assert.equal(anonymous.status, 403);
  console.log('PASS live email registration, cloud write/read, integrity and owner isolation');
} catch (error) {
  console.error('FAIL live smoke:', error instanceof Error ? error.message : 'unknown failure'); process.exitCode = 1;
} finally {
  for (const [i, account] of accounts.entries()) {
    try {
      if (i === 0 && uploaded) {
        const prefix = `projects/${config.projectId}/databases/(default)/documents/users/${account.uid}`;
        const response = await fetch(`${base}:commit`, { method: 'POST', headers: { Authorization: `Bearer ${account.idToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: [{ delete: `${prefix}/chunks/part0` }, { delete: `${prefix}/state/current` }] }), signal: AbortSignal.timeout(20000) });
        assert.ok(response.ok, 'test document cleanup failed');
      }
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${config.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: account.idToken }), signal: AbortSignal.timeout(20000) });
      assert.ok(response.ok, 'test account cleanup failed');
    } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) { console.error('Temporary test cleanup needs attention.'); process.exitCode = 1; }
  else console.log('PASS all temporary test accounts and documents removed');
}
