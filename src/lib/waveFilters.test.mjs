import test from 'node:test';
import assert from 'node:assert/strict';
import { trackMatchesWaveFilters, languageFromWaveLyrics } from './waveFilters.ts';
import { waveStationForFilters, waveStationSettings } from './waveStationCore.ts';
import { sanitizeWaveHistory, waveHistoryEntry } from './waveHistoryCore.ts';

const song = { id: '12', title: 'DRIVE', artist: 'Русское имя', source: 'yandex' };
test('missing lyric assets are not evidence of an instrumental recording', () => {
  assert.equal(trackMatchesWaveFilters({ ...song, lyricsAvailable: false }, { waveContent: 'instrumental' }), false);
  assert.equal(trackMatchesWaveFilters({ ...song, lyricsAvailable: false }, { waveContent: 'instrumental' }, { serverLanguage: 'without-words' }), true);
  assert.equal(trackMatchesWaveFilters({ ...song, lyricsAvailable: true }, { waveContent: 'instrumental' }, { serverLanguage: 'without-words' }), false);
  assert.equal(trackMatchesWaveFilters({ ...song, title: 'DRIVE (Instrumental)', lyricsAvailable: true }, { waveContent: 'instrumental' }), true);
  assert.equal(trackMatchesWaveFilters(song, { waveContent: 'lyrics' }), false);
});
test('language is verified by metadata, real lyrics or Russian server filter, never an artist name', () => {
  assert.equal(trackMatchesWaveFilters(song, { waveLanguage: 'ru' }), false);
  assert.equal(trackMatchesWaveFilters(song, { waveLanguage: 'en' }, { serverLanguage: 'not-russian' }), false);
  assert.equal(trackMatchesWaveFilters(song, { waveLanguage: 'ru' }, { serverLanguage: 'russian' }), true);
  assert.equal(trackMatchesWaveFilters({ ...song, lyricsLanguage: 'en' }, { waveLanguage: 'ru' }, { serverLanguage: 'russian' }), false);
  assert.equal(languageFromWaveLyrics('[00:12.00] I want you with me and my love tonight'), 'en');
  assert.equal(languageFromWaveLyrics('[00:12.00] Я хочу услышать музыку и голос этой ночью'), 'ru');
  assert.equal(languageFromWaveLyrics('[00:12.00] Je suis dans la rue et les étoiles brillent'), 'other');
  assert.equal(languageFromWaveLyrics('[00:12.00] ♪ ♪ ♪'), '');
});
test('catalogue station IDs use supported aliases and unknown genres stay locally constrained', () => {
  const available = new Set(['genre:allrock', 'genre:rusrock', 'genre:electronics', 'genre:phonkgenre']);
  assert.equal(waveStationForFilters({ waveGenre: 'rock' }, available), 'genre:allrock');
  assert.equal(waveStationForFilters({ waveGenre: 'rock', waveLanguage: 'ru' }, available), 'genre:rusrock');
  assert.equal(waveStationForFilters({ waveGenre: 'electronic' }, available), 'genre:electronics');
  assert.equal(waveStationForFilters({ waveGenre: 'phonk' }, available), 'genre:phonkgenre');
  assert.equal(waveStationForFilters({ waveGenre: 'pop' }, available), 'user:onyourwave');
  assert.equal(trackMatchesWaveFilters(song, { waveGenre: 'rock' }), false);
  assert.equal(trackMatchesWaveFilters(song, { waveGenre: 'rock' }, { station: 'genre:allrock' }), true);
  assert.equal(trackMatchesWaveFilters({ ...song, genre: 'rap' }, { waveGenre: 'rock' }, { station: 'genre:allrock' }), false);
  assert.equal(trackMatchesWaveFilters(song, { waveGenre: 'rock' }, { station: 'genre:electronics' }), false);
  assert.equal(waveStationForFilters({ waveGenre: 'lofi' }, new Set(['genre:lounge', 'genre:relax'])), 'user:onyourwave');
  assert.equal(trackMatchesWaveFilters(song, { waveGenre: 'lofi' }, { station: 'genre:lounge' }), false);
  assert.equal(trackMatchesWaveFilters({ ...song, title: 'Jazz' }, { waveGenre: 'jazz' }), false);
});
test('server filter payload preserves mood and discoveries and checks supported values', () => {
  const info = { settings2: { moodEnergy: 'calm', diversity: 'discover' }, station: { restrictions2: { language: { possibleValues: [{ value: 'without-words' }] } } } };
  assert.deepEqual(waveStationSettings(info, { waveContent: 'instrumental' }), { language: 'without-words', moodEnergy: 'calm', diversity: 'discover', type: 'rotor' });
  assert.throws(() => waveStationSettings(info, { waveLanguage: 'ru' }), /не поддерживает/);
});
test('wave history records marked listens and never stores remote URLs, secrets or live station feedback markers', () => {
  assert.equal(waveHistoryEntry(song), null);
  const entry = waveHistoryEntry({ ...song, waveBatchId: 'batch', waveStation: 'user:onyourwave', audioUrl: 'https://example.test/signed?token=secret', token: 'secret' }, 1);
  assert.equal(entry.track.audioUrl, undefined);
  assert.equal(entry.track.waveBatchId, undefined);
  assert.equal(entry.track.token, undefined);
  const stored = sanitizeWaveHistory([...Array.from({ length: 250 }, (_, i) => ({ ...entry, playedAt: i + 1 })), {}, { ...entry, playedAt: undefined }]);
  assert.equal(stored.length, 200); assert.equal(stored[0].playedAt, 250);
});
