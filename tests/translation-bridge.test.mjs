// Synthetic fixtures only. These checks do not count as actual ChatGPT translation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TranslationStore, digest } from '../scripts/translation-bridge-store.mjs';
import { createBridge } from '../scripts/translation-bridge-server.mjs';

const fixture = () => {
  const media = {key:'netflix:123',platform:'netflix',videoId:'123',url:'https://www.netflix.com/watch/123'};
  const cues = Array.from({length:5},(_,i)=>({id:`cue-${i}`,startMs:1000+i*1000,endMs:2400+i*1000,text:`Original synthetic sentence ${i}.`}));
  const capture = {videoId:'123',mediaKey:media.key,fullEpisode:true,coverage:'complete',cueCount:5,startMs:1000,endMs:6400,resourceSha256:'a'.repeat(64),resourceBytes:400,
    track:{language:'en',id:'synthetic-en',profile:'webvtt-lssdh-ios8',segmented:false},audit:{inputCount:5,acceptedCount:5,excludedCount:0,allTimedEntriesAccountedFor:true,documentComplete:true}};
  return {media,source:{name:'synthetic.vtt',provenance:'netflix-manifest-resource',language:'en',format:'vtt',sync:{offsetMs:0,scale:1},cues,capture}};
};
async function temporary(t) {
  const dir=await mkdtemp(join(tmpdir(),'ottspeed-bridge-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
const payload = (job,chunk) => ({jobId:job.jobId,chunkId:chunk.chunkId,requestId:job.jobId,sourceHash:job.sourceHash,mediaKey:job.mediaKey,cues:chunk.outputIds.map(id=>({id,text:`합성 검사 ${id}`}))});

test('durable snapshot excludes Korean A, requires full capture, and deduplicates identical source',async t=> {
  const store=await new TranslationStore(await temporary(t),{chunkSize:2}).init();
  const input=fixture();
  const job=await store.create(input), again=await store.create(input);
  assert.equal(job.jobId,again.jobId);assert.equal(job.chunkCount,3);
  const detail=await store.extensionJob(job.jobId);
  assert.equal(detail.request.reference,null);assert.equal(detail.request.mode,'translate');
  assert.deepEqual(detail.request.source.cues,input.source.cues);assert.deepEqual(detail.capture,input.source.capture);
  const changed=structuredClone(input);changed.source.cues[0].text='Changed synthetic source.';
  assert.notEqual((await store.create(changed)).jobId,job.jobId);
  changed.source.capture.fullEpisode=false;
  await assert.rejects(()=>store.create(changed),/full-episode/);
});

test('owned chunk IDs, whole-context reads, stale responses, and complete final contract are enforced',async t=> {
  const dir=await temporary(t),store=await new TranslationStore(dir,{chunkSize:2}).init();
  const job=await store.create(fixture());
  const info=await store.getJob(job.jobId);assert.equal(info.context.status,'unwritten');
  const chunks=[];
  for(const c of info.chunks) chunks.push(await store.readChunk({jobId:job.jobId,chunkId:c.chunkId}));
  assert.deepEqual(chunks.map(c=>c.outputIds.length),[2,2,1]);
  assert(chunks[0].contextAfter.length>0);assert.equal(chunks[0].contextIsReadOnly,true);
  const good=payload(job,chunks[0]);
  for(const bad of [
    {...good,sourceHash:'b'.repeat(64)},
    {...good,cues:good.cues.slice(1)},
    {...good,cues:[good.cues[0],good.cues[0]]},
    {...good,cues:[{id:chunks[0].contextAfter[0].id,text:'참고 ID 반환 금지'},good.cues[1]]},
    {...good,cues:good.cues.map(c=>({...c,text:''}))},
    {...good,cues:good.cues.map(c=>({...c,startMs:0}))}
  ]) await assert.rejects(()=>store.saveChunk(bad));
  await assert.rejects(()=>store.finalize({jobId:job.jobId}),/All chunks/);
  for(const c of chunks) await store.saveChunk(payload(job,c));
  assert.equal((await store.saveChunk(good)).unchanged,true);
  const final=await store.finalize({jobId:job.jobId});assert.equal(final.status,'complete');
  const restarted=await new TranslationStore(dir).init();
  const result=await restarted.extensionJob(job.jobId);
  assert.equal(result.resultHash,digest(result.response));assert.equal(result.response.cues.length,5);
  assert.deepEqual(result.request.slots.map(({id,startMs,endMs})=>({id,startMs,endMs})),fixture().source.cues.map(({id,startMs,endMs})=>({id,startMs,endMs})));
  assert.equal((await restarted.finalize({jobId:job.jobId})).unchanged,true);
  await assert.rejects(()=>restarted.saveChunk({...good,cues:good.cues.map(c=>({...c,text:'다른 합성 번역'}))}),/finalized/);
});

test('saving before every chunk has been read is rejected; context scope and revision stay bounded',async t=> {
  const store=await new TranslationStore(await temporary(t),{chunkSize:2}).init(),job=await store.create(fixture());
  const first=await store.readChunk({jobId:job.jobId,chunkId:'chunk-001'});
  await assert.rejects(()=>store.saveChunk(payload(job,first)),/Read every chunk/);
  await assert.rejects(()=>store.updateContext({scope:'S02E03',expectedRevision:0,text:'x',basis:'x'}),/S02E02/);
  await store.updateContext({scope:'S01-S02E02',expectedRevision:0,text:'합성 맥락 메모.',basis:'Original synthetic fixture.'});
  await assert.rejects(()=>store.updateContext({scope:'S01-S02E02',expectedRevision:0,text:'x',basis:'x'}),/revision/);
  assert.equal((await store.getJob(job.jobId)).context.revision,1);
});

test('saved prefixes stream before finalization, survive restart, and hold simultaneous boundary lines',async t=>{
  const dir=await temporary(t),store=await new TranslationStore(dir,{chunkSize:2}).init();
  const input=fixture();
  input.source.cues=input.source.cues.map((c,i)=>({...c,startMs:i===2?2000:c.startMs,endMs:i===2?2700:c.startMs+700}));
  input.source.capture.endMs=5700;
  const job=await store.create(input),info=await store.getJob(job.jobId),chunks=[];
  for(const c of info.chunks)chunks.push(await store.readChunk({jobId:job.jobId,chunkId:c.chunkId}));
  await store.saveChunk(payload(job,chunks[2]));
  assert.equal((await store.extensionJob(job.jobId)).progress,null,'out of order tail is not playable');
  await store.saveChunk(payload(job,chunks[0]));
  const first=await store.extensionJob(job.jobId);
  assert.equal(first.response,null);assert.equal(first.status,'translating');assert.equal(first.readyCueCount,1);
  assert.equal(first.readyThroughMs,2000);assert.equal(first.progressHash,digest(first.progress));
  assert.deepEqual(first.progress.cues.map(c=>c.id),['cue-0']);
  const restarted=await new TranslationStore(dir,{chunkSize:2}).init();
  assert.deepEqual((await restarted.extensionJob(job.jobId)).progress,first.progress);
  const legacy=await restarted.load(job.jobId);delete legacy.progressRevision;
  await restarted.atomic(restarted.path(job.jobId),legacy);
  assert.equal((await restarted.extensionJob(job.jobId)).progressRevision,first.progressRevision,'legacy partial jobs keep monotonic revisions');
  const duplicate=await restarted.saveChunk(payload(job,chunks[0]));assert(duplicate.unchanged);
  assert.equal((await restarted.extensionJob(job.jobId)).progressHash,first.progressHash);
  const corrected=payload(job,chunks[0]);corrected.cues[0].text='교정한 합성 앞부분.';
  await restarted.saveChunk(corrected);
  const updated=await restarted.extensionJob(job.jobId);assert(updated.progressRevision>first.progressRevision);
  assert.notEqual(updated.progressHash,first.progressHash);
  await restarted.saveChunk(payload(job,chunks[1]));
  const allSaved=await restarted.extensionJob(job.jobId);assert.equal(allSaved.readyCueCount,5);assert.equal(allSaved.response,null);
  await restarted.finalize({jobId:job.jobId});
  const final=await restarted.extensionJob(job.jobId);assert.equal(final.status,'complete');assert.equal(final.progress,null);assert.equal(final.response.cues.length,5);
});

test('official MCP client reads/saves/finalizes over HTTP; extension API requires pairing origin and token',async t=> {
  const remote=[];
  const dir=await temporary(t),bridge=await createBridge({directory:dir,port:0,workspaceAgent:{enabled:true,triggerId:'agtch_synthetic',token:'synthetic-workspace-agent-token-not-real',pollMs:0,fetch:async(url,options)=>{
    remote.push({url,options});
    return new Response(JSON.stringify(options.method==='POST'?{conversation_url:'https://chatgpt.com/c/synthetic',agent_trigger_run_id:'apirun_synthetic'}:{id:'apirun_synthetic',api_trigger_id:'agtch_synthetic',status:'completed'}),{status:options.method==='POST'?202:200});
  }}});
  t.after(()=>new Promise(r=>bridge.server.close(r)));
  const base=`http://127.0.0.1:${bridge.port}`;
  const origin='chrome-extension://hegbpfhcjpghhhnmnjjedibpfblchefh';
  assert.equal((await fetch(base+'/extension/pair',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{"client":"OTTSpeed"}'})).status,403);
  assert.equal((await fetch(base+'/extension/jobs')).status,403);
  const paired=await (await fetch(base+'/extension/pair',{method:'POST',headers:{Origin:origin,'X-OTTSpeed-Client':'workspace','Content-Type':'application/json'},body:'{"client":"OTTSpeed"}'})).json();
  const headers={Origin:origin,'X-OTTSpeed-Client':'workspace','Content-Type':'application/json',Authorization:`Bearer ${paired.token}`};
  const chromeGetHeaders={'X-OTTSpeed-Client':'workspace',Authorization:`Bearer ${paired.token}`};
  assert.equal((await fetch(base+'/extension/jobs',{headers:chromeGetHeaders})).status,200);
  assert.equal((await fetch(base+'/extension/jobs',{headers:{...chromeGetHeaders,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/extension/jobs',{headers:{'X-OTTSpeed-Client':'workspace',Authorization:'Bearer wrong'}})).status,403);
  assert.equal((await fetch(base+'/extension/pair',{method:'POST',headers:{...chromeGetHeaders,'Content-Type':'application/json'},body:'{"client":"OTTSpeed"}'})).status,403);
  assert.equal((await fetch(base+'/extension/jobs',{method:'POST',headers:{...chromeGetHeaders,'Content-Type':'application/json'},body:JSON.stringify(fixture())})).status,403);
  const job=await (await fetch(base+'/extension/jobs',{method:'POST',headers,body:JSON.stringify(fixture())})).json();
  const startUrl=base+`/extension/jobs/${job.jobId}/start`;
  assert.equal((await fetch(startUrl,{method:'POST',headers:{...chromeGetHeaders,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(startUrl,{method:'POST',headers,body:'{"input":"untrusted override"}'})).status,400);
  assert.equal((await fetch(startUrl,{method:'POST',headers,body:'true'})).status,400);
  assert.equal(remote.length,0);
  const execution=await(await fetch(startUrl,{method:'POST',headers,body:'{}'})).json();assert.equal(execution.state,'queued');assert.equal(execution.translationComplete,false);
  await fetch(startUrl,{method:'POST',headers,body:'{}'});assert.equal(remote.length,1);
  const configuration=await(await fetch(base+'/extension/execution',{headers})).json();assert.equal(configuration.ready,true);assert(!JSON.stringify(configuration).includes('synthetic-workspace-agent-token'));
  await bridge.launcher.status(job,{refresh:true});
  const waiting=await(await fetch(base+`/extension/jobs/${job.jobId}`,{headers})).json();assert.equal(waiting.execution.state,'completed');assert.equal(waiting.status,'translating');assert.equal(waiting.execution.resultPending,true);
  const client=new Client({name:'ottspeed-local-synthetic-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
  t.after(()=>client.close());
  const tools=await client.listTools();assert.equal(tools.tools.length,5);
  assert.equal(tools.tools.find(t=>t.name==='save_translation_chunk').annotations.destructiveHint,false);
  const call=async(name,args)=> {
    const reply=await client.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent.result;
  };
  const info=await call('get_translation_job',{jobId:job.jobId});assert.equal(info.capture.fullEpisode,true);
  const chunk=await call('read_subtitle_chunk',{jobId:job.jobId,chunkId:info.chunks[0].chunkId});
  await call('save_translation_chunk',payload(job,chunk));
  const early=await (await fetch(base+`/extension/jobs/${job.jobId}`,{headers})).json();
  assert.equal(early.status,'translating');assert.equal(early.response,null);assert.equal(early.progress.cues.length,5);
  await call('finalize_translation',{jobId:job.jobId});
  const result=await (await fetch(base+`/extension/jobs/${job.jobId}`,{headers})).json();
  assert.equal(result.status,'complete');assert.equal(result.response.cues.length,5);
  assert.equal(result.execution.translationComplete,true);assert.equal(result.execution.resultPending,false);
  await writeFile(join(dir,'workspace-agent-runs',`${job.jobId}.json`),'corrupt synthetic record');
  assert.equal((await fetch(base+'/extension/jobs',{headers})).status,200);
  const preserved=await(await fetch(base+`/extension/jobs/${job.jobId}`,{headers})).json();
  assert.equal(preserved.response.cues.length,5);assert.equal(preserved.execution.errorCode,'execution_record_unavailable');
  assert.equal((await fetch(base+'/extension/jobs',{headers:{...headers,Authorization:'Bearer wrong'}})).status,401);
});
