// Original synthetic captions only. No browser profile or real subtitle mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../subtitles/catalog.js';
import core from '../subtitles/core.js';
const media=core.mediaIdentity('https://www.netflix.com/watch/101');
const track=(text='An original synthetic line.',language='en')=>({name:`test.${language}.vtt`,language,format:'vtt',cues:[{id:'one',startMs:1000,endMs:2000,text}],sync:{offsetMs:0,scale:1}});
const session=()=>({mediaKey:media.key,media,tracks:{source:track(),a:track('기준 합성 자막.','ko'),b:null},settings:{enabled:true,fontSize:56,display:'bilingual'},revision:'old'});

test('catalogue records changed source/A/B versions, keeps prior history, and ignores display-only edits',async()=>{
 const old=session(),next=structuredClone(old);next.tracks.a=track('새 합성 문안.','ko');
 const saved=await catalog.prepareWrite(old,next);assert.equal(saved.versions.length,1);assert.equal(saved.versions[0].track.cues[0].text,'기준 합성 자막.');
 const edited=structuredClone(saved);edited.settings.fontSize=40;const stable=await catalog.prepareWrite(saved,edited);assert.equal(stable.versions.length,1);
 edited.tracks.source=track('A changed synthetic source.');const newer=await catalog.prepareWrite(saved,edited);assert.equal(newer.versions.length,2);
 const row=await catalog.summarize(newer);assert.equal(row.sourceCount,2);assert.equal(row.aCount,2);
});

test('one growing partial B is one version, and losing a current request preserves its link proof',async()=>{
 const old=session(),request=await core.makeTranslationRequest({media,source:old.tracks.source});
 old.pendingRequest=request;old.tracks.b={...track('합성 번역.','ko'),requestId:request.requestId,partial:true,totalCueCount:1,readyThroughMs:2000};
 const final=structuredClone(old);final.tracks.b.partial=false;assert.equal((await catalog.prepareWrite(old,final)).versions.length,0);
 const different=structuredClone(final);different.pendingRequest=null;
 const preserved=await catalog.prepareWrite(final,different);assert.equal(preserved.versions.length,1);
 const assets=await catalog.assets(preserved);assert.equal(catalog.connection(assets.find(a=>a.role==='b'&&a.current)),'요청·ID·시각 일치');
});

test('pairing is by request IDs and original times, never counts or filenames',async()=>{
 const value=session();value.tracks.b=track('합성 번역.','ko');value.tracks.b.name=value.tracks.source.name;
 let row=await catalog.summarize(value);assert.equal(catalog.connection(row.assets.find(a=>a.role==='b')),'연결 미확인');
 const request=await core.makeTranslationRequest({media,source:value.tracks.source});value.pendingRequest=request;value.tracks.b.requestId=request.requestId;
 row=await catalog.summarize(value);assert.equal(catalog.connection(row.assets.find(a=>a.role==='b')),'요청·ID·시각 일치');
 value.tracks.b.cues[0].startMs=1100;row=await catalog.summarize(value);assert.equal(catalog.connection(row.assets.find(a=>a.role==='b')),'연결 검사 실패');
});

test('portable backup validates all payload hashes, identities and requests and excludes credentials/execution selection',async()=>{
 const value=session();value.catalog={title:'합성 작품',season:2,episode:3};value.bridge={jobId:'not-restored',token:'secret-not-for-backup'};value.settings.token='secret-not-for-backup';value.pendingRequest=await core.makeTranslationRequest({media,source:value.tracks.source});
 const backup=await catalog.createBackup([value]),text=JSON.stringify(backup);assert(!text.includes('secret-not-for-backup'));
 const [restored]=await catalog.readBackup(text);assert.equal(restored.catalog.title,'합성 작품');assert.equal(restored.settings.fontSize,56);assert.equal(restored.bridge,undefined);assert.equal(restored.revision,0);assert.equal(restored.pendingRequest.sourceHash,value.pendingRequest.sourceHash);
 backup.payload.sessions[0].tracks.source.cues[0].text='Tampered.';await assert.rejects(()=>catalog.readBackup(backup),/해시/);
 const wrong=structuredClone(value);wrong.mediaKey='netflix:202';wrong.media={...wrong.media,key:'netflix:202'};await assert.rejects(()=>catalog.createBackup([wrong]),/주소/);
 await assert.rejects(()=>catalog.createBackup([value,value]),/중복/);
});

test('metadata filtering is explicit, supports unknown episodes, and rejects impossible season data',async()=>{
 const value=session();value.catalog={title:'합성 작품',season:2,episode:3};const row=await catalog.summarize(value);
 assert(catalog.matches(row,{query:'합성',season:'2',state:'번역 대기'}));assert(!catalog.matches(row,{season:'1'}));
 assert(catalog.matches(row,{query:'S02E03'}));assert(catalog.matches(row,{query:' s02e03 '}));assert(!catalog.matches(row,{query:'S02E04'}));
 assert.deepEqual(catalog.metadata(null),{title:'',season:null,episode:null});assert.throws(()=>catalog.metadata({season:-1}),/정수/);
 assert.throws(()=>catalog.metadata({episode:1.5}),/정수/);
});

test('inspection distinguishes a valid old-source translation from the current original and detects changed request hashes',async()=>{
 const value=session(),request=await core.makeTranslationRequest({media,source:value.tracks.source});
 value.pendingRequest=request;value.tracks.b={...track('원문에 연결한 합성 번역.','ko'),requestId:request.requestId};
 let row=await catalog.summarize(value);assert.equal(row.inspectionState,'현재 원문·요청·시각 일치');assert.equal(row.state,'B 보관');
 value.tracks.source=track('A newer synthetic original with unchanged cue IDs and times.');
 row=await catalog.summarize(value);assert.equal(row.inspectionState,'다른 원문 버전의 번역');assert.equal(row.state,'원문 변경');
 assert.equal(row.assets.find(a=>a.role==='b').inspection.requestHashVerified,true);
 value.pendingRequest.sourceHash='a'.repeat(64);row=await catalog.summarize(value);
 assert.equal(row.inspectionState,'연결 검사 실패');assert.equal(row.state,'검사 필요');
});

test('restored archived B retains original-source link checks without guessing from a current filename',async()=>{
 const value=session(),request=await core.makeTranslationRequest({media,source:value.tracks.source});
 value.tracks.b={...track('보관한 합성 번역.','ko'),requestId:request.requestId};value.pendingRequest=request;
 const changed=structuredClone(value);changed.tracks.source=track('Another original.');changed.pendingRequest=null;
 const archived=await catalog.prepareWrite(value,changed),backup=await catalog.createBackup([archived]);
 const [restored]=await catalog.readBackup(JSON.stringify(backup)),row=await catalog.summarize(restored);
 assert.equal(row.state,'원문 변경');assert.equal(row.inspectionState,'다른 원문 버전의 번역');
 assert.equal(restored.tracks.b.cues[0].text,'보관한 합성 번역.');
});
