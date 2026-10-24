// Synthetic data and Chrome API doubles only; never a claim of live Netflix capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
import {DOMParser} from '@xmldom/xmldom';
import core from '../subtitles/core.js';
import netflix from '../subtitles/netflix.js';
import validation from '../subtitles/capture-validation.js';
const code=await readFile(new URL('../subtitles/collection-queue.js',import.meta.url),'utf8');
function fixture(id='123',rawText='WEBVTT\n\na\n00:00:01.000 --> 00:00:03.000\nSynthetic one.\n\nb\n00:00:01.000 --> 00:00:03.000\nSynthetic two.\n',bom=false){
  const parsed=netflix.parseAsset(rawText,core,DOMParser),bytes=Buffer.from((bom?'\ufeff':'')+rawText);
  return {rawText,track:{name:'synthetic.en.vtt',language:'en',format:'vtt',provenance:'netflix-manifest-resource',sync:{offsetMs:0,scale:1},cues:parsed.cues,capture:{mediaKey:`netflix:${id}`,videoId:id,fullEpisode:true,coverage:'complete',track:{language:'en',profile:'webvtt-lssdh-ios8',segmented:false},audit:parsed.audit,resourceBytes:bytes.length,resourceSha256:createHash('sha256').update(bytes).digest('hex'),cueCount:parsed.cues.length,startMs:1000,endMs:3000}},inspection:{independentByteHashVerified:true,independentReparseMatches:true}};
}
const media=id=>core.mediaIdentity(`https://www.netflix.com/watch/${id}`);
test('independent validation checks bytes, BOM, exact overlapping IDs, and complete item accounting',async()=>{
  for(const bom of [false,true]){const f=fixture('123',undefined,bom),r=await validation.resource(f,media('123'),DOMParser);assert.equal(r.bomReconstructed,bom);assert.equal(r.independentReparseMatches,true);}
  for(const change of [f=>f.rawText+='changed',f=>f.track.capture.fullEpisode=false,f=>f.track.capture.audit.excludedCount=1,f=>f.track.cues[0].text='altered',f=>f.track.capture.resourceBytes++,f=>f.track.sync.offsetMs=10,f=>f.track.capture.videoId='124']){const f=fixture();change(f);await assert.rejects(validation.resource(f,media('123'),DOMParser));}
  await assert.rejects(validation.resource(fixture(),media('124'),DOMParser));
});
test('TTML independently reparses original IDs and times',async()=>{
  const f=fixture('123','<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p xml:id="a" begin="1s" end="3s">First<br/>Second.</p></div></body></tt>');f.track.capture.track.profile='dfxp-ls-sdh';
  assert.equal((await validation.resource(f,media('123'),DOMParser)).independentReparseMatches,true);
});
function harness({stored=null,cached=null,viewer=false,result=fixture(),ready=true,issue=null,onCapture=null,onCreate=null,onSaved}={}){
  let clock=1000,next=10;const store=stored?{ottspeedCollection:structuredClone(stored)}:{},tabs=new Map(),states=new Map(),created=[],removed=[],messages=[],writes=[],sessions=new Map(cached?[[cached.mediaKey,structuredClone(cached)]]:[]),alarms=new Map(),timers=new Map();
  if(viewer)tabs.set(1,{id:1,active:true,url:'https://www.netflix.com/watch/999'});
  const chrome={storage:{local:{get:async key=>({[key]:structuredClone(store[key])}),set:async value=>Object.assign(store,structuredClone(value))}},alarms:{get:async name=>alarms.get(name),create:async(name,value)=>alarms.set(name,value),clear:async name=>alarms.delete(name)},tabs:{
    query:async()=>structuredClone([...tabs.values()]),get:async id=>{if(!tabs.has(id))throw new Error('missing');return structuredClone(tabs.get(id));},
    create:async options=>{created.push(options);const tab={id:next++,active:options.active,url:options.url};tabs.set(tab.id,tab);states.set(tab.id,{ownerToken:new URL(options.url).hash.split('=')[1],videoId:/watch\/(\d+)/.exec(options.url)[1],ready,issue});if(onCreate)await onCreate(tab);return structuredClone(tab);},
    remove:async id=>{removed.push(id);tabs.delete(id);states.delete(id);},
    sendMessage:async(id,message)=>{messages.push({id,message});if(!tabs.has(id))throw new Error('missing');const state=states.get(id);if(message.action==='captureQueueState')return structuredClone(state);if(message.action==='captureQueueRelease'){if(state?.ownerToken===message.ownerToken)state.ownerToken=null;return {released:true};}if(message.action==='listNetflixTracks')return {tracks:[{id:'en',language:'en'}]};if(message.action==='captureQueueCollect'){if(onCapture)await onCapture(id);return structuredClone(result);}return null;}
  }};
  const library={get:async key=>structuredClone(sessions.get(key)),put:async value=>{writes.push(structuredClone(value));sessions.set(value.mediaKey,structuredClone(value));}};
  const context=vm.createContext({chrome,crypto:webcrypto,structuredClone,setTimeout:fn=>{const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});vm.runInContext(code,context);
  const queue=context.OTTCollectionQueue({chrome,core,validation,library,onSaved,now:()=>clock,timeoutMs:90000});
  return {queue,store,tabs,states,created,removed,messages,writes,sessions,alarms,timers,library,advance:ms=>{clock+=ms;},restart:()=>context.OTTCollectionQueue({chrome,core,validation,library,now:()=>clock,timeoutMs:90000})};
}
async function drain(f){await f.queue.tick();return f.queue.status();}
test('a committed capture triggers registration; a disconnected bridge does not discard the source',async()=>{
  let notified=0;const f=harness({onSaved:async()=>{assert.equal(f.writes.length,1);notified++;throw new Error('bridge offline');}});
  await f.queue.enqueue(['123']);assert.equal((await drain(f)).entries[0].status,'complete');assert.equal(notified,1);assert.equal(f.sessions.get('netflix:123').tracks.source.cues.length,2);
});
test('restart clears persisted cleanup for vanished tabs and continues with the next episode',async()=>{
  for(const tabId of [10,null]){
    const f=harness();await f.queue.enqueue(['123','124']);await drain(f);
    const first=f.store.ottspeedCollection.entries[0];Object.assign(first,{tabId,cleanupPending:true,cleanupExpected:true,cleanupStartedAt:1000});
    const restarted=f.restart();await restarted.initialize();await restarted.tick();await restarted.tick();
    const state=await restarted.status();assert.equal(state.entries[0].tabId,null);assert.equal(state.entries[0].cleanupPending,false);assert.equal(state.entries[0].cleanupExpected,false);
    assert.notEqual(state.entries[1].status,'queued');assert.equal(f.created.length,2);
  }
});
test('serial queue uses inactive owned tabs, preserves A/B/settings, and archives independently validated source',async()=>{
  const old={mediaKey:'netflix:123',media:media('123'),tracks:{source:null,a:{name:'keep A'},b:{name:'keep B'}},settings:{fontSize:56,activeTarget:'b'},revision:2},f=harness({cached:old});
  await f.queue.enqueue(['123','124']);let s=await drain(f);assert.equal(s.entries[0].status,'complete');assert.equal(s.entries[1].status,'queued');assert.equal(f.created[0].active,false);assert.match(f.created[0].url,/#ottspeed-capture=/);assert.equal(f.removed.length,1);
  assert.deepEqual(f.writes[0].tracks.a,old.tracks.a);assert.deepEqual(f.writes[0].tracks.b,old.tracks.b);assert.deepEqual(f.writes[0].settings,old.settings);assert.equal(f.writes[0].tracks.source.cues.length,2);assert.equal(f.writes[0].netflixCapture.rawText,fixture().rawText);
  // A mismatched second episode must not be archived.
  s=await drain(f);assert.equal(s.entries[1].status,'needs_attention');assert.equal(f.writes.length,1);
});
test('any existing Netflix watch tab blocks new tabs; validated cached originals bypass navigation',async()=>{
  const f=harness({viewer:true});await f.queue.enqueue(['123']);assert.equal((await drain(f)).entries[0].status,'waiting_for_viewer');assert.equal(f.created.length,0);assert.equal(f.removed.length,0);
  f.tabs.delete(1);assert.equal((await drain(f)).entries[0].status,'complete');
  const cached={mediaKey:'netflix:123',media:media('123'),tracks:{source:fixture().track}},c=harness({viewer:true,cached});await c.queue.enqueue(['123']);assert.equal((await drain(c)).entries[0].cached,true);assert.equal(c.created.length,0);assert.equal(c.writes.length,0);
});
test('known page errors and manifest deadlines are bounded and never reported as completed',async()=>{
  for(const issue of ['netflix_concurrent_stream','login_required']){const f=harness({issue});await f.queue.enqueue(['123']);const e=(await drain(f)).entries[0];assert.equal(e.status,'needs_attention');assert.equal(e.errorCode,issue);assert.equal(f.writes.length,0);assert.equal(f.removed.length,1);}
  const f=harness({ready:false});await f.queue.enqueue(['123']);await drain(f);f.advance(90001);const e=(await drain(f)).entries[0];assert.equal(e.errorCode,'manifest_timeout');assert.equal(f.writes.length,0);
});
test('worker restart recovers the exact nonce without creating duplicate tabs',async()=>{
  const f=harness({ready:false});await f.queue.enqueue(['123']);await drain(f);const e=f.store.ottspeedCollection.entries[0];e.status='opening';e.tabId=null;
  const restarted=f.restart();await restarted.initialize();await restarted.tick();assert.equal(f.created.length,1);assert.equal((await restarted.status()).entries[0].tabId,10);assert(f.alarms.has(restarted.alarm));
  f.states.get(10).ready=true;await restarted.tick();assert.equal((await restarted.status()).entries[0].status,'complete');assert.equal(f.writes.length,1);
});
test('foreground takeover releases ownership without pausing, closing, or saving into the user tab',async()=>{
  const f=harness({ready:false});await f.queue.enqueue(['123']);await drain(f);f.tabs.get(10).active=true;const s=await drain(f);assert.equal(s.entries[0].errorCode,'capture_tab_taken_over');assert.equal(f.removed.length,0);assert.equal(f.writes.length,0);assert.equal(f.states.get(10).ownerToken,null);
});
test('navigation and missing independent validation refuse archive; unrelated tabs stay open',async()=>{
  const f=harness({ready:false});await f.queue.enqueue(['123']);await drain(f);f.states.get(10).ownerToken=null;assert.equal((await drain(f)).entries[0].errorCode,'capture_tab_navigated');assert.equal(f.removed.length,0);
  const result=fixture();delete result.inspection;const bad=harness({result});await bad.queue.enqueue(['123']);assert.equal((await drain(bad)).entries[0].status,'needs_attention');assert.equal(bad.writes.length,0);
});
test('cancellation during creation and resource download cannot save a cancelled source',async()=>{
  let release,started;const created=new Promise(r=>{started=r;});const f=harness({onCreate:async()=>{started();await new Promise(r=>{release=r;});}});
  await f.queue.enqueue(['123']);await created;const id=(await f.queue.status()).entries[0].id;await f.queue.cancel(id);release();await drain(f);assert.equal((await f.queue.status()).entries[0].status,'cancelled');assert.equal(f.removed.length,1);assert.equal(f.writes.length,0);
  let downloaded,continueCapture;const download=new Promise(r=>{downloaded=r;});const c=harness({onCapture:async()=>{downloaded();await new Promise(r=>{continueCapture=r;});}});
  await c.queue.enqueue(['123']);await download;await c.queue.cancel((await c.queue.status()).entries[0].id);continueCapture();await drain(c);assert.equal(c.writes.length,0);assert.equal((await c.queue.status()).entries[0].status,'cancelled');
});
test('pause persists across restart, resumes serially, and invalid queue input is atomic',async()=>{
  const f=harness({ready:false});await f.queue.enqueue(['123']);await drain(f);await f.queue.pause();assert.equal((await f.queue.status()).paused,true);assert.equal(f.removed.length,1);await f.restart().tick();assert.equal(f.created.length,1);
  await f.queue.resume();await drain(f);assert.equal(f.created.length,2);
  const count=(await f.queue.status()).entries.length;await assert.rejects(f.queue.enqueue(['124','https://example.com/watch/123']));assert.equal((await f.queue.status()).entries.length,count);await assert.rejects(f.queue.enqueue([]));
});

test('cancellation during the last library read and a newly opened viewing tab both prevent source writes',async()=>{
  const f=harness();let calls=0,release,arrived;const reached=new Promise(r=>{arrived=r;}),get=f.library.get;
  f.library.get=async key=>{if(++calls===2){arrived();await new Promise(r=>{release=r;});}return get(key);};
  await f.queue.enqueue(['123']);await reached;await f.queue.cancel((await f.queue.status()).entries[0].id);release();await drain(f);assert.equal(f.writes.length,0);
  const c=harness({onCapture:async()=>{c.tabs.set(1,{id:1,active:true,url:'https://www.netflix.com/watch/999'});}});await c.queue.enqueue(['123']);await drain(c);assert.equal(c.writes.length,0);assert(c.tabs.has(1));assert.deepEqual(c.removed,[10]);
});
