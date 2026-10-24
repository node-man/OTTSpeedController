// Synthetic jobs only; no model calls, Netflix playback or private credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import core from '../subtitles/core.js';
const transportModules=await Promise.all(['shared/product.js','modules/runtime/bridge-http.js'].map(path=>readFile(new URL('../'+path,import.meta.url),'utf8')));

async function job() {
  const media={key:'netflix:101',platform:'netflix',videoId:'101',url:'https://www.netflix.com/watch/101'};
  const cues=Array.from({length:4},(_,i)=>({id:`id-${i}`,startMs:1000+i*1000,endMs:1800+i*1000,text:`Synthetic source ${i}`}));
  const capture={mediaKey:media.key,fullEpisode:true,resourceSha256:'a'.repeat(64),endMs:4800};
  const sourceTrack={name:'synthetic.vtt',provenance:'netflix-manifest-resource',language:'en',format:'vtt',sync:{offsetMs:0,scale:1},cues,capture};
  const request=await core.makeTranslationRequest({media,source:sourceTrack,reference:null,mode:'translate'});
  return {jobId:request.requestId,mediaKey:media.key,sourceHash:request.sourceHash,request,media,sourceTrack,capture,cueCount:4,status:'translating'};
}
async function environment({storage={},saved=new Map(),detail=null,tabKey='netflix:101',useCapture=false}={}) {
  detail||=await job();
  const calls=[],loads=[],timers=new Map(),alarms=new Map();let sequence=0,liveKey=tabKey,current=detail;
  const library={get:async key=>structuredClone(saved.get(key)),put:async session=>{
    const previous=saved.get(session.mediaKey);if((previous?.revision||0)!==(session.revision||0)){const e=new Error('conflict');e.name='ConflictError';throw e;}
    const next=structuredClone({...session,revision:String(++sequence)});saved.set(next.mediaKey,next);return structuredClone(next);
  }};
  const chrome={storage:{local:{get:async key=>({[key]:structuredClone(storage[key])}),set:async values=>Object.assign(storage,structuredClone(values))}},
    alarms:{get:async name=>alarms.get(name),create:async(name,data)=>alarms.set(name,data),clear:async name=>alarms.delete(name)},
    tabs:{sendMessage:async(id,message)=>{calls.push({tabId:id,...message});
      if(message.action==='subtitleState')return {hasVideo:true,media:{...current.media,key:liveKey,videoId:liveKey.split(':')[1]}};
      if(message.action==='listNetflixTracks')return {tracks:[{id:'en',rawTrackType:'closedcaptions'}]};
      if(message.action==='captureNetflixTrack')return {track:current.sourceTrack,rawText:'synthetic raw original'};
      if(message.action==='loadSubtitleSession'){loads.push(structuredClone(message.session));return {hasVideo:true};}
      throw new Error('Unexpected tab action');
    }}};
  const context=vm.createContext({crypto:webcrypto,TextEncoder,structuredClone,AbortController,URL,console,
    setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
  for(const code of transportModules)vm.runInContext(code,context);
  for(const filename of ['core.js','translation-prompt.js','bridge-client.js','translation-worker.js'])vm.runInContext(await readFile(new URL(`../subtitles/${filename}`,import.meta.url),'utf8'),context,{filename});
  const client=context.OTTBridgeClient;
  if(!saved.has(detail.mediaKey)){
    const initial=client.emptySession(detail.media);initial.tracks.source=useCapture?null:detail.sourceTrack;initial.tracks.a={name:'preserved A',cues:[]};saved.set(detail.mediaKey,structuredClone(initial));
  }
  storage.ottspeedBridge={token:'synthetic-token'};
  const fetch=async(url,options)=>{calls.push({url,options});assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer synthetic-token');
    return {ok:true,json:async()=>structuredClone(url.endsWith('/jobs')?{jobs:[current]}:current)};
  };
  const create=()=>context.OTTTranslationWorker({chrome,core:context.OTTSubtitles,client,library,fetch});
  return {worker:create(),create,client,library,saved,storage,detail,calls,loads,alarms,timers,
    setTab:key=>{liveKey=key;},setDetail:value=>{current=value;}};
}
async function prefix(f,count,revision) {
  const d=structuredClone(f.detail);d.progress={kind:'ottspeed.translation-progress',schemaVersion:1,requestId:d.jobId,sourceHash:d.sourceHash,mediaKey:d.mediaKey,revision,cues:d.request.slots.slice(0,count).map(s=>({id:s.id,text:`합성 ${s.id}`}))};
  d.progressHash=await f.client.hash(d.progress);d.readyCueCount=count;d.readyThroughMs=count<4?d.request.slots[count].startMs:4800;f.setDetail(d);return d;
}
async function final(f) {
  const d=structuredClone(f.detail);d.status='complete';d.response={...d.request.outputTemplate,cues:d.request.slots.map(s=>({id:s.id,text:`합성 ${s.id}`}))};d.resultHash=await f.client.hash(d.response);d.readyCueCount=4;d.readyThroughMs=4800;f.setDetail(d);return d;
}

test('source preparation preserves A/B and stores actual capture evidence without bridge writes',async()=>{
  const f=await environment({useCapture:true});const result=await f.worker.prepareSource(7);
  assert.equal(result.source.cues.length,4);assert.equal(f.saved.get('netflix:101').netflixCapture.rawText,'synthetic raw original');
  assert.equal(f.saved.get('netflix:101').tracks.a.name,'preserved A');assert.equal(f.calls.some(c=>c.url),false);
  await f.worker.prepareSource(7);assert.equal(f.calls.filter(c=>c.action==='captureNetflixTrack').length,1);
});

test('archive-only batch receiving survives restart without replacing current source, A/B or settings',async()=>{
 const f=await environment(),saved=await f.library.get(f.detail.mediaKey);saved.tracks.source=structuredClone(saved.tracks.source);saved.tracks.source.capture.resourceSha256='b'.repeat(64);saved.tracks.b={name:'manual B',language:'ko',format:'vtt',cues:[],sync:{offsetMs:0,scale:1}};saved.settings.activeTarget='a';saved.settings.fontSize=56;await f.library.put(saved);
 await prefix(f,1,1);await f.worker.watch(null,f.detail.jobId,f.detail.mediaKey,{selectResults:false});
 assert.equal(f.storage.ottspeedTranslation.runs[f.detail.jobId].selectResults,false);assert.equal(f.saved.get(f.detail.mediaKey).tracks.b.name,'manual B');assert.equal(f.loads.length,0);
 const restarted=f.create();await restarted.initialize();await final(f);await restarted.poll();const result=f.saved.get(f.detail.mediaKey);
 assert.equal(result.bridgeResults[f.detail.jobId].track.cues.length,4);assert.equal(result.tracks.b.name,'manual B');assert.equal(result.tracks.source.capture.resourceSha256,'b'.repeat(64));assert.equal(result.tracks.a.name,'preserved A');assert.equal(result.settings.activeTarget,'a');assert.equal(result.settings.fontSize,56);assert.equal(f.loads.length,0);
 assert.equal(result.bridgeSnapshots[f.detail.jobId].request.sourceHash,f.detail.sourceHash);
});

test('batch receiving registration keeps an already active viewing subscription',async()=>{
 const f=await environment();await prefix(f,1,1);await f.worker.watch(7,f.detail.jobId,f.detail.mediaKey);
 await f.worker.watch(null,f.detail.jobId,f.detail.mediaKey,{selectResults:false});assert.equal(f.storage.ottspeedTranslation.runs[f.detail.jobId].selectResults,true);
 await final(f);await f.worker.poll();assert.equal(f.saved.get(f.detail.mediaKey).tracks.b.cues.length,4);assert.equal(f.loads.at(-1).tracks.b.partial,false);
});

test('GET-only worker receives prefixes with no workspace, keeps settings, and stops after final across restart',async()=>{
  const f=await environment();await prefix(f,1,1);await f.worker.watch(7,f.detail.jobId,f.detail.mediaKey);
  assert.equal(f.loads.length,1);assert.equal(f.loads[0].tracks.b.cues.length,1);assert.equal(f.loads[0].tracks.a.name,'preserved A');assert(f.alarms.size);
  const saved=await f.library.get(f.detail.mediaKey);Object.assign(saved.settings,{fontSize:56,display:'bilingual',activeTarget:'a'});await f.library.put(saved);
  await prefix(f,2,2);await f.worker.poll();assert.equal(f.loads.at(-1).tracks.b.cues.length,2);assert.equal(f.loads.at(-1).settings.fontSize,56);assert.equal(f.loads.at(-1).settings.activeTarget,'a');
  const restarted=f.create();await restarted.initialize();await final(f);await restarted.poll();
  assert.equal(f.saved.get(f.detail.mediaKey).tracks.b.partial,false);assert.equal(f.saved.get(f.detail.mediaKey).tracks.b.cues.length,4);assert.equal(f.alarms.size,0);
  assert(f.calls.filter(c=>c.url).every(c=>c.options.method==='GET'));
});

test('switching episodes never applies one episode result to the new video',async()=>{
  const f=await environment({tabKey:'netflix:202'});await prefix(f,1,1);await f.worker.watch(7,f.detail.jobId,f.detail.mediaKey);
  assert.equal(f.loads.length,0);assert.equal(f.saved.get('netflix:101').tracks.b.cues.length,1);
  await f.worker.observe(7,'netflix:202');await prefix(f,2,2);await f.worker.poll();
  assert.equal(f.loads.length,0);assert.equal(f.saved.has('netflix:202'),false);assert.equal(f.saved.get('netflix:101').tracks.b.cues.length,2);
});

test('client rejects corrupted hashes and regressions, and honors manual B suspension',async()=>{
  const f=await environment();let d=await prefix(f,2,2);await f.worker.watch(7,d.jobId,d.mediaKey);
  const count=f.loads.length;d=await prefix(f,3,3);d.progressHash='0'.repeat(64);f.setDetail(d);await f.worker.poll();
  assert.equal(f.loads.length,count);assert.match(f.storage.ottspeedTranslation.runs[d.jobId].lastError,/해시/);
  d=await prefix(f,1,1);await f.worker.poll();assert.equal(f.saved.get(d.mediaKey).tracks.b.cues.length,2);
  const manual=await f.library.get(d.mediaKey);manual.bridge.suspended=true;manual.tracks.b={name:'manual B',cues:[]};await f.library.put(manual);
  d=await final(f);await f.worker.poll();assert.equal(f.saved.get(d.mediaKey).tracks.b.name,'manual B');assert.equal(f.saved.get(d.mediaKey).bridgeResults[d.jobId].track.cues.length,4);
});

test('library registration receives without a video tab and archives an already-complete result without changing selection',async()=>{
  const f=await environment();await final(f);await f.worker.watch(null,f.detail.jobId,f.detail.mediaKey);
  const saved=f.saved.get(f.detail.mediaKey);assert.equal(saved.tracks.b,null);assert.equal(saved.settings.activeTarget,'a');assert.equal(saved.bridgeResults[f.detail.jobId].track.cues.length,4);assert.equal(f.loads.length,0);
  assert(saved.bridgeSnapshots[f.detail.jobId].request.sourceHash===f.detail.sourceHash);
});
