import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const urls = new Map();
async function load(name) {
  if (!urls.has(name)) {
    let source = await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
    for (const child of ['lomiBackupCore', 'logRedaction']) {
      if (source.includes(`'./${child}'`)) source = source.replaceAll(`'./${child}'`, JSON.stringify(await load(child)));
    }
    source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    urls.set(name, `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  }
  return urls.get(name);
}
const core = await import(await load('lomiBackupCore'));
const { CloudApi, CloudConflict } = await import(await load('cloudApi'));
const badges = await import(await load('achievementsCore'));
const { MATTE_PALETTES } = await import(await load('mattePalettes'));
const welcome = await import(await load('accountWelcomeCore'));
test('first-run authorization is optional and upgrades are detected without changing existing data', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null };
  assert.equal(welcome.accountWelcomeKind(storage), 'new');
  values.set('lomifynext_settings', '{"design":"classic"}');
  assert.equal(welcome.accountWelcomeKind(storage), 'upgrade');
  assert.equal(values.get('lomifynext_settings'), '{"design":"classic"}');
  values.set(welcome.ACCOUNT_WELCOME_PENDING_KEY, 'new');
  assert.equal(welcome.accountWelcomeKind(storage), 'new', 'interrupted first launch keeps its welcome after defaults are saved');
  values.set(welcome.ACCOUNT_WELCOME_KEY, '{"choice":"offline"}');
  assert.equal(welcome.accountWelcomeKind(storage), 'done');
});
const flat = () => Array(10).fill(0);
const track = (id = 'song1') => ({ id, source: 'yandex', title: 'Песня', artist: 'Артист', coverUrl: '', audioUrl: 'https://example.test/signed?token=secret' });
function data() {
  return { settings: { design: 'liquid-glass', glassMaterial: 'matte', mattePalette: 'graphite-rose', matteBlur: true, glassPanelWidth: null },
    stats: { listenSeconds: 3800, tracksPlayed: 2, history: { song: { ...track(), count: 2 } } },
    likes: [track()], dislikes: [], playlists: [{ id: 'list', title: 'Подборка', sync: { token: 'private' }, tracks: [track(), track()] }],
    localTracks: [], equalizer: { bands: flat(), preset: 'flat', profiles: [] }, achievements: { hour: Date.now() }, searchHistory: ['Артист'], volume: .3 };
}
const backup = () => core.createLomiBackup(data(), '9.6.3');
test('.lomi round-trip retains intentional track repetitions, Unicode and real statistics', () => {
  const result = core.parseLomiBackup('\uFEFF' + JSON.stringify(backup()));
  assert.equal(result.data.playlists[0].tracks.length, 2);
  assert.equal(result.data.stats.listenSeconds, 3800);
  assert.equal(result.data.likes[0].title, 'Песня');
});
test('.lomi removes account credentials, bindings and temporary stream URLs', () => {
  const input = data(); input.settings.yandexToken = 'private'; input.settings.spotifyUser = { id: 'private' };
  const source = JSON.stringify(core.createLomiBackup(input, '9.6.3'));
  assert.ok(!source.includes('private')); assert.ok(!source.includes('signed?token'));
  assert.equal(core.parseLomiBackup(source).data.likes[0].audioUrl, '');
});
test('corrupt files and unsupported versions are rejected before restoration', () => {
  for (const source of ['broken', '{}', JSON.stringify({ ...backup(), version: 2 }), JSON.stringify({ ...backup(), createdAt: 'not a date' })]) assert.throws(() => core.parseLomiBackup(source));
});
test('unsafe settings, prototype keys, duplicate local IDs and malformed EQ are rejected', () => {
  const mutations = [
    value => value.settings.playbackRate = -1, value => value.settings.glassPanelWidth = 'huge',
    value => value.settings.matteBlur = 'true', value => value.settings.glassQuality = 'extreme',
    value => value.stats.history = JSON.parse('{"__proto__":{"title":"x","artist":"y","count":1}}'),
    value => value.localTracks = [{ ...track('local-a'), isLocal: true }, { ...track('local-a'), isLocal: true }],
    value => value.equalizer.bands[0] = Infinity,
    value => value.equalizer.profiles = [{ id: 'ok', name: 'A', gains: flat() }, { id: 'other', name: 'a', gains: flat() }]
  ];
  for (const mutate of mutations) { const input = data(); mutate(input); assert.throws(() => core.normalizeLomiData(input)); }
});
test('local file copies keep filesystem paths but reject network audio masquerading as local', () => {
  const input = data(); input.localTracks = [{ ...track('local-a'), isLocal: true, audioUrl: 'C:\\Music\\Песня.flac' }];
  assert.equal(core.normalizeLomiData(input).localTracks[0].audioUrl, 'C:\\Music\\Песня.flac');
  input.localTracks[0].audioUrl = 'https://example.test/audio'; assert.equal(core.normalizeLomiData(input).localTracks[0].audioUrl, '');
});
test('achievements count qualified history and survive a later reduction of likes', () => {
  const input = data(); input.stats.history.ignored = { artist: 'Другой', count: 0 };
  const facts = badges.achievementFacts(input.stats, input.likes, input.playlists);
  assert.equal(facts.tracks, 1); assert.equal(facts.artists, 1);
  const result = badges.achievementProgress({ ...facts, likes: 0 }, { 'ten-likes': Date.now() });
  assert.equal(result.find(item => item.id === 'ten-likes').unlocked, true);
  assert.equal(result.find(item => item.id === 'hour').value, 3600);
  assert.deepEqual(badges.normalizeAchievementUnlocks({ hour: 10, arbitrary: 1, 'first-play': Infinity }), { hour: 10 });
});

function backend() {
  let docs = new Map(), tick = 0;
  const calls = []; let fail = false;
  const transport = async (url, options = {}) => {
    calls.push({ url, options });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('accounts:signInWithPassword') || url.includes('accounts:signInWithIdp')) return json({ localId: 'user-a', email: 'a@example.test', idToken: 'private-id-token', refreshToken: 'private-refresh-token', expiresIn: '3600' });
    if (url.includes('securetoken.googleapis.com')) return json({ user_id: 'user-a', id_token: 'new-id-token', refresh_token: 'new-refresh-token', expires_in: '3600' });
    if (!url.includes('firestore.googleapis.com')) throw new Error('unexpected origin');
    if (options.headers.Authorization !== 'Bearer private-id-token') return json({ error: { status: 'PERMISSION_DENIED' } }, 403);
    if (url.endsWith(':commit')) {
      if (fail) return json({ error: { status: 'UNAVAILABLE' } }, 503);
      const writes = JSON.parse(options.body).writes;
      for (const write of writes) if (write.currentDocument) {
        const old = docs.get(write.update.name), condition = write.currentDocument;
        if (condition.exists === false && old || condition.updateTime && old?.updateTime !== condition.updateTime) return json({ error: { status: 'FAILED_PRECONDITION' } }, 400);
      }
      const next = new Map(docs), updateTime = new Date(Date.UTC(2026, 9, 24, 0, 0, ++tick)).toISOString();
      for (const write of writes) { if (write.delete) next.delete(write.delete); else next.set(write.update.name, { ...write.update, updateTime }); }
      docs = next; return json({ writeResults: writes.map(() => ({ updateTime })) });
    }
    const name = url.replace('https://firestore.googleapis.com/v1/', '');
    return docs.has(name) ? json(docs.get(name)) : json({ error: { status: 'NOT_FOUND' } }, 404);
  };
  return { transport, calls, docs: () => docs, fail: () => { fail = true; } };
}
const config = { projectId: 'lomify-test', apiKey: 'public-key-for-tests-only' };
const session = { uid: 'user-a', email: 'a@example.test', idToken: 'private-id-token', refreshToken: 'private-refresh-token', expiresAt: Date.now() + 3600000 };
test('email sign-in and refresh use official endpoints without cookies and redact their credentials', async () => {
  const fake = backend(), api = new CloudApi(config, fake.transport);
  assert.equal((await api.signIn(' a@example.test ', 'fake-password')).uid, 'user-a');
  assert.equal((await api.refresh('private-refresh-token', session.email)).idToken, 'new-id-token');
  assert.equal(fake.calls[0].options.credentials, 'omit');
  assert.equal(JSON.parse(fake.calls[0].options.body).email, 'a@example.test');
  assert.ok(fake.calls[1].options.body.includes('grant_type=refresh_token'));
  const redaction = await import(await load('logRedaction'));
  assert.ok(!JSON.stringify(redaction.redactForLog({ idToken: 'unknown-token', id_token: 'other', password: 'pass' })).includes('unknown-token'));
  assert.ok(!redaction.redactText('id_token=unregistered-value').includes('unregistered-value'));
});
test('Google confirmation is exchanged for a Firebase session only through the configured project', async () => {
  const fake = backend(), api = new CloudApi(config, fake.transport);
  const result = await api.signInGoogle('private-google-id-token');
  assert.equal(result.uid, 'user-a');
  const body = JSON.parse(fake.calls[0].options.body), params = new URLSearchParams(body.postBody);
  assert.equal(params.get('providerId'), 'google.com'); assert.equal(params.get('id_token'), 'private-google-id-token');
  assert.equal(body.requestUri, 'https://lomify-test.firebaseapp.com'); assert.equal(body.returnSecureToken, true);
});
test('cloud writes are atomic, chunked, reversible and verified by digest', async () => {
  const fake = backend(), api = new CloudApi(config, fake.transport), input = backup();
  input.data.likes[0].title = 'Музыка'.repeat(400); input.data.searchHistory = Array.from({ length: 150 }, (_, i) => `${i} ${'Ю'.repeat(3000)}`);
  const head = await api.upload(session, input, null); assert.ok(head.chunks > 1);
  const restored = await api.download(session, await api.head(session));
  assert.equal(restored.data.searchHistory.length, 150); assert.equal(restored.data.playlists[0].tracks.length, 2);
  assert.equal(fake.calls.filter(call => call.url.endsWith(':commit')).length, 1);
  assert.ok([...fake.docs().keys()].every(name => name.includes('/users/user-a/')));
});
test('concurrent devices cannot overwrite an unseen newer revision', async () => {
  const fake = backend(), api = new CloudApi(config, fake.transport), first = await api.upload(session, backup(), null);
  const next = await api.upload(session, backup(), first);
  await assert.rejects(api.upload(session, backup(), first), CloudConflict);
  await assert.rejects(api.upload(session, backup(), null), CloudConflict);
  assert.equal((await api.head(session)).revision, next.revision);
});
test('failed upload preserves prior copy and shrinking snapshots delete unused chunks', async () => {
  const fake = backend(), api = new CloudApi(config, fake.transport), input = backup();
  input.data.searchHistory = Array.from({ length: 60 }, () => 'x'.repeat(4000));
  const first = await api.upload(session, input, null); assert.ok(first.chunks > 1);
  const next = await api.upload(session, backup(), first);
  assert.equal(fake.docs().size, next.chunks + 1);
  fake.fail(); await assert.rejects(api.upload(session, backup(), next));
  assert.equal((await api.head(session)).revision, next.revision);
});
test('cloud strips local paths from both track URLs and local IDs, while file backup retains them', async () => {
  const fake = backend(), api = new CloudApi(config, fake.transport), input = backup();
  const local = { ...track('local-C:\\Users\\Private\\song.flac'), source: 'Локальный', isLocal: true, audioUrl: 'C:\\Users\\Private\\song.flac' };
  input.data.likes.push(local); input.data.localTracks.push(local); input.data.stats.history.local = { ...local, count: 1 };
  const head = await api.upload(session, input, null), restored = await api.download(session, head);
  assert.equal(restored.data.localTracks.length, 0); assert.ok(!JSON.stringify(restored).includes('Private'));
  assert.ok(JSON.stringify(input).includes('Private'));
});
test('cloud refuses oversized profiles, corrupt chunks and cross-owner path injection', async () => {
  const fake = backend(), api = new CloudApi(config, fake.transport), input = backup();
  input.data.searchHistory = Array.from({ length: 1000 }, () => 'Ю'.repeat(4000));
  await assert.rejects(api.upload(session, input, null), /4 МБ/);
  const head = await api.upload(session, backup(), null);
  const part = [...fake.docs().values()].find(doc => doc.fields.payload);
  part.fields.payload.stringValue = 'damaged'; await assert.rejects(api.download(session, head), /целостности/);
  await assert.rejects(api.head({ ...session, uid: '../user-b' }));
});
test('all six matte theme accents meet readable text contrast on their own background', () => {
  const lum = hex => {
    const values = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  };
  assert.equal(MATTE_PALETTES.length, 6);
  for (const p of MATTE_PALETTES) assert.ok((lum(p.accent) + .05) / (lum(p.background) + .05) >= 4.5, p.id);
});
