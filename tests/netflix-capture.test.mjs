// Synthetic assets only. Passing does not establish actual Netflix capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import core from '../subtitles/core.js';
import netflix from '../subtitles/netflix.js';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const isolatedCode=await readFile(new URL('../subtitles/netflix-capture.js',import.meta.url),'utf8');
function isolated({owned=true,hidden=true}={}){
  const nonce='11111111-1111-4111-8111-111111111111',events=new Map(),windowEvents=new Map(),sent=[];let receive;
  const location={hostname:'www.netflix.com',origin:'https://www.netflix.com',pathname:'/watch/123',hash:owned?`#ottspeed-capture=${nonce}`:'',href:'https://www.netflix.com/watch/123'};
  const document={visibilityState:hidden?'hidden':'visible',readyState:'complete',body:{innerText:''},addEventListener:(name,fn)=>events.set(name,fn)};
  const window={addEventListener:(name,fn)=>windowEvents.set(name,fn),removeEventListener:name=>windowEvents.delete(name),postMessage:value=>sent.push(value)};
  const chrome={runtime:{id:'synthetic-extension',onMessage:{addListener:fn=>{receive=fn;}}}};
  const context=vm.createContext({location,document,window,chrome,crypto:webcrypto,OTTSubtitles:core,setTimeout:()=>1,clearTimeout:()=>{}});vm.runInContext(isolatedCode,context);
  return {document,location,events,sent,nonce,send(message,sender={id:chrome.runtime.id}){let reply;const handled=receive(message,sender,value=>{reply=value;});return {reply,handled};}};
}
test('dedicated capture guard pauses only its own hidden video and releases ownership on takeover',()=>{
  for(const owned of [false,true])for(const hidden of [false,true]){const f=isolated({owned,hidden});let pauses=0;f.events.get('play')({target:{tagName:'VIDEO',pause:()=>pauses++}});assert.equal(pauses,owned&&hidden?1:0);if(owned){f.send({action:'captureQueueRelease',ownerToken:f.nonce});f.events.get('play')({target:{tagName:'VIDEO',pause:()=>pauses++}});assert.equal(pauses,hidden?1:0);}}
});
test('isolated capture accepts only own extension, exact episode, nonce, and hidden tab',()=>{
  const f=isolated();assert.equal(f.send({action:'captureQueueState'},{id:'other-extension'}).reply,undefined);
  for(const message of [{action:'captureQueueCollect',mediaKey:'netflix:124',ownerToken:f.nonce},{action:'captureQueueCollect',mediaKey:'netflix:123',ownerToken:'wrong'}])assert(f.send(message).reply.error);
  assert.equal(f.sent.length,0);assert.equal(f.send({action:'captureQueueCollect',mediaKey:'netflix:123',ownerToken:f.nonce}).handled,true);assert.equal(f.sent[0].action,'capture');
  const foreground=isolated({hidden:false});assert(foreground.send({action:'captureQueueCollect',mediaKey:'netflix:123',ownerToken:foreground.nonce}).reply.error);
  f.document.body.innerText='Error M7020';assert.equal(f.send({action:'captureQueueState'}).reply.issue,'netflix_concurrent_stream');f.location.pathname='/login';assert.equal(f.send({action:'captureQueueState'}).reply.issue,'login_required');
});
test('Netflix whole-file VTT counts and overlapping IDs/times remain intact',()=>{
  const result=netflix.parseAsset('WEBVTT\n\na\n00:00:01.000 --> 00:00:03.000\nFirst.\n\nb\n00:00:02.000 --> 00:00:04.000\nSecond.\n',core,DOMParser);
  assert.equal(result.audit.inputCount,2); assert.equal(result.audit.acceptedCount,2);
  assert.equal(result.audit.allTimedEntriesAccountedFor,true);
  assert.deepEqual(result.cues.map(c=>[c.id,c.startMs,c.endMs]),[['a',1000,3000],['b',2000,4000]]);
});
test('Netflix TTML tick rate, line breaks, IDs and empty nodes are accounted for',()=>{
  const xml='<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000"><body><div><p xml:id="n1" begin="10000000t" end="25000000t">A &amp; B<br/>Second line.</p><p begin="3s" end="4s"> </p></div></body></tt>';
  const result=netflix.parseAsset(xml,core,DOMParser);
  assert.deepEqual(result.cues,[{id:'n1',startMs:1000,endMs:2500,text:'A & B\nSecond line.'}]);
  assert.equal(result.audit.inputCount,2); assert.equal(result.audit.excludedCount,1);
  assert.equal(result.audit.allTimedEntriesAccountedFor,true);
});
test('Unsupported times and image-only nodes prevent complete coverage',()=>{
  const result=netflix.parseAsset('<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="bad" end="2s">Unparsed.</p><p begin="3s" end="4s" backgroundImage="image1"/></div></body></tt>',core,DOMParser);
  assert.equal(result.audit.allTimedEntriesAccountedFor,false);
  assert.equal(result.audit.excludedCount,2);
});
test('Truncated XML and external declarations are refused',()=>{
  assert.throws(()=>netflix.parseAsset('<tt><body>',core,DOMParser));
  assert.throws(()=>netflix.parseAsset('<!DOCTYPE tt><tt></tt>',core,DOMParser));
});

