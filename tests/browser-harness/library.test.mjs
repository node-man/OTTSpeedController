// Deterministic management UI boundaries; no actual browser/IndexedDB/Netflix claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {makeEnvironment} from './dom.mjs';
import catalog from '../../subtitles/catalog.js';
import core from '../../subtitles/core.js';
const transportModules=await Promise.all(['shared/product.js','modules/runtime/bridge-http.js','modules/library/mcp-registration.js'].map(path=>readFile(new URL('../../'+path,import.meta.url),'utf8')));

const html=await readFile(new URL('../../subtitles/library.html',import.meta.url),'utf8');
const script=await readFile(new URL('../../subtitles/library-page.js',import.meta.url),'utf8');
const media=id=>({key:`netflix:${id}`,platform:'netflix',videoId:String(id),url:`https://www.netflix.com/watch/${id}`});
const track=(text,lang='en')=>({name:`synthetic.${lang}.vtt`,language:lang,format:'vtt',cues:[{id:'one',startMs:1000,endMs:2000,text}],sync:{offsetMs:0,scale:1}});
const session=(id=101)=>({mediaKey:media(id).key,media:media(id),catalog:{title:'합성 작품',season:2,episode:id===101?3:4},tracks:{source:track('A synthetic original line.'),a:track('기준 합성 자막.','ko'),b:track('<img src=x onerror=throw()>문자 그대로.','ko')},settings:{enabled:true,activeTarget:'a',fontSize:56,display:'bilingual'},revision:`r-${id}`});
import {until} from './wait.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
import {collected} from '../fixtures/collected.mjs';
async function environment(values=[session()],{archive=[],paired=false}={}) {
 const env=await makeEnvironment(),{context,document}=env;const downloads=[],blobs=new Map(),calls=[],runtime=[],stored=paired?{ottspeedBridge:{token:'synthetic-token'}}:{},intervals=[],bridgeState={ready:false,execution:null,startFailure:false},collection={version:1,paused:false,entries:[]},batches=new Map(),details=new Map(),map=new Map(values.map(s=>[s.mediaKey,structuredClone(s)]));let rev=0,restores=0;
 async function makeDetail(jobId,value){const sourceTrack=structuredClone(value.tracks.source);sourceTrack.capture={...sourceTrack.capture,mediaKey:value.mediaKey,fullEpisode:true};const request=await core.makeTranslationRequest({media:value.media,source:sourceTrack});request.requestId=jobId;request.outputTemplate.requestId=jobId;return {jobId,media:value.media,mediaKey:value.mediaKey,request,sourceHash:request.sourceHash,sourceTrack};}
 const historic=await makeDetail('historic-job',session(202));details.set(historic.jobId,historic);batches.set('historic-batch',{batchId:'historic-batch',createdAt:'2026-10-24T00:00:00Z',entries:[{jobId:historic.jobId,sourceHash:historic.sourceHash,mediaKey:historic.mediaKey,cueCount:1,readyCueCount:0,chunkCount:1,savedChunkCount:0,readChunkCount:0}],completedCount:0,pendingCount:1,blockedCount:0,status:'translating'});
 const create=document.createElement.bind(document);document.createElement=tag=>{const el=create(tag);el.value='';el.checked=false;el.disabled=false;el.files=[];el.click=()=>{if(tag==='a'&&el.download)downloads.push({name:el.download,blob:blobs.get(el.href)});el.dispatchEvent('click');};return el;};
 for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)){const el=document.createElement(match[1]);el.id=match[3];document.body.appendChild(el);}
 context.structuredClone=structuredClone;context.Blob=Blob;context.URL=class extends URL{static createObjectURL(blob){const id=`blob:${blobs.size}`;blobs.set(id,blob);return id;}static revokeObjectURL(){}};
 context.setTimeout=()=>1;context.clearTimeout=()=>{};context.setInterval=cb=>{intervals.push(cb);return intervals.length;};context.AbortController=AbortController;
 context.navigator={clipboard:{writeText:async text=>calls.push({clipboard:text})}};
 context.chrome={storage:{local:{get:async key=>({[key]:stored[key]}),set:async value=>Object.assign(stored,structuredClone(value))}},runtime:{sendMessage:async message=>{runtime.push(message);if(message.action==='ensureLocalRuntime')return {ready:true};if(message.action==='getCollectionQueue')return structuredClone(collection);if(message.action==='enqueueCollection'){for(const value of message.urls)collection.entries.push({id:value,videoId:value,status:'waiting_for_viewer',errorCode:'netflix_tab_open'});return structuredClone(collection);}if(message.action==='pauseCollection'||message.action==='resumeCollection'){collection.paused=message.action==='pauseCollection';return structuredClone(collection);}if(message.action==='cancelCollection'){collection.entries.find(e=>e.id===message.id).status='cancelled';return structuredClone(collection);}return {saved:true};}}};
 context.OTTSubtitleLibrary={list:async()=>structuredClone([...map.values()]),get:async key=>structuredClone(map.get(key)),put:async value=>{const old=map.get(value.mediaKey);assert.equal(old?.revision||0,value.revision||0);const next=await catalog.prepareWrite(old,value);next.revision=`revision-${++rev}`;map.set(next.mediaKey,structuredClone(next));return structuredClone(next);},restore:async values=>{restores++;let inserted=0,skipped=0;for(const s of values){if(map.has(s.mediaKey))skipped++;else{map.set(s.mediaKey,structuredClone({...s,revision:`restored-${++rev}`}));inserted++;}}return {inserted,skipped};}};
 context.fetch=async(url,options)=>{
  calls.push({url,options});let data={};
  if(url.endsWith('/pair'))data={token:'synthetic-token'};
  else if(url.endsWith('/library/archive'))data={kind:'ottspeed.library-archive-index',version:1,episodeCount:archive.length,episodes:archive.map(e=>({mediaKey:e.mediaKey,videoId:e.media.videoId,catalog:e.catalog,revision:e.revision}))};
  else if(url.includes('/library/archive/'))data=structuredClone(archive.find(e=>e.media.videoId===url.split('/').at(-1)));
  else if(url.endsWith('/execution'))data={ready:bridgeState.ready};
  else if(url.endsWith('/jobs')&&options.method==='POST'){const body=JSON.parse(options.body);data={jobId:`job-${body.media.videoId}`,mediaKey:body.media.key,sourceHash:(await core.makeTranslationRequest({media:body.media,source:body.source})).sourceHash,capture:body.source.capture,cueCount:body.source.cues.length,chunkCount:1,savedChunkCount:0,status:'translating'};details.set(data.jobId,{...await makeDetail(data.jobId,{media:body.media,mediaKey:body.media.key,tracks:{source:body.source}}),...data});}
  else if(url.endsWith('/jobs')&&options.method==='GET')data={jobs:structuredClone([...details.values()].filter(d=>d.status))};
  else if(url.endsWith('/batches')&&options.method==='GET')data={batches:structuredClone([...batches.values()])};
  else if(url.endsWith('/batches')){const ids=JSON.parse(options.body).jobIds;data={batchId:'batch-fixture',entries:ids.map(jobId=>({jobId,sourceHash:details.get(jobId).sourceHash,mediaKey:details.get(jobId).mediaKey})),completedCount:0,pendingCount:ids.length,blockedCount:0,status:'translating'};batches.set(data.batchId,structuredClone(data));}
  else if(url.endsWith('/start')){if(bridgeState.startFailure)throw new TypeError('Synthetic request outcome unknown');data={mode:'workspace-agent',state:'queued',retryable:false,translationComplete:false};bridgeState.execution=data;}
  else {const id=url.split('/').at(-1);if(url.includes('/jobs/')&&details.has(id))data=structuredClone(details.get(id));else{if(!batches.has(id))throw new Error('Unexpected bridge call');data={...structuredClone(batches.get(id)),execution:structuredClone(bridgeState.execution)};}}
  return {ok:true,json:async()=>data};
 };
 for(const file of ['catalog.js','translation-prompt.js','bridge-client.js','netflix.js','capture-validation.js'])vm.runInContext(await readFile(new URL(`../../subtitles/${file}`,import.meta.url),'utf8'),context,{filename:file});
 for(const code of transportModules)vm.runInContext(code,context);
 vm.runInContext(script,context,{filename:'library-page.js'});await until(()=>document.getElementById('library-count').textContent.includes('个')||document.getElementById('library-count').textContent.includes('개 회차'));
 if(!archive.length)await until(()=>calls.some(c=>c.url?.endsWith('/library/archive'))&&!document.getElementById('refresh').disabled);
 return {...env,map,calls,runtime,downloads,stored,intervals,bridgeState,collection,batches,details,restoreCalls:()=>restores,el:id=>document.getElementById(id)};
}
function openFirst(f){f.el('episode-list').children[0].children[6].children[0].dispatchEvent('click');}

