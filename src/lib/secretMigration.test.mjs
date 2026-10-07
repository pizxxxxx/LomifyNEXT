import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_RECORDS, migrateRecord, withoutSecretFields } from './secretMigration.ts';

function fixture(failure = '') {
  const old = JSON.stringify({ clientId: 'public-client', expiresAt: 123, accessToken: 'fake-access', refreshToken: 'fake-refresh' });
  const data = new Map([['lomifynext_spotify_session', old]]);
  const values = new Map();
  const order = [];
  return { old, data, values, order,
    storage: { getItem: (key) => data.get(key) || null, setItem: (key, value) => { order.push('remove-old'); data.set(key, value); } },
    vault: {
      save: async (key, value) => { order.push(`save:${key}`); if (failure === 'write') throw new Error('write failed'); values.set(key, value); },
      read: async (key) => { order.push(`read:${key}`); if (failure === 'read') throw new Error('read failed'); return failure === 'mismatch' ? 'wrong-fake-value' : values.get(key) || null; }
    }
  };
}

test('migration verifies every credential before removing old secret fields', async () => {
  const f = fixture();
  const record = LEGACY_RECORDS[1];
  await migrateRecord(f.storage, f.vault, record.storageKey, record.fields);
  assert.deepEqual(JSON.parse(f.data.get(record.storageKey)), { clientId: 'public-client', expiresAt: 123 });
  assert.equal(f.values.get('spotify_refresh_token'), 'fake-refresh');
  assert.deepEqual(f.order, ['save:spotify_access_token', 'read:spotify_access_token', 'save:spotify_refresh_token', 'read:spotify_refresh_token', 'remove-old']);
});

for (const failure of ['write', 'read', 'mismatch']) test(`migration preserves original source when ${failure} fails`, async () => {
  const f = fixture(failure);
  const record = LEGACY_RECORDS[1];
  await assert.rejects(migrateRecord(f.storage, f.vault, record.storageKey, record.fields));
  assert.equal(f.data.get(record.storageKey), f.old);
  assert.ok(!f.order.includes('remove-old'));
});

test('a partial multi-key write keeps the old complete session for retry', async () => {
  const f = fixture();
  const save = f.vault.save;
  f.vault.save = async (key, value) => { if (key.endsWith('refresh_token')) throw new Error('second write failed'); await save(key, value); };
  await assert.rejects(migrateRecord(f.storage, f.vault, LEGACY_RECORDS[1].storageKey, LEGACY_RECORDS[1].fields));
  assert.equal(f.data.get(LEGACY_RECORDS[1].storageKey), f.old);
  f.vault.save = save;
  await migrateRecord(f.storage, f.vault, LEGACY_RECORDS[1].storageKey, LEGACY_RECORDS[1].fields);
  assert.ok(!f.data.get(LEGACY_RECORDS[1].storageKey).includes('fake-'));
});

test('settings serialization strips flat and nested credentials, retaining ordinary settings', () => {
  const settings = { volume: 0.5, yandexToken: 'fake-yandex', spotifyAccessToken: 'fake-access', spotifyRefreshToken: 'fake-refresh', lastfmSessionKey: 'fake-session', lastfmSharedSecret: 'fake-secret', spotify: { clientId: 'public', accessToken: 'fake-access', refreshToken: 'fake-refresh' }, lastfm: { username: 'listener', sharedSecret: 'fake-secret', sessionKey: 'fake-session' } };
  const clean = withoutSecretFields(settings, LEGACY_RECORDS[0].fields);
  assert.deepEqual(clean, { volume: 0.5, spotify: { clientId: 'public' }, lastfm: { username: 'listener' } });
  assert.equal(settings.yandexToken, 'fake-yandex');
});

test('an invalid saved record is preserved instead of silently deleting it', async () => {
  const f = fixture();
  f.data.set(LEGACY_RECORDS[1].storageKey, '{invalid');
  await assert.rejects(migrateRecord(f.storage, f.vault, LEGACY_RECORDS[1].storageKey, LEGACY_RECORDS[1].fields));
  assert.equal(f.data.get(LEGACY_RECORDS[1].storageKey), '{invalid');
});

test('failure to persist sanitized metadata leaves the original source intact', async () => {
  const f = fixture();
  f.storage.setItem = () => { throw new Error('browser storage unavailable'); };
  await assert.rejects(migrateRecord(f.storage, f.vault, LEGACY_RECORDS[1].storageKey, LEGACY_RECORDS[1].fields));
  assert.equal(f.data.get(LEGACY_RECORDS[1].storageKey), f.old);
  assert.equal(f.values.get('spotify_refresh_token'), 'fake-refresh');
});
