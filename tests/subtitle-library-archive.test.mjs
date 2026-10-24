import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DOMParser} from '@xmldom/xmldom';
import {SubtitleLibraryArchive} from '../scripts/subtitle-library-archive.mjs';
import {createBridge} from '../scripts/translation-bridge-server.mjs';
import core from '../subtitles/core.js';
import netflix from '../subtitles/netflix.js';
import catalog from '../subtitles/catalog.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'ottspeed-library-archive-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'series-capture','west-wing'),run=join(root,'chatgpt-plan','episode-runs','synthetic');await mkdir(home,{recursive:true});await mkdir(run,{recursive:true});
  const media=core.mediaIdentity('https://www.netflix.com/watch/123'),rawText='WEBVTT\n\none\n00:00:01.000 --> 00:00:03.000\nA synthetic sentence.\n';
  const parsed=netflix.parseAsset(rawText,core,DOMParser),resourceSha256=createHash('sha256').update(rawText).digest('hex');
  const track={name:'synthetic.vtt',language:'en',format:'vtt',provenance:'netflix-manifest-resource',sync:{offsetMs:0,scale:1},cues:parsed.cues,
    capture:{mediaKey:media.key,videoId:'123',fullEpisode:true,coverage:'complete',track:{language:'en',profile:'webvtt-lssdh-ios8',segmented:false},audit:parsed.audit,resourceSha256,resourceBytes:Buffer.byteLength(rawText),cueCount:1,startMs:1000,endMs:3000}};
  const request=await core.makeTranslationRequest({media,source:track,reference:null,mode:'translate'}),response={...request.outputTemplate,cues:[{id:'one',text:'합성 한국어 번역.'}]};
  const captureFile=join(home,'capture.json'),index={kind:'ottspeed.netflix-series-archive',version:1,status:'verified',series:'합성 작품',episodeCount:1,
    episodes:[{key:'S02E06',season:2,episode:6,title:'합성 회차 제목',videoId:'123',mediaKey:media.key,cueCount:1,resourceSha256,sourceHash:request.sourceHash,captureFile}]};
  const bVttPath=join(run,'B.vtt'),report={phase:'verified_whole_episode',translationStructureVerified:true,responseCompleted:true,mediaKey:media.key,sourceHash:request.sourceHash,responseSha256:digest(response),responseModel:'gpt-6-astra',responseReasoning:{effort:'high'},bVttPath};
  const save=(file,x)=>writeFile(file,JSON.stringify(x));
  await save(captureFile,{mediaKey:media.key,media,track,rawText});await save(join(home,'archive-index.json'),index);
  await save(join(run,'translation-request.json'),request);await save(join(run,'translation-response.json'),response);await save(join(run,'report.json'),report);await writeFile(bVttPath,core.serializeVtt(core.validateTranslationResponse(response,request).cues));
  return {root,home,run,index,track,request,response,media,captureFile,save,archive:new SubtitleLibraryArchive({privateRoot:root})};
}
test('verified local archive publishes episode metadata and complete model B without generating jobs',async t=>{
  const f=await fixture(t),index=await f.archive.list();assert.equal(index.episodeCount,1);assert.equal(index.episodes[0].catalog.episode,6);assert.equal(index.episodes[0].catalog.episodeTitle,'합성 회차 제목');assert.equal(index.episodes[0].translationCount,1);
  const entry=await f.archive.episode('123');assert.equal(entry.translations[0].model,'gpt-6-astra');assert.equal(entry.translations[0].response.cues.length,1);
  assert(!JSON.stringify(index).includes(f.root));assert(!JSON.stringify(entry).includes('rawText'));
  const session={mediaKey:f.media.key,media:f.media,catalog:{title:'',season:null,episode:null},tracks:{source:f.track,a:{...f.track,language:'ko'},b:null},settings:{activeTarget:'a',fontSize:56},revision:'existing'};
  const merged=await catalog.mergeArchive(session,entry);assert.equal(merged.catalog.title,'합성 작품');assert.equal(merged.catalog.episode,6);assert.deepEqual(merged.settings,session.settings);assert.deepEqual(merged.tracks,session.tracks);
  const row=await catalog.summarize(merged);assert.equal(row.state,'B 보관');assert.equal(row.readyCueCount,1);assert.equal(row.inspectionState,'현재 원문·요청·시각 일치');assert(catalog.matches(row,{query:'합성 회차 제목'}));
  const again=await catalog.mergeArchive(merged,entry);assert.equal(again.versions.length,merged.versions.length);assert.deepEqual(again.tracks,session.tracks);
  const empty=structuredClone(merged);empty.tracks.a=null;const selected=await catalog.selectReadyTranslation(empty);assert.equal(selected.changed,true);assert.equal(selected.session.settings.activeTarget,'b');assert.equal(selected.session.settings.fontSize,56);assert.equal(selected.session.tracks.b.cues[0].text,'합성 한국어 번역.');assert.equal(selected.session.pendingRequest.requestId,f.request.requestId);
  assert.equal((await catalog.selectReadyTranslation(selected.session)).changed,false);assert.equal((await catalog.selectReadyTranslation(merged)).changed,false);
  for(const settings of [{enabled:false},{display:'source'}]){const preserved=structuredClone(empty);Object.assign(preserved.settings,settings);assert.equal((await catalog.selectReadyTranslation(preserved)).changed,false);}
  const different=structuredClone(empty);different.tracks.source.cues[0].text='Another edition.';assert.equal((await catalog.selectReadyTranslation(different)).changed,false);
  const custom=structuredClone(session);custom.catalog={title:'직접 정한 작품명',season:9,episode:8};assert.equal((await catalog.mergeArchive(custom,entry)).catalog.title,custom.catalog.title);
  const bad=structuredClone(entry);bad.translations[0].response.cues[0].text='변조';await assert.rejects(catalog.mergeArchive(session,bad),/해시/);assert.deepEqual(session.tracks.b,null);
});
test('archive rejects tampered original, B mismatch and paths outside private storage',async t=>{
  const f=await fixture(t);await f.save(f.captureFile,{mediaKey:f.media.key,media:f.media,track:f.track,rawText:'tampered'});await assert.rejects(f.archive.episode('123'),/해시/);
  f.index.episodes[0].captureFile=join(f.root,'..','outside.json');await f.save(join(f.home,'archive-index.json'),f.index);await assert.rejects(f.archive.episode('123'));
  await assert.rejects(f.archive.episode('../123'),/Invalid/);
  const g=await fixture(t);await writeFile(join(g.run,'B.vtt'),'WEBVTT\n\none\n00:00:01.000 --> 00:00:03.000\n변조된 번역\n');await assert.rejects(g.archive.episode('123'));
  f.index.episodes[0].captureFile=g.captureFile;await f.save(join(f.home,'archive-index.json'),f.index);await assert.rejects(f.archive.episode('123'),/escaped/);
});
test('archive HTTP endpoint requires the existing extension pairing and does not expose private paths',async t=>{
  const f=await fixture(t),bridge=await createBridge({directory:join(f.root,'bridge'),port:0,libraryArchive:f.archive});t.after(()=>new Promise(r=>bridge.server.close(r)));
  const base=`http://127.0.0.1:${bridge.port}`,origin='chrome-extension://hegbpfhcjpghhhnmnjjedibpfblchefh';
  assert.equal((await fetch(base+'/extension/library/archive')).status,403);
  const paired=await(await fetch(base+'/extension/pair',{method:'POST',headers:{Origin:origin,'X-OTTSpeed-Client':'workspace','Content-Type':'application/json'},body:'{"client":"OTTSpeed"}'})).json();
  const headers={'X-OTTSpeed-Client':'workspace',Authorization:`Bearer ${paired.token}`};
  assert.equal((await fetch(base+'/extension/library/archive',{headers:{...headers,Origin:'https://other.example'}})).status,403);
  const result=await(await fetch(base+'/extension/library/archive',{headers})).json();assert.equal(result.episodeCount,1);
  const entry=await(await fetch(base+'/extension/library/archive/123',{headers})).json();assert.equal(entry.catalog.season,2);assert.equal(entry.translations.length,1);
});
