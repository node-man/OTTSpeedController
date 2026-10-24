// Synthetic episode jobs only. Batch preparation performs no browser/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TranslationStore} from '../scripts/translation-bridge-store.mjs';
import {TranslationBatchStore} from '../scripts/translation-batch-store.mjs';
import {WorkspaceAgentLauncher} from '../scripts/workspace-agent-launcher.mjs';
import prompt from '../subtitles/translation-prompt.js';
import {createBridge} from '../scripts/translation-bridge-server.mjs';
const fixture=id=>{
 const media={key:`netflix:${id}`,platform:'netflix',videoId:String(id),url:`https://www.netflix.com/watch/${id}`};
 const cues=[{id:'one',startMs:1000,endMs:1800,text:`An original synthetic ${id} line.`},{id:'two',startMs:2000,endMs:2800,text:'A second synthetic line.'}];
 const capture={mediaKey:media.key,videoId:String(id),fullEpisode:true,coverage:'complete',cueCount:2,startMs:1000,endMs:2800,resourceSha256:'a'.repeat(64),resourceBytes:200,track:{language:'en',profile:'webvtt-lssdh-ios8',segmented:false},audit:{inputCount:2,acceptedCount:2,excludedCount:0,allTimedEntriesAccountedFor:true,documentComplete:true}};
 return {media,source:{name:'synthetic.en.vtt',language:'en',format:'vtt',provenance:'netflix-manifest-resource',sync:{offsetMs:0,scale:1},cues,capture}};
};
async function env(t){const directory=await mkdtemp(join(tmpdir(),'ottspeed-batch-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await new TranslationStore(directory,{chunkSize:1}).init(),batches=await new TranslationBatchStore(store).init();return {directory,store,batches};}
async function finish(store,job){const info=await store.getJob(job.jobId),chunks=[];for(const c of info.chunks)chunks.push(await store.readChunk({jobId:job.jobId,chunkId:c.chunkId}));for(const c of chunks)await store.saveChunk({jobId:job.jobId,chunkId:c.chunkId,requestId:job.jobId,sourceHash:job.sourceHash,mediaKey:job.mediaKey,cues:c.outputIds.map(id=>({id,text:'합성 번역.'}))});await store.finalize({jobId:job.jobId});}

test('cached episode batches preserve order, deduplicate, and resume each fixed source after restart',async t=>{
 const f=await env(t),a=await f.store.create(fixture(101)),b=await f.store.create(fixture(202));
 const batch=await f.batches.create({jobIds:[b.jobId,a.jobId]});assert.deepEqual(batch.entries.map(e=>e.jobId),[b.jobId,a.jobId]);assert.equal(batch.pendingCount,2);
 assert.equal((await f.batches.create({jobIds:[b.jobId,a.jobId]})).batchId,batch.batchId);
 await finish(f.store,b);const resumed=await new TranslationBatchStore(f.store).init();const state=await resumed.get(batch.batchId);assert.equal(state.completedCount,1);assert.equal(state.pendingCount,1);assert.equal(state.sourceHash,batch.sourceHash);
 assert.equal(state.entries[0].chunkCount,2);assert.equal(state.entries[0].savedChunkCount,2);assert.equal(state.entries[0].readChunkCount,2);assert.equal(state.entries[1].savedChunkCount,0);
 const before=prompt.buildBatch(batch),after=prompt.buildBatch(state);assert.equal(before,after);assert(before.indexOf(b.jobId)<before.indexOf(a.jobId));assert.match(before,/다음 회차로/);assert.match(before,/시즌 전체 원문을 먼저 읽어/);
 await finish(f.store,a);assert.equal((await f.batches.get(batch.batchId)).status,'complete');
});

test('missing/changed episodes are blocked, duplicate versions are rejected, and corrupted batch records stay isolated',async t=>{
 const f=await env(t),a=await f.store.create(fixture(101));
 await assert.rejects(()=>f.batches.create({jobIds:[a.jobId,a.jobId]}),/distinct/);
 const changed=fixture(101);changed.source.cues[0].text='A changed synthetic line.';const second=await f.store.create(changed);
 await assert.rejects(()=>f.batches.create({jobIds:[a.jobId,second.jobId]}),/one source/);
 const batch=await f.batches.create({jobIds:[a.jobId]});const saved=await f.store.load(a.jobId);saved.request.sourceHash='b'.repeat(64);await f.store.atomic(f.store.path(a.jobId),saved);
 const blocked=await f.batches.get(batch.batchId);assert.equal(blocked.blockedCount,1);assert.equal(blocked.status,'blocked');
 await writeFile(f.batches.path(batch.batchId),'corrupt');assert.equal((await f.batches.list())[0].reason,'batch_record_unavailable');
});

test('official batch triggers keep one immutable input while member progress changes and skip all-complete batches',async t=>{
 const f=await env(t),a=await f.store.create(fixture(101)),b=await f.store.create(fixture(202));const batch=await f.batches.create({jobIds:[a.jobId,b.jobId]});
 let time=100000;const calls=[];let first=true;
 const options={enabled:true,triggerId:'agtch_batch_fixture',token:'synthetic-agent-token-not-real',now:()=>time,fetch:async(url,options)=>{calls.push({url,options});if(first){first=false;throw new Error('lost');}return new Response(JSON.stringify({conversation_url:'https://chatgpt.com/c/batch',agent_trigger_run_id:'apirun_batch'}),{status:202});}};
 let launcher=new WorkspaceAgentLauncher(f.directory,options);assert.equal((await launcher.start(batch)).state,'uncertain');await finish(f.store,a);time+=30000;
 launcher=new WorkspaceAgentLauncher(f.directory,options);assert.equal((await launcher.start(await f.batches.get(batch.batchId))).state,'queued');assert.equal(calls[0].options.body,calls[1].options.body);assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);
 const input=JSON.parse(calls[0].options.body).input;assert(input.includes(a.jobId)&&input.includes(b.jobId));assert(!input.includes(batch.batchId));
 await finish(f.store,b);assert.equal((await launcher.start(await f.batches.get(batch.batchId))).mode,'complete');assert.equal(calls.length,2);
});

test('HTTP batch preparation and execution retain Origin/token boundaries and reject changed sources',async t=>{
 const f=await env(t),bridge=await createBridge({directory:f.directory,port:0});t.after(()=>new Promise(r=>bridge.server.close(r)));
 const a=await bridge.store.create(fixture(101)),b=await bridge.store.create(fixture(202)),base=`http://127.0.0.1:${bridge.port}`;
 const origin='chrome-extension://hegbpfhcjpghhhnmnjjedibpfblchefh',pairHeaders={Origin:origin,'X-OTTSpeed-Client':'workspace','Content-Type':'application/json'};
 const {token}=await(await fetch(base+'/extension/pair',{method:'POST',headers:pairHeaders,body:'{"client":"OTTSpeed"}'})).json();
 const headers={...pairHeaders,Authorization:`Bearer ${token}`},body=JSON.stringify({jobIds:[a.jobId,b.jobId]});
 assert.equal((await fetch(base+'/extension/batches',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
 const noOrigin={...headers};delete noOrigin.Origin;assert.equal((await fetch(base+'/extension/batches',{method:'POST',headers:noOrigin,body})).status,403);
 const created=await(await fetch(base+'/extension/batches',{method:'POST',headers,body})).json();assert.equal(created.pendingCount,2);
 const url=`${base}/extension/batches/${created.batchId}`;assert.equal((await fetch(url,{headers:noOrigin})).status,200);
 assert.equal((await fetch(url+'/start',{method:'POST',headers:noOrigin,body:'{}'})).status,403);
 assert.equal((await(await fetch(url+'/start',{method:'POST',headers,body:'{}'})).json()).mode,'copy');
 const altered=await bridge.store.load(a.jobId);altered.sourceTrack.cues[0].text='A source corruption without changing its stored hash.';await bridge.store.atomic(bridge.store.path(a.jobId),altered);
 const blocked=await(await fetch(url,{headers})).json();assert.equal(blocked.blockedCount,1);assert.equal((await fetch(url+'/start',{method:'POST',headers,body:'{}'})).status,400);
});
