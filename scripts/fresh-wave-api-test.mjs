import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { get, writable } from 'svelte/store';
import * as core from '../src/lib/freshWaveCore.ts';

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const freshSource = transpile(await readFile(new URL('../src/lib/freshWave.ts', import.meta.url), 'utf8'));
const song = (id, source = 'yandex') => ({ id: String(id), title: `Song ${id}`, artist: `Artist ${id}`, source });

async function setup(source, startup = Promise.resolve()) {
  const calls = [], controller = new AbortController();
  const stores = { settings: writable({searchSource:source,yandexToken:'test-only-account'}), likedTracks:writable([{...song(1,source),likedAt:Date.now()}]), dislikedTracks:writable([]), listenStats:writable({history:{}}) };
  const modules = {
    'svelte/store': {get}, './stores': stores, './secretStorage':{whenSecretsReady:()=>startup}, './freshWaveCore':core,
    './waveFilters':{trackMatchesWaveFilters:()=>true,trackMatchesWaveGenre:()=>true,isNeuroTrack:()=>false,waveGenreLabel:value=>value},
    './yandex': {
      getYandexSimilar:async (...args)=>{calls.push({kind:'yandex-related',args});return [song(2),song(3)];},
      searchYandex:async (...args)=>{calls.push({kind:'yandex-search',args});return [song(4)];}
    },
    './api': {
      fetchRelatedTracks:async (...args)=>{calls.push({kind:'sc-related',args});return [song(2,'soundcloud'),song(3,'soundcloud')];},
      searchSoundCloud:async (...args)=>{calls.push({kind:'sc-search',args});return [song(4,'soundcloud')];},
      getTrendingTracks:async()=>[]
    }
  };
  const context = vm.createContext({console,Map,Set,Date,DOMException});
  const synthetic = name => new vm.SyntheticModule(Object.keys(modules[name]), function(){for(const [key,value] of Object.entries(modules[name]))this.setExport(key,value);},{context});
  const module = new vm.SourceTextModule(freshSource,{context,importModuleDynamically:async name=>{const imported=synthetic(name);await imported.link(()=>{});await imported.evaluate();return imported;}});
  await module.link(synthetic);await module.evaluate();
  return {fetch:()=>module.namespace.getFreshWaveTracks(source,new Set(),new Map(),undefined,controller.signal),calls,controller};
}

test('fresh wave requests only the selected catalog and forwards cancellation to the correct API argument',async()=>{
  for(const source of ['yandex','soundcloud']) {
    const {fetch,calls,controller}=await setup(source);
    const tracks=await fetch();
    assert.ok(tracks.length>0);assert.ok(tracks.every(track=>track.source===source));
    assert.ok(calls.every(call=>call.kind.startsWith(source==='yandex'?'yandex':'sc')));
    const search=calls.find(call=>call.kind.endsWith('search'));
    assert.equal(search.args.at(-1),controller.signal);
    if(source==='yandex')assert.equal(search.args[3],0);
    assert.equal(calls.filter(call=>call.kind.endsWith('related')).length,1,'shared recent/stable seed is requested once');
  }
});

test('requests wait for secret hydration and aborted startup sends no catalog request',async()=>{
  let finish; const startup=new Promise(resolve=>finish=resolve);
  const {fetch,calls,controller}=await setup('yandex',startup);
  const pending=fetch();assert.equal(calls.length,0);
  controller.abort();finish();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(calls.length,0);
});

test('Yandex like hydration preserves real server dates without dating old imports today',async()=>{
  const text=await readFile(new URL('../src/lib/yandex.ts',import.meta.url),'utf8');
  const start=text.indexOf('export async function getYandexLikes('), end=text.indexOf('/*',start);
  const fn=transpile(text.slice(start,end)).replace('export async function','async function');
  const date=new Date(Date.now()-3*86400000).toISOString();
  const context=vm.createContext({Date,Map,Set,console,likesTrackCache:null,normalizeYandexToken:value=>value,accountUid:async()=>1,API:'https://example.test',mapYandexTrack:value=>value,ymJson:async url=>url.includes('/likes/tracks')?{library:{tracks:[{id:'1',timestamp:date},{id:'2'}]}}:[song(1),song(2)]});
  const result=await vm.runInContext(`${fn}; getYandexLikes('test-only-account')`,context);
  assert.equal(result.tracks[0].likedAt,Date.parse(date));assert.equal(result.tracks[1].likedAt,undefined);assert.equal(result.complete,true);
});

test('sync enriches existing undated likes and never rolls back a newer local like date',async()=>{
  const text=await readFile(new URL('../src/lib/likes.ts',import.meta.url),'utf8');
  const start=text.indexOf('async function mergeSide('),end=text.indexOf('/** Итог',start);
  const fn=transpile(text.slice(start,end));
  const date=Date.now()-86400000;
  const likedTracks=writable([song(1),{...song(2),likedAt:date+1000},song(3)]);
  const state={seen:{yandex:['1','2','3']},scRemoved:[]};
  const result={added:0,removed:0,partial:[]};
  const side={source:'yandex',label:'test',inFlight:new Set(),read:async()=>({tracks:[{...song(1),likedAt:date},{...song(2),likedAt:date},song(3)],complete:true})};
  const context=vm.createContext({Map,Set,Date,get,likedTracks,realLikeTimestamp:core.realLikeTimestamp,trackId:track=>track?.id,sameTrack:(a,b)=>a.id===b.id,loadState:()=>state,saveState:()=>{},side,result});
  await vm.runInContext(`${fn}; mergeSide(side,result)`,context);
  assert.equal(get(likedTracks)[0].likedAt,date);
  assert.equal(get(likedTracks)[1].likedAt,date+1000);
  assert.equal(get(likedTracks)[2].likedAt,undefined);
  assert.equal(result.added,0);assert.equal(result.removed,0);
});
