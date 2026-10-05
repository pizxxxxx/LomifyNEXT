import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const text=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');
const start=text.indexOf('async function boundedSoundCloudFetch('),end=text.indexOf('const SC_CLIENT_ID_STORAGE_KEY',start);
const code=ts.transpileModule(text.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('export async function','async function');
function setup(native, direct, browser=async()=>{throw new Error('cors unavailable')}) {
  const calls=[];
  const context=vm.createContext({Response,URL,DOMException,AbortController,setTimeout,clearTimeout,Date,console:{warn(){}},DEFAULT_BROWSER_HEADERS:{},window:{__TAURI_INTERNALS__:{},fetch:browser},tauriFetch:native,invoke:async(command,args)=>{calls.push({command,args});if(command==='soundcloud_fetch_text')return direct();},});
  vm.runInContext(`${code}; this.fetch = safeFetch`,context);
  return {fetch:context.fetch,calls};
}
test('system transport failure falls back to native direct GET and preserves HTTP status',async()=>{
  const {fetch,calls}=setup(async()=>{throw new Error('proxy unavailable')},()=>({status:403,body:'denied'}));
  const result=await fetch('https://api-v2.soundcloud.com/search/tracks');
  assert.equal(result.status,403);assert.equal(await result.text(),'denied');
  assert.equal(calls[0].command,'soundcloud_fetch_text');
});
test('an ordinary HTTP denial does not trigger proxy fallback or strategy changes',async()=>{
  const {fetch,calls}=setup(async()=>new Response('rate limited',{status:429}),()=>{throw new Error('unexpected fallback')});
  assert.equal((await fetch('https://api-v2.soundcloud.com/tracks')).status,429);assert.equal(calls.length,0);
});
test('cancelled requests do not continue through fallback transports or report network failure',async()=>{
  const controller=new AbortController();controller.abort();
  const {fetch,calls}=setup(async()=>{throw new DOMException('Cancelled','AbortError')},()=>({status:200,body:'unexpected'}));
  await assert.rejects(fetch('https://api-v2.soundcloud.com/tracks',{signal:controller.signal}),{name:'AbortError'});assert.equal(calls.length,0);
});
test('direct public fallback never receives Authorization or lookalike domains',async()=>{
  for(const [url,headers] of [['https://api-v2.soundcloud.com/tracks',{Authorization:'test-only-account'}],['https://soundcloud.com.evil.test/',{}]]) {
    const {fetch,calls}=setup(async()=>{throw new Error('failed')},()=>({status:200,body:'unexpected'}),async()=>new Response('browser'));
    await fetch(url,{headers});assert.equal(calls.filter(call=>call.command==='soundcloud_fetch_text').length,0);
  }
});