const hookSource=await readFile(new URL('../subtitles/netflix-main.js',import.meta.url),'utf8');
function hook(fetcher=async()=>new Response('WEBVTT\n\nn1\n00:00:01.000 --> 00:00:02.000\nSynthetic only.\n')){
  const results=[],listeners=[];
  class XHR { open(){} addEventListener(){} }
  const location={pathname:'/watch/123',origin:'https://www.netflix.com'};
  const window={fetch:fetcher,postMessage:message=>results.push(message),addEventListener:(type,fn)=>listeners.push(fn)};
  const context=vm.createContext({window,location,XMLHttpRequest:XHR,OTTSubtitles:core,OTTNetflixSubtitles:netflix,
    DOMParser,URL,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto});
  vm.runInContext(hookSource,context);
  return {context,results,location,request(action,extra={}){
    listeners[0]({source:window,origin:location.origin,data:{channel:'ottspeed-netflix-request',nonce:'test-only',videoId:'123',action,...extra}});
  }};
}
const manifestTrack=(language='en')=>({new_track_id:'english-cc',language,languageDescription:'English CC',ttDownloadables:{'webvtt-lssdh-ios8':{downloadUrls:{a:'https://test.nflxvideo.net/subtitle'}}}});
async function settle(h){for(let i=0;i<100;i++){if(h.results.length)return;await new Promise(r=>setImmediate(r));}throw new Error('Hook did not settle');}
test('Legacy manifest identity and English whole file survive MAIN-to-content result',async()=>{
  const h=hook(); h.context.fixture=JSON.stringify({result:{movieId:123,timedtexttracks:[manifestTrack(),manifestTrack('ko')]}});
  vm.runInContext('JSON.parse(fixture)',h.context);
  h.request('capture',{trackId:'english-cc'});await settle(h);
  assert.equal(h.results[0].result.track.capture.fullEpisode,true);
  assert.equal(h.results[0].result.track.capture.cueCount,1);
  assert.equal(h.results[0].result.track.capture.videoId,'123');
  assert.equal(h.results[0].result.track.sync.offsetMs,0);
});
test('Modern manifest textTracks is accepted, other-episode manifest never supplies the current track',async()=>{
  const modern={id:'english-modern',bcp47:'en',downloadables:{'webvtt-lssdh-ios8':{urls:[{url:'https://test.nflxvideo.net/modern'}]}}};
  const h=hook(); h.context.fixture=JSON.stringify({result:{viewableId:999,textTracks:[modern]}});
  vm.runInContext('JSON.parse(fixture)',h.context);h.request('list');await settle(h);
  assert.equal(h.results[0].result.tracks.length,0);
  h.results.length=0;h.context.fixture=JSON.stringify({result:{viewableId:123,textTracks:[modern]}});
  vm.runInContext('JSON.parse(fixture)',h.context);h.request('list');await settle(h);
  assert.equal(h.results[0].result.tracks.length,1);
  assert.equal(h.results[0].result.tracks[0].id,'english-modern');
});
test('Nested manifest profile requests add VTT without replacing other formats',()=>{
  const h=hook();h.context.fixture=JSON.stringify({requests:[{url:'/licensedManifest',payload:{profiles:['original-profile']}}]});
  const output=vm.runInContext('JSON.stringify(JSON.parse(fixture))',h.context);
  assert.deepEqual(JSON.parse(output).requests[0].payload.profiles,['original-profile','webvtt-lssdh-ios8']);
});
test('Changing episode during the resource download refuses the result',async()=>{
  let finish;const h=hook(()=>new Promise(resolve=>{finish=resolve;}));
  h.context.fixture=JSON.stringify({result:{movieId:123,timedtexttracks:[manifestTrack()]}});
  vm.runInContext('JSON.parse(fixture)',h.context);h.request('capture',{trackId:'english-cc'});
  h.location.pathname='/watch/124';finish(new Response('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nSynthetic.\n'));await settle(h);
  assert.match(h.results[0].error,/회차가 바뀌/);
});