test('library lists and searches stored episodes without querying an active video; hostile cue markup stays literal',async()=>{
 const f=await environment([session(),session(202)]);assert.equal(f.el('episode-list').children.length,2);assert(f.runtime.every(m=>['getCollectionQueue','ensureLocalRuntime'].includes(m.action)));
 f.el('search').value='101';f.el('search').dispatchEvent('input');assert.equal(f.el('episode-list').children.length,1);openFirst(f);
 const items=await catalog.assets(f.map.get('netflix:101'));const b=items.find(a=>a.role==='b');f.el('asset-select').value=b.assetId;f.el('asset-select').dispatchEvent('change');
 assert.match(f.el('cue-preview').textContent,/<img/);assert.equal(f.el('cue-preview').querySelectorAll('img').length,0);assert.match(f.el('asset-status').textContent,/연결 미확인/);
 f.el('compare-time').value='1.5';f.el('compare').dispatchEvent('click');assert.match(f.el('comparison').textContent,/기준 합성 자막/);assert.match(f.el('comparison').textContent,/문자 그대로/);
});

test('metadata editing preserves tracks/settings, and selecting an archived B preserves the previous version',async()=>{
 const first=session(),old=await catalog.asset('b',track('이전 합성 번역.','ko'));first.versions=[old];const f=await environment([first]);openFirst(f);
 f.el('title').value='변경 작품';f.el('title').dispatchEvent('input');f.el('save-metadata').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('정보를 저장'));
 assert.equal(f.map.get(first.mediaKey).settings.fontSize,56);assert.equal(f.map.get(first.mediaKey).tracks.a.cues[0].text,'기준 합성 자막.');
 f.el('asset-select').value=old.assetId;f.el('asset-select').dispatchEvent('change');f.el('use-version').dispatchEvent('click');await until(()=>f.map.get(first.mediaKey).tracks.b.cues[0].text==='이전 합성 번역.');
 assert(f.map.get(first.mediaKey).versions.some(v=>v.track.cues[0].text.includes('문자 그대로')));assert.equal(f.runtime.at(-1).action,'refreshLibrarySession');
});

