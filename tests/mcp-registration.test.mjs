import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import core from '../subtitles/core.js';
import catalog from '../subtitles/catalog.js';
import validation from '../subtitles/capture-validation.js';
import registration from '../modules/library/mcp-registration.js';
import {TranslationStore} from '../modules/translation/job-store.mjs';
import {collected} from './fixtures/collected.mjs';
const session=id=>{const {media,source}=collected(id);return {mediaKey:media.key,media,catalog:{title:'Synthetic',season:2,episode:Number(id)},tracks:{source,a:{...source,language:'ko'},b:null},settings:{activeTarget:'a',fontSize:56},revision:0};};
async function fixture(t,values=[session('123'),session('124')]){
  const dir=await mkdtemp(join(tmpdir(),'ottdeck-registration-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=await new TranslationStore(dir,{chunkSize:1}).init();
  const sessions=new Map(values.map(s=>[s.mediaKey,structuredClone(s)])),calls=[],watches=[];let clock=1;
  const library={list:async()=>structuredClone([...sessions.values()]),get:async key=>structuredClone(sessions.get(key)),put:async value=>{const old=sessions.get(value.mediaKey);if(old.revision!==value.revision){const error=new Error('conflict');error.name='ConflictError';throw error;}const next=await catalog.prepareWrite(old,value);next.revision++;sessions.set(next.mediaKey,next);}};
  const bridge=async(path,body)=>{calls.push({path,body});if(path!=='/jobs')throw new Error('Automatic registration must never execute a translation or create a batch');return body?store.create(body):{jobs:await store.list()};};
  const make=overrides=>registration({core,catalog,validation,library,bridge,watch:async job=>watches.push(job),now:()=>clock,...overrides});
  return {store,sessions,calls,watches,library,bridge,make,advance:()=>{clock+=30001;}};
}
test('full library registers once, pending jobs remain idle, and A/B/settings survive restart and refresh',async t=>{
  const f=await fixture(t),before=structuredClone([...f.sessions.values()]),worker=f.make();
  assert.deepEqual(await worker.sync(),{registered:2,failed:0});assert.equal(f.calls.filter(c=>c.body).length,2);assert.equal(f.watches.length,0);
  await worker.sync();assert.equal(f.calls.length,3);f.advance();await worker.sync();await f.make().sync();assert.equal(f.calls.filter(c=>c.body).length,2);
  for(const previous of before){const value=f.sessions.get(previous.mediaKey);assert.deepEqual(value.tracks,previous.tracks);assert.deepEqual(value.settings,previous.settings);assert.equal(value.mcpRegistration.status,'translating');const row=await catalog.summarize(value);assert.equal(row.state,'번역 대기');assert.equal(row.mcpState,'등록됨');}
  assert.deepEqual((await f.store.list()).map(j=>j.episode).sort(),['S02E123','S02E124']);
});
test('invalid capture and changed source are distinguished; offline preserves verified registration',async t=>{
  const f=await fixture(t);f.sessions.get('netflix:124').tracks.source.capture.fullEpisode=false;
  const worker=f.make();assert.deepEqual(await worker.sync(),{registered:1,failed:1});assert.equal((await catalog.summarize(f.sessions.get('netflix:124'))).state,'MCP 등록 실패');
  const value=f.sessions.get('netflix:123'),oldId=value.mcpRegistration.jobId,old=structuredClone(value.mcpRegistration);
  await assert.rejects(f.make({bridge:async()=>{throw new Error('offline');}}).sync(),/offline/);assert.deepEqual(value.mcpRegistration,old);
  value.tracks.source.cues[0].text='A new synthetic source version.';assert.equal((await catalog.summarize(value)).state,'원문 보관 · 등록 전');
  await worker.sync({force:true});assert.notEqual(f.sessions.get(value.mediaKey).mcpRegistration.jobId,oldId);assert.equal((await f.store.list()).length,2);
});
test('source changes during network requests cannot bind a stale job, and write conflicts preserve concurrent B',async t=>{
  const f=await fixture(t,[session('123')]);let changed=false;
  await f.make({bridge:async(path,body)=>{const result=await f.bridge(path,body);if(body&&!changed){changed=true;f.sessions.get('netflix:123').tracks.source.cues[0].text='Changed while registering.';}return result;}}).sync();
  assert.equal(f.sessions.get('netflix:123').mcpRegistration,undefined);
  const put=f.library.put;let conflict=true;
  f.library.put=async value=>{if(conflict){conflict=false;const latest=f.sessions.get(value.mediaKey);latest.tracks.b={...latest.tracks.source,language:'ko',name:'Concurrent B'};latest.settings.activeTarget='b';latest.revision++;}return put(value);};
  await f.make().sync();const value=f.sessions.get('netflix:123');assert.equal(value.tracks.b.name,'Concurrent B');assert.equal(value.settings.activeTarget,'b');assert(value.mcpRegistration.jobId);
});
test('stored external progress is received as an archived version without launching any other episode',async t=>{
  const f=await fixture(t),worker=f.make();await worker.sync();const first=(await f.store.list()).find(j=>j.mediaKey==='netflix:123'),detail=await f.store.extensionJob(first.jobId);
  const chunks=f.store.summary(await f.store.load(first.jobId)).chunkCount;assert.equal(chunks,2);
  // The same durable store and save validation used by MCP, not a fabricated progress flag.
  const job=await f.store.load(first.jobId);for(const c of job.chunks)await f.store.readChunk({jobId:first.jobId,chunkId:c.chunkId});
  const chunk=await f.store.readChunk({jobId:first.jobId,chunkId:job.chunks[0].chunkId});
  await f.store.saveChunk({jobId:first.jobId,chunkId:chunk.chunkId,requestId:first.jobId,mediaKey:first.mediaKey,sourceHash:first.sourceHash,cues:chunk.outputIds.map(id=>({id,text:'합성 번역.'}))});
  await worker.sync({force:true});assert.equal(f.watches.length,1);assert.equal(f.watches[0].jobId,first.jobId);assert.equal((await catalog.summarize(f.sessions.get('netflix:123'))).state,'번역 중');assert.equal((await catalog.summarize(f.sessions.get('netflix:124'))).state,'번역 대기');assert.equal(detail.request.reference,null);
  const last=await f.store.readChunk({jobId:first.jobId,chunkId:job.chunks[1].chunkId});
  await f.store.saveChunk({jobId:first.jobId,chunkId:last.chunkId,requestId:first.jobId,mediaKey:first.mediaKey,sourceHash:first.sourceHash,cues:last.outputIds.map(id=>({id,text:'합성 완성 번역.'}))});await f.store.finalize({jobId:first.jobId});
  await worker.sync({force:true});assert.equal(f.watches.length,2);assert.equal((await catalog.summarize(f.sessions.get('netflix:123'))).state,'번역 완료 · 수신 대기');
  const value=f.sessions.get('netflix:123'),complete=await f.store.extensionJob(first.jobId);value.pendingRequest=complete.request;value.tracks.b={...complete.sourceTrack,...core.validateTranslationResponse(complete.response,complete.request),language:'ko',requestId:first.jobId};
  assert.equal((await catalog.summarize(value)).state,'완료');const before=structuredClone(value.tracks.b);await worker.sync({force:true});assert.deepEqual(f.sessions.get('netflix:123').tracks.b,before);assert.equal(f.watches.length,2);
});
