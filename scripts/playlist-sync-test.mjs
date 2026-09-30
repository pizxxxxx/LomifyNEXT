import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { get, writable } from 'svelte/store';
const require = createRequire(import.meta.url);
const url = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
function load(relative, imports = {}) {
  let source = readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
  for (const [name, target] of Object.entries(imports)) source = source.replaceAll("'" + name + "'", JSON.stringify(target));
  return url(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const coreUrl = load('src/lib/playlistSyncCore.ts');
const core = await import(coreUrl);
let checks = 0;
const check = (title, work) => { work(); checks++; console.log('PASS ' + title); };
const snap = keys => ({ title: 'Mix', keys });
check('both devices add tracks without loss', () => {
  assert.deepEqual(core.mergeSnapshots(snap(['a', 'b']), snap(['a', 'b', 'c']), snap(['a', 'b', 'd'])).value.keys, ['a', 'b', 'd', 'c']);
});
check('removal and independent addition merge', () => {
  assert.deepEqual(core.mergeSnapshots(snap(['a', 'b']), snap(['b', 'c']), snap(['a', 'b', 'd'])).value.keys, ['b', 'd', 'c']);
});
check('local insertion retains its position', () => {
  assert.deepEqual(core.mergeSnapshots(snap(['a', 'b']), snap(['a', 'c', 'b']), snap(['a', 'b', 'd'])).value.keys, ['a', 'c', 'b', 'd']);
});
check('opposing names require user choice', () => {
  assert.equal(core.mergeSnapshots(snap(['a']), {title:'Phone',keys:['a']}, {title:'PC',keys:['a']}).conflict, 'title');
});
check('opposing orders require user choice', () => {
  assert.equal(core.mergeSnapshots(snap(['a','b','c']), snap(['b','a','c']), snap(['a','c','b'])).conflict, 'order');
});
check('empty remote is a valid deletion', () => {
  assert.deepEqual(core.mergeSnapshots(snap(['a']), snap(['a']), snap([])).value.keys, []);
});
check('repeated tracks survive and missing album metadata is not a new track', () => {
  const tracks = [{id:'1',source:'yandex'}, {id:'1',source:'yandex',albumId:'20'}];
  assert.equal(new Set(core.trackKeys(tracks)).size, 2);
  assert.equal(core.trackKeys(tracks)[0], core.trackKeys([{...tracks[0],albumId:'20'}])[0]);
});
check('first migration preserves old copies without guessing deletions', () => {
  assert.deepEqual(core.mergeSnapshots(null, snap(['a','c']), snap(['a','b'])).value.keys, ['a','b','c']);
});
globalThis.localStorage = { values: new Map(), getItem(key){return this.values.get(key) ?? null;}, setItem(key,value){this.values.set(key,value);} };
globalThis.fixture = { settings: writable({yandexToken:'account100',yandexUser:{uid:100},syncYandexPlaylists:true,syncSoundCloudPlaylists:true,scUser:{id:200}}), playlists:writable([]),
  server: null, writes:[], failures:0, conflictOnce:false, switchOnRead:false, editOnWrite:null, sc:[] };
const f = globalThis.fixture;
const track = id => ({id:String(id),source:'yandex',albumId:'20',title:'Track '+id});
function server(tracks=[1,2], title='Mix') { return {kind:'7',owner:{uid:100},title,revision:1,tracks:tracks.map(id=>({id:String(id),albumId:'20',track:track(id)})),trackCount:tracks.length}; }
globalThis.fixture.request = async (address, token, init) => {
  if(f.failures) { f.failures--; throw new Error('offline'); }
  const route = new URL(address).pathname;
  if(route === '/account/status') return {account:{uid:100}};
  if(route.endsWith('/playlists/list')) return [{kind:'7',title:f.server.title,owner:{uid:100},revision:f.server.revision}];
  if(route === '/tracks') return new URL(address).searchParams.get('trackIds').split(',').map(id=>({...track(id),albums:[{id:'20'}]}));
  if(route.endsWith('/create')) { const form = new URLSearchParams(init.body); f.writes.push({create:true,visibility:form.get('visibility')}); return {kind:'7',revision:1}; }
  if(route.endsWith('/name')) { f.server.title = new URLSearchParams(init.body).get('value'); f.server.revision++; f.writes.push({rename:true}); return f.server; }
  if(route.endsWith('/change')) {
    const form = new URLSearchParams(init.body), diff = JSON.parse(form.get('diff'));
    if(f.conflictOnce) { f.conflictOnce=false; f.server.tracks.push({id:'5',albumId:'20',track:track(5)}); f.server.trackCount++; f.server.revision++; throw Object.assign(new Error('wrong-revision'),{status:409}); }
    assert.equal(Number(form.get('revision')),f.server.revision);
    const deletion = diff.find(item=>item.op==='delete');
    if(deletion) { assert.equal(deletion.to,f.server.tracks.length); f.server.tracks.splice(deletion.from,deletion.to-deletion.from); }
    const insertion = diff.find(item=>item.op==='insert');
    if(insertion) f.server.tracks.splice(insertion.at,0,...insertion.tracks.map(item=>({...item,track:track(item.id)})));
    f.server.trackCount=f.server.tracks.length; f.server.revision++; f.writes.push({diff});
    if(f.editOnWrite) { const work=f.editOnWrite; f.editOnWrite=null; work(); }
    return f.server;
  }
  if(route.endsWith('/7')) {
    if(f.switchOnRead) { f.switchOnRead=false; f.settings.update(value=>({...value,yandexToken:'another-account'})); }
    return structuredClone(f.server);
  }
  throw new Error('Unexpected endpoint '+route);
};
const svelteUrl = pathToFileURL(require.resolve('svelte/store')).href;
const storesUrl = url('export const settings=globalThis.fixture.settings; export const playlists=globalThis.fixture.playlists;');
const yandexUrl = url(`export const normalizeYandexToken=token=>token.trim();
export const ymJson=(...args)=>globalThis.fixture.request(...args);
export const mapYandexTrack=raw=>({...raw,source:'yandex'});
export async function yandexAccountStatus(token){return (await ymJson('https://api.music.yandex.net/account/status',token)).account;}`);
const serviceUrl = load('src/lib/yandexPlaylists.ts', {'$lib/yandex':yandexUrl});
const service = await import(serviceUrl);
const runtime = await import(load('src/lib/playlistSync.ts', {
  'svelte/store':svelteUrl, '$lib/stores':storesUrl, '$lib/playlistSyncStorage':url('export const playlistSyncReady=Promise.resolve(); export async function persistSyncedPlaylists(){}'),
  '$lib/playlistSyncCore':coreUrl,'$lib/yandex':yandexUrl,'$lib/yandexPlaylists':serviceUrl,
  '$lib/api':url('export async function getSoundCloudSyncPlaylists(){return structuredClone(globalThis.fixture.sc);}')
}));
async function seed() {
 f.settings.set({yandexToken:'account100',yandexUser:{uid:100},syncYandexPlaylists:true,syncSoundCloudPlaylists:true,scUser:{id:200}});
 f.server=server(); f.writes=[]; f.failures=0; f.conflictOnce=false; f.switchOnRead=false; f.editOnWrite=null;
 const remote=await service.readYandexPlaylist('account100','100','7');
 f.playlists.set([{...remote,sync:{provider:'yandex',accountId:'100',remoteId:remote.id,ownerId:'100',kind:'7',baseline:core.snapshot(remote)}}]);
}
async function asyncCheck(title,work){await seed(); await work(); checks++;console.log('PASS '+title);}
await asyncCheck('real revision payload merges phone and PC edits',async()=>{
 f.playlists.update(items=>items.map(item=>({...item,tracks:[...item.tracks,track(3)]})));
 f.server=server([1,2,4]);
 await runtime.syncPlaylists('yandex');
 assert.deepEqual(get(f.playlists)[0].tracks.map(item=>item.id),['1','2','4','3']);
 assert.deepEqual(f.server.tracks.map(item=>item.id),['1','2','4','3']);
});
await asyncCheck('revision conflict retries with fresh contents',async()=>{
 f.playlists.update(items=>items.map(item=>({...item,tracks:[...item.tracks,track(3)]})));
 f.conflictOnce=true;
 await runtime.syncPlaylists('yandex');
 assert.deepEqual(f.server.tracks.map(item=>item.id),['1','2','5','3']);
});
await asyncCheck('edits during server writes remain pending locally',async()=>{
 f.playlists.update(items=>items.map(item=>({...item,tracks:[...item.tracks,track(3)]})));
 f.editOnWrite=()=>f.playlists.update(items=>items.map(item=>({...item,tracks:[...item.tracks,track(4)]})));
 await runtime.syncPlaylists('yandex');
 assert(get(f.playlists)[0].tracks.some(item=>item.id==='4'));
 await runtime.syncPlaylists('yandex');
 assert(f.server.tracks.some(item=>item.id==='4'));
});
await asyncCheck('offline failure keeps pending edits and retries',async()=>{
 f.playlists.update(items=>items.map(item=>({...item,title:'Offline title'}))); f.failures=1;
 await assert.rejects(runtime.syncPlaylists('yandex'),/offline/);
 assert.equal(get(f.playlists)[0].title,'Offline title');
 await runtime.syncPlaylists('yandex'); assert.equal(f.server.title,'Offline title');
});
await asyncCheck('account switch during fetch cannot write or replace local data',async()=>{
 f.playlists.update(items=>items.map(item=>({...item,title:'Keep'}))); f.switchOnRead=true;
 await assert.rejects(runtime.syncPlaylists('yandex'),/Подключение изменилось/);
 assert.equal(f.writes.length,0); assert.equal(get(f.playlists)[0].title,'Keep');
});
await asyncCheck('conflicting names wait for explicit choice',async()=>{
 f.playlists.update(items=>items.map(item=>({...item,title:'Phone'}))); f.server.title='PC';
 await runtime.syncPlaylists('yandex'); assert.equal(f.writes.length,0); assert.equal(get(f.playlists)[0].sync.conflict,'title');
 await runtime.resolvePlaylistConflict('ym_playlist_100_7','local'); assert.equal(f.server.title,'Phone');
});
await asyncCheck('partial server payload cannot delete local tracks',async()=>{
 f.server.trackCount=3; await runtime.syncPlaylists('yandex');
 assert.equal(get(f.playlists)[0].tracks.length,2); assert.equal(f.writes.length,0); assert(get(f.playlists)[0].sync.error);
});
await asyncCheck('empty server snapshot removes tracks without deleting playlist',async()=>{
 f.server=server([]); await runtime.syncPlaylists('yandex'); assert.equal(get(f.playlists)[0].tracks.length,0); assert.equal(get(f.playlists).length,1);
});
await asyncCheck('mixed sources cannot create a remote playlist',async()=>{
 f.playlists.set([{id:'local',title:'Mixed',tracks:[{id:9,source:'soundcloud',title:'SC'}]}]);
 await assert.rejects(runtime.publishPlaylistToYandex('local'),/треков Яндекс/); assert.equal(f.writes.length,0);
});
await asyncCheck('new local playlist is private and retries use saved identity',async()=>{
 f.server=server([],'Local'); f.playlists.set([{id:'local',title:'Local',tracks:[track(8)]}]);
 await runtime.publishPlaylistToYandex('local');
 assert.equal(f.writes.find(item=>item.create).visibility,'private');
 assert.equal(get(f.playlists)[0].sync.remoteId,'ym_playlist_100_7');
 assert.deepEqual(f.server.tracks.map(item=>item.id),['8']);
 await runtime.syncPlaylists('yandex'); assert.equal(f.writes.filter(item=>item.create).length,1);
});
await asyncCheck('public SoundCloud updates preserve local additions with zero remote writes',async()=>{
 const a={id:1,title:'A',source:'soundcloud'}, b={id:2,title:'B',source:'soundcloud'}, c={id:3,title:'C',source:'soundcloud'};
 const old={id:'sc_playlist_9',title:'SC',tracks:[a]};
 f.playlists.set([{...old,tracks:[a,c],sync:{provider:'soundcloud',accountId:'200',remoteId:old.id,baseline:core.snapshot(old)}}]);
 f.sc=[{...old,tracks:[a,b]}]; await runtime.syncPlaylists('soundcloud');
 assert.deepEqual(get(f.playlists)[0].tracks.map(item=>item.id),[1,2,3]); assert.equal(f.writes.length,0);
});
await asyncCheck('hidden imported playlists do not return',async()=>{
 f.playlists.set([]); localStorage.setItem('lomifynext_playlist_sync_excluded',JSON.stringify(['yandex:100:ym_playlist_100_7']));
 await runtime.syncPlaylists('yandex'); assert.equal(get(f.playlists).length,0);
 localStorage.values.clear();
});
await asyncCheck('manual import while automatic sync is off preserves pending edits',async()=>{
 f.settings.update(value=>({...value,syncYandexPlaylists:false}));
 f.playlists.update(items=>items.map(item=>({...item,tracks:[...item.tracks,track(3)]})));
 f.server=server([1,2,4]);
 await runtime.syncPlaylists('yandex');
 assert.deepEqual(get(f.playlists)[0].tracks.map(item=>item.id),['1','2','4','3']);
 assert.equal(f.writes.length,0);
 f.settings.update(value=>({...value,syncYandexPlaylists:true}));
 await runtime.syncPlaylists('yandex');
 assert.deepEqual(f.server.tracks.map(item=>item.id),['1','2','4','3']);
});
await asyncCheck('manual SoundCloud refresh also works with automatic sync off',async()=>{
 f.settings.update(value=>({...value,syncSoundCloudPlaylists:false}));
 const a={id:1,title:'A',source:'soundcloud'}, b={id:2,title:'B',source:'soundcloud'};
 const old={id:'sc_playlist_9',title:'SC',tracks:[a]};
 f.playlists.set([{...old,sync:{provider:'soundcloud',accountId:'200',remoteId:old.id,baseline:core.snapshot(old)}}]);
 f.sc=[{...old,tracks:[a,b]}];
 await runtime.syncPlaylists('soundcloud');
 assert.deepEqual(get(f.playlists)[0].tracks.map(item=>item.id),[1,2]);
 assert.equal(f.writes.length,0);
});
console.log(checks+' playlist sync checks passed');