test('VTT export keeps original timings and backup/restore validates before preserving existing episodes',async()=>{
 const f=await environment();openFirst(f);f.el('export-vtt').dispatchEvent('click');await until(()=>f.downloads.length===1);
 const vtt=await f.downloads[0].blob.text();assert.match(vtt,/00:00:01\.000 --> 00:00:02\.000/);
 f.el('backup-all').dispatchEvent('click');await until(()=>f.downloads.length===2);const backup=await f.downloads[1].blob.text();assert.equal((await catalog.readBackup(backup)).length,1);
 const source=await catalog.createBackup([session(),session(202)]);f.el('restore-file').files=[{size:JSON.stringify(source).length,text:async()=>JSON.stringify(source)}];f.el('restore-file').dispatchEvent('change');await until(()=>f.el('notice').textContent.includes('회차 복원'));
 assert.equal(f.map.get('netflix:101').revision,'r-101');assert.equal(f.restoreCalls(),1);
 source.sha256='0'.repeat(64);f.el('restore-file').files=[{size:200,text:async()=>JSON.stringify(source)}];f.el('restore-file').dispatchEvent('change');await until(()=>f.el('notice').textContent.includes('해시'));assert.equal(f.restoreCalls(),1);
});

test('batch preparation uses only selected collected originals and registers receiving without opening a playback tab',async()=>{
 const values=[session(),session(202)];for(const s of values)s.tracks.source=collected(s.media.videoId,s.tracks.source.cues).source;
 const f=await environment(values);f.el('select-visible').dispatchEvent('click');f.el('prepare-batch').dispatchEvent('click');await until(()=>f.stored.ottspeedLibrary?.lastBatchId==='batch-fixture');
 assert.equal(f.el('batch-start').hidden,true);assert.equal(f.el('batch-start').disabled,true);assert.equal(f.el('batch-copy').disabled,false);assert.match(f.el('execution-mode').textContent,/기본 방식은 프롬프트 복사/);
 assert.equal(f.runtime.filter(m=>m.action==='watchLibraryTranslation').length,2);
 const jobs=f.calls.filter(c=>c.url?.endsWith('/jobs')&&c.options.method==='POST');assert.equal(jobs.length,2);assert(jobs.every(c=>!('reference' in JSON.parse(c.options.body))));
 f.el('batch-copy').dispatchEvent('click');await until(()=>f.calls.some(c=>c.clipboard));const prompt=f.calls.find(c=>c.clipboard).clipboard;assert(prompt.includes('job-101')&&prompt.includes('job-202'));assert.match(prompt,/다음 회차로/);
 assert(!f.calls.some(c=>c.url?.endsWith('/start')));
});

