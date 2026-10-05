import test from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, normalizeSearchText, trackSearchScore, searchCorrections, searchWithCorrections } from './searchText.ts';

test('exact matches precede prefixes and typos, including transposed letters', () => {
  const exact = { title: 'juggernaut', artist: 'shadowraze' };
  assert.ok(trackSearchScore(exact, 'juggernaut') > trackSearchScore({ title: 'juggernaut remix' }, 'juggernaut'));
  for (const query of ['juggernau', 'juggernatu', 'juggrnaut', 'juggwrnaut', 'shadwraze juggernatu']) {
    assert.ok(trackSearchScore(exact, query) > 0, query);
  }
  assert.equal(editDistance('juggernatu', 'juggernaut'), 1);
  assert.equal(trackSearchScore(exact, 'different music'), 0);
  assert.equal(normalizeSearchText('Ёлка - JUGGERNÅUT'), 'елка juggernaut');
});

test('corrections use close words without adding an unrelated artist', () => {
  assert.deepEqual(searchCorrections('juggernau', ['juggernaut', 'juggernaut sidney']), ['juggernaut']);
  assert.deepEqual(searchCorrections('shadwraze juggernatu', ['shadowraze', 'juggernaut']), ['shadowraze juggernaut']);
  assert.deepEqual(searchCorrections('cat', ['car', 'dog']), []);
});

test('remote suggestions recover incomplete catalog search and deduplicate results', async () => {
  const wanted = { id: 1, source: 'soundcloud', title: 'juggernaut', artist: 'shadowraze' };
  const requests = [];
  const result = await searchWithCorrections('juggernau', async query => {
    requests.push(query);
    return query === 'juggernaut' ? [wanted, wanted] : [{ id: 2, title: 'Bear', source: 'soundcloud' }];
  }, async () => ['juggernaut']);
  assert.deepEqual(requests, ['juggernau', 'juggernaut']);
  assert.equal(result.tracks[0].id, 1);
  assert.equal(result.tracks.filter(track => track.id === 1).length, 1);
  assert.equal(result.correctedQuery, 'juggernaut');
});

test('an unavailable suggestion service keeps results; catalog failure stays an error', async () => {
  const wanted = { id: 1, title: 'juggernaut' };
  assert.deepEqual((await searchWithCorrections('juggernaut', async () => [wanted], async () => { throw Error('offline'); })).tracks, [wanted]);
  await assert.rejects(searchWithCorrections('juggernau', async () => { throw Error('catalog offline'); }, async () => []), /catalog offline/);
});

test('a complete exact query avoids unrelated corrections while an incomplete exact title can be completed', async () => {
  const calls = [];
  const wanted = { id: 1, title: 'juggernaut' };
  const exact = await searchWithCorrections('juggernaut', async q => { calls.push(q); return [wanted]; }, async () => ['juggernaut sidney', 'juggernautti']);
  assert.deepEqual(calls, ['juggernaut']);
  assert.equal(exact.correctedQuery, undefined);
  const incomplete = await searchWithCorrections('juggernau', async q => q === 'juggernau' ? [{ id: 2, title: 'juggernau' }] : [wanted], async () => ['juggernaut']);
  assert.equal(incomplete.correctedQuery, 'juggernaut');
  assert.ok(incomplete.tracks.some(t => t.id === 1));
});

test('bounded prefix fallback keeps relevant candidates and rejects unrelated music', async () => {
  let calls = 0;
  const result = await searchWithCorrections('juggernatu', async () => ++calls === 1 ? [] : [
    { id: 1, title: 'juggernaut' }, { id: 2, title: 'Totally different' }
  ], async () => []);
  assert.equal(calls, 2);
  assert.deepEqual(result.tracks.map(track => track.id), [1]);
});
