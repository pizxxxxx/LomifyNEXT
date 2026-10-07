import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceDislikeIntent, drainDislikeIntents } from './dislikeSyncCore.ts';
test('offline marks persist and the newest opposite mark wins', async () => {
  let list = replaceDislikeIntent([], 1, '11', true);
  list = replaceDislikeIntent(list, 1, '11', false);
  assert.equal(list.length, 1); assert.equal(list[0].disliked, false);
  const status = await drainDislikeIntents({ read: () => list, write: v => list = v, account: () => ({uid:1,token:'a'}), send: async()=>{throw Error('offline')} });
  assert.equal(status, 'offline'); assert.equal(list.length, 1);
});
test('restoring during a pending hide is sent last, without losing the intent', async () => {
  let list = replaceDislikeIntent([], 1, '11', true); const sent=[];
  await drainDislikeIntents({ read: () => list, write: v => list = v, account: () => ({uid:1,token:'a'}), send: async(_,ids,mark)=>{
    sent.push(mark); if (mark) list=replaceDislikeIntent(list,1,'11',false);
  }});
  assert.deepEqual(sent,[true,false]); assert.deepEqual(list,[]);
});
test('a changed account never receives another account marks', async () => {
  let list = [ ...replaceDislikeIntent([],1,'11',true), ...replaceDislikeIntent([],2,'22',true) ];
  let account = {uid:1,token:'a'}; const sent=[];
  await drainDislikeIntents({read:()=>list,write:v=>list=v,account:()=>account,send:async(token,ids)=>{
    sent.push([token,ids]);account={uid:2,token:'b'};
  }});
  assert.deepEqual(sent,[['a',['11']],['b',['22']]]);assert.deepEqual(list,[]);
});
test('large restore lists are sent in bounded batches', async () => {
  let list=Array.from({length:205},(_,i)=>({uid:1,id:String(i),disliked:false,revision:1}));const sizes=[];
  await drainDislikeIntents({read:()=>list,write:v=>list=v,account:()=>({uid:1,token:'a'}),send:async(_,ids)=>{sizes.push(ids.length)}});
  assert.deepEqual(sizes,[100,100,5]);assert.deepEqual(list,[]);
});