test('library exposes stale original links in the list and filters them separately from saved B',async()=>{
 const value=session(),request=await (await import('../../subtitles/core.js')).default.makeTranslationRequest({media:value.media,source:value.tracks.source});
 value.pendingRequest=request;value.tracks.b.requestId=request.requestId;value.tracks.source.cues[0].text='A different version of the original.';
 const f=await environment([value]);assert.match(f.el('episode-list').textContent,/원문 변경/);assert.match(f.el('episode-list').textContent,/다른 원문 버전의 번역/);
 f.el('state-filter').value='B 보관';f.el('state-filter').dispatchEvent('change');assert.equal(f.el('episode-list').children.length,0);
 f.el('state-filter').value='원문 변경';f.el('state-filter').dispatchEvent('change');assert.equal(f.el('episode-list').children.length,1);openFirst(f);
 const items=await catalog.assets(value),b=items.find(a=>a.role==='b');f.el('asset-select').value=b.assetId;f.el('asset-select').dispatchEvent('change');assert.match(f.el('asset-status').textContent,/다른 원문 버전/);
});

test('automatic registration exposes every collected source but the prepared prompt contains only the selected episode',async()=>{
 const values=[session(101),session(202),session(303)];for(const s of values)s.tracks.source=collected(s.media.videoId,s.tracks.source.cues).source;
 const f=await environment(values);assert.equal(f.calls.filter(c=>c.url?.endsWith('/jobs')&&c.options.method==='POST').length,3);
 assert.equal(f.runtime.filter(m=>m.action==='watchLibraryTranslation').length,0);assert(!f.calls.some(c=>c.clipboard||c.url?.endsWith('/start')||c.url?.endsWith('/batches')));
 const check=f.el('episode-list').children[1].children[0].children[0];check.checked=true;check.dispatchEvent('change');f.el('prepare-batch').dispatchEvent('click');await until(()=>f.stored.ottspeedLibrary?.lastBatchId);
 const prepared=f.calls.find(c=>c.url?.endsWith('/batches')&&c.options.method==='POST');assert.deepEqual(JSON.parse(prepared.options.body).jobIds,['job-202']);
 const receiving=f.runtime.filter(m=>m.action==='watchLibraryTranslation');assert.equal(receiving.length,1);assert.equal(receiving[0].selectResults,false);
 f.el('batch-copy').dispatchEvent('click');await until(()=>f.calls.some(c=>c.clipboard));const prompt=f.calls.find(c=>c.clipboard).clipboard;assert(prompt.includes('job-202'));assert(!prompt.includes('job-101')&&!prompt.includes('job-303'));
 for(const value of values){assert.deepEqual(f.map.get(value.mediaKey).tracks,value.tracks);assert.deepEqual(f.map.get(value.mediaKey).settings,value.settings);}
 assert(!f.calls.some(c=>c.url?.endsWith('/start')));
});

test('saved batches reopen by authenticated reads without launching execution or changing episode selections',async()=>{
 const f=await environment(),before=f.calls.length;f.el('batch-list').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('보관 묶음'));
 assert.equal(f.el('batch-history').children.length,2);assert.equal(f.el('batch-history').disabled,false);
 f.el('batch-history').value='historic-batch';f.el('batch-history').dispatchEvent('change');await until(()=>f.stored.ottspeedLibrary?.lastBatchId==='historic-batch');
 assert.match(f.el('batch-prompt').value,/historic-job/);assert.match(f.el('batch-status').textContent,/1개 번역 대기/);
 assert(f.runtime.every(m=>['getCollectionQueue','ensureLocalRuntime'].includes(m.action)));assert.equal(f.map.get('netflix:101').revision,'r-101');assert.equal(f.map.get('netflix:101').settings.activeTarget,'a');
 assert(!f.calls.some(c=>c.url?.endsWith('/start')));const reads=f.calls.slice(before).filter(c=>c.options?.method==='GET');assert.equal(reads.length,3);assert(reads.every(c=>c.options.headers.Authorization==='Bearer synthetic-token'));
});

