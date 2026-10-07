import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactForLog, rememberSecret, installConsoleRedaction } from './logRedaction.ts';

test('text redaction covers authorization, JSON fields, query strings and session keys', () => {
  const cases = [
    'Authorization: Bearer fake-access', 'authorization="OAuth fake-yandex"',
    '{"access_token":"fake-access","refreshToken":"fake-refresh"}',
    'https://example.test/?token=fake-token&sk=fake-session&public=yes',
    'session key = fake-session', 'sharedSecret: fake-secret',
    'token%3Dfake-token&public=yes', 'Cookie: session=fake-cookie; other=fake-other'
  ];
  for (const value of cases) assert.ok(!redactText(value).includes('fake-'), redactText(value));
  assert.equal(redactText('status=403&client_id=public'), 'status=403&client_id=public');
});

test('known secret values are masked even when a server echoes them without a field name', () => {
  rememberSecret('fake+known/credential');
  assert.ok(!redactText('server echoed fake+known/credential').includes('credential'));
  assert.ok(!redactText('url/fake%2Bknown%2Fcredential').includes('credential'));
});

test('structured logs and errors are sanitized without mutating the source', () => {
  const source = { Authorization: 'fake-auth', nested: { sessionKey: 'fake-session', detail: 'token=fake-token' } };
  const clean = redactForLog(source);
  assert.ok(!JSON.stringify(clean).includes('fake-'));
  assert.equal(source.Authorization, 'fake-auth');
  assert.ok(!JSON.stringify(redactForLog(new Error('refresh_token=fake-refresh'))).includes('fake-refresh'));
});

test('cyclic objects and getters cannot cause unsafe log serialization', () => {
  const source = {};
  source.self = source;
  Object.defineProperty(source, 'getter', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.doesNotThrow(() => JSON.stringify(redactForLog(source)));
});

test('console wrapper sanitizes real console arguments', () => {
  const original = console.warn;
  let logged;
  console.warn = (...values) => { logged = values; };
  installConsoleRedaction();
  console.warn({ refresh_token: 'fake-refresh' }, 'Authorization: Bearer fake-access');
  assert.ok(!JSON.stringify(logged).includes('fake-'));
  console.warn = original;
});