test('configured official request disables duplicate clipboard submission after acceptance',async()=>{
 const f=await environment();f.bridgeState.ready=true;f.el('batch-list').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('보관 묶음'));
 f.el('batch-history').value='historic-batch';f.el('batch-history').dispatchEvent('change');await until(()=>f.stored.ottspeedLibrary?.lastBatchId==='historic-batch');
 assert.equal(f.el('batch-start').hidden,false);assert.equal(f.el('batch-start').disabled,false);
 f.el('batch-start').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('공식 실행 상태를 받았습니다'));
 assert.equal(f.el('batch-copy').disabled,true);assert.equal(f.el('batch-start').disabled,true);
 f.el('batch-copy').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('중복 번역'));assert(!f.calls.some(c=>c.clipboard));
 assert.equal(f.calls.filter(c=>c.url?.endsWith('/start')).length,1);
});

test('uncertain official submission stays locked across a null status read and never falls back to copying',async()=>{
 const f=await environment();f.bridgeState.ready=true;f.bridgeState.startFailure=true;
 f.el('batch-list').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('보관 묶음'));f.el('batch-history').value='historic-batch';f.el('batch-history').dispatchEvent('change');await until(()=>f.stored.ottspeedLibrary?.lastBatchId==='historic-batch');
 f.el('batch-start').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('접수 여부가 불명확'));
 assert.equal(f.el('batch-copy').disabled,true);assert.equal(f.el('batch-start').disabled,false);
 f.el('batch-copy').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('중복 번역'));assert.equal(f.el('batch-copy').disabled,true);assert(!f.calls.some(c=>c.clipboard));
 assert.match(f.el('batch-status').textContent,/uncertain/);
});

test('batch table shows per-episode prefix and chunk progress; receiving resumes without launch or A/B changes',async()=>{
 const value=session(202),f=await environment([value]);Object.assign(f.batches.get('historic-batch').entries[0],{cueCount:4,readyCueCount:2,chunkCount:2,savedChunkCount:1,readChunkCount:2,readyThroughMs:3000});
 f.el('batch-list').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('보관 묶음'));f.el('batch-history').value='historic-batch';f.el('batch-history').dispatchEvent('change');await until(()=>f.stored.ottspeedLibrary?.lastBatchId==='historic-batch');
 assert.match(f.el('batch-entries').textContent,/2\/4개/);assert.match(f.el('batch-entries').textContent,/1\/2개/);assert.match(f.el('batch-entries').textContent,/00:00:03.000/);assert.match(f.el('batch-entries').textContent,/부분 저장/);
 f.el('batch-resume').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('결과 수신을 재개'));
 assert.deepEqual(f.map.get(value.mediaKey).tracks,value.tracks);assert.deepEqual(f.map.get(value.mediaKey).settings,value.settings);
 assert.equal(f.runtime.at(-1).action,'watchLibraryTranslation');assert.equal(f.runtime.at(-1).selectResults,false);assert(f.map.get(value.mediaKey).bridgeSnapshots['historic-job']);assert(!f.calls.some(c=>c.clipboard||c.url?.endsWith('/start')));
});

test('batch receiving rejects changed fixed source before modifying any stored episode',async()=>{
 const f=await environment([session(202)]);f.el('batch-list').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('보관 묶음'));f.el('batch-history').value='historic-batch';f.el('batch-history').dispatchEvent('change');await until(()=>f.stored.ottspeedLibrary?.lastBatchId==='historic-batch');
 f.details.get('historic-job').sourceTrack.cues[0].text='Changed source without changing the frozen request.';f.el('batch-resume').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('스냅샷이 변경'));
 assert.equal(f.map.get('netflix:202').revision,'r-202');assert(f.runtime.every(m=>['getCollectionQueue','ensureLocalRuntime'].includes(m.action)));
});

test('collection UI registers explicit episode addresses and shows waiting, pause, cancel, and cached completion',async()=>{
 const f=await environment(),before=f.calls.length;f.el('collection-urls').value='123\n124';f.el('collection-enqueue').dispatchEvent('click');await until(()=>f.el('collection-entries').children.length===2&&f.el('collection-urls').value==='');
 assert.deepEqual(Array.from(f.runtime.find(m=>m.action==='enqueueCollection').urls),['123','124']);assert.match(f.el('collection-entries').textContent,/시청 탭 닫힘 대기/);assert.equal(f.calls.length,before);await tick();
 f.el('collection-pause').dispatchEvent('click');await until(()=>f.el('collection-status').textContent.includes('일시정지'));await tick();f.el('collection-resume').dispatchEvent('click');await until(()=>!f.el('collection-status').textContent.includes('일시정지'));await tick();
 f.el('collection-entries').children[0].children[4].children[0].dispatchEvent('click');await until(()=>f.el('collection-entries').children[0].textContent.includes('취소'));await tick();
 Object.assign(f.collection.entries[1],{status:'complete',cueCount:1831,cached:true,errorCode:null});f.el('collection-refresh').dispatchEvent('click');await until(()=>f.el('collection-entries').textContent.includes('1831개'));assert.match(f.el('collection-entries').textContent,/기존 원문 재사용/);
 assert.equal(f.map.get('netflix:101').settings.activeTarget,'a');assert(!f.runtime.some(m=>m.action==='prepareTranslationSource'));
});

test('paired library expands three saved episodes to 156 named archive entries and shows completed E06 without changing selected A/B',async()=>{
  const old=[session(101),session(202),session(303)];for(const s of old)s.catalog={title:'',season:null,episode:null};
  const entries=[];
  for(let i=0;i<156;i++){
    const id=i<3?[101,202,303][i]:1000+i,m=media(id),source=collected(id,track('A synthetic original line.').cues).source;
    const request=await core.makeTranslationRequest({media:m,source,reference:null,mode:'translate'}),translations=[];
    if(i===27){const response={...request.outputTemplate,cues:[{id:'one',text:'전편 합성 번역.'}]};translations.push({request,response,resultHash:await catalog.hash(response),name:'S02E06.gpt-6-astra.high.ko.B.vtt'});}
    entries.push({kind:'ottspeed.library-archive-episode',version:1,revision:`archive-${i}`,mediaKey:m.key,media:m,catalog:{title:'합성 작품',season:1+Math.floor(i/22),episode:1+i%22,episodeTitle:`합성 회차 ${i+1}`},sourceHash:request.sourceHash,sourceTrack:source,translations});
  }
  const f=await environment(old,{archive:entries,paired:true});
  for(let i=0;i<30&&f.map.size<156;i++)await new Promise(r=>setTimeout(r,10));
  await until(()=>f.el('notice').textContent.includes('156개 회차와 완료된 번역'));
  assert.equal(f.map.size,156);assert.match(f.el('library-count').textContent,/156개 회차/);assert(!f.el('episode-list').textContent.includes('작품 미지정'));
  for(const value of old){assert.deepEqual(f.map.get(value.mediaKey).tracks,value.tracks);assert.deepEqual(f.map.get(value.mediaKey).settings,value.settings);}
  f.el('search').value='S02E06';f.el('search').dispatchEvent('input');assert.equal(f.el('episode-list').children.length,1);assert.match(f.el('episode-list').textContent,/시즌 2 · 6화/);assert.match(f.el('episode-list').textContent,/완료/);assert.match(f.el('episode-list').textContent,/1\/1개/);
  const episode=f.map.get('netflix:1027');assert.equal(episode.tracks.b.cues[0].text,'전편 합성 번역.');assert.equal(episode.settings.activeTarget,'b');assert.equal((await catalog.summarize(episode)).bCount,1);
  const before=f.calls.filter(c=>c.url?.includes('/library/archive/')).length;
  f.el('refresh').dispatchEvent('click');await until(()=>f.el('notice').textContent.includes('저장된 자료를 새로'));
  assert.equal(f.calls.filter(c=>c.url?.includes('/library/archive/')).length,before);assert(f.runtime.every(m=>['getCollectionQueue','refreshLibrarySession','ensureLocalRuntime'].includes(m.action)));assert.equal(f.runtime.filter(m=>m.action==='refreshLibrarySession').length,1);
});
