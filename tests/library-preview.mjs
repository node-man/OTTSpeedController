/* Isolated localhost UI preview with original synthetic data and real IndexedDB. */
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('.'),allowed=new Set(['subtitles/core.js','subtitles/catalog.js','subtitles/library.js','subtitles/translation-prompt.js','subtitles/bridge-client.js','subtitles/library-page.js','subtitles/workspace.css','subtitles/library.css','icons/icon-48.png']);
const fixture=String.raw`
const previewCollection={version:1,paused:false,entries:[{id:'synthetic-done',videoId:'101',status:'complete',cueCount:2,cached:true},{id:'synthetic-wait',videoId:'202',status:'waiting_for_viewer',errorCode:'netflix_tab_open'}]};
window.chrome={storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{sendMessage:async message=>{
 if(message.action==='getCollectionQueue')return structuredClone(previewCollection);
 if(message.action==='enqueueCollection'){for(const value of message.urls)previewCollection.entries.push({id:crypto.randomUUID(),videoId:value,status:'queued'});return structuredClone(previewCollection);}
 if(message.action==='pauseCollection'||message.action==='resumeCollection'){previewCollection.paused=message.action==='pauseCollection';return structuredClone(previewCollection);}
 if(message.action==='cancelCollection'){previewCollection.entries.find(e=>e.id===message.id).status='cancelled';return structuredClone(previewCollection);}
 return {saved:true};
}}};
const originalFetch=window.fetch.bind(window),previewJobs=new Map();let previewBatch=null;
window.fetch=(url,...rest)=>{
 if(!String(url).startsWith('http://127.0.0.1:43127/'))return originalFetch(url,...rest);
 const path=new URL(url).pathname;let value;
 if(path==='/extension/pair')value={token:'synthetic-preview-pairing-not-a-real-credential'};
 else if(path==='/extension/execution')value={ready:false};
 else if(path==='/extension/batches')value={batches:previewBatch?[previewBatch]:[]};
 else if(path==='/extension/batches/preview-batch')value=previewBatch;
 else if(path.startsWith('/extension/jobs/'))value=previewJobs.get(path.split('/').at(-1));
 if(!value)return Promise.reject(new TypeError('Synthetic preview route unavailable. No production request sent.'));
 return Promise.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}));
};
const synthetic=id=>({mediaKey:'netflix:'+id,media:{key:'netflix:'+id,platform:'netflix',videoId:String(id),url:'https://www.netflix.com/watch/'+id},catalog:{title:'합성 드라마 · UI 검사',season:2,episode:id===101?3:4},tracks:{source:{name:'original.synthetic.en.vtt',language:'en',format:'vtt',cues:[{id:'one',startMs:1000,endMs:2400,text:'We should read every page before deciding.'},{id:'two',startMs:2500,endMs:4000,text:'Then let us begin.'}],sync:{offsetMs:0,scale:1}},a:{name:'original.synthetic.ko.A.vtt',language:'ko',format:'vtt',cues:[{id:'a-1',startMs:1000,endMs:2400,text:'결정하기 전에 전부 읽어야죠.'}],sync:{offsetMs:0,scale:1}},b:{name:'translated.synthetic.ko.B.vtt',language:'ko',format:'vtt',cues:[{id:'one',startMs:1000,endMs:2400,text:'모든 내용을 읽고 결정해야 합니다.'},{id:'two',startMs:2500,endMs:4000,text:'그럼 시작하죠.'}],sync:{offsetMs:0,scale:1}}},settings:{enabled:true,activeTarget:'b',display:'bilingual',fontSize:56,offsetMs:0,scale:1,bottomPercent:10,hideNative:false},revision:0});
(async()=>{
 for(const id of [101,202])if(!await OTTSubtitleLibrary.get('netflix:'+id)){
  const value=synthetic(id);value.pendingRequest=await OTTSubtitles.makeTranslationRequest({media:value.media,source:value.tracks.source});value.tracks.b.requestId=value.pendingRequest.requestId;
  if(id===202)value.tracks.source.cues[0].text='A revised original, intentionally different from this translation request.';
  await OTTSubtitleLibrary.put(value);
 }
 const entries=[];for(const id of [101,202]){const value=await OTTSubtitleLibrary.get('netflix:'+id),request=value.pendingRequest,jobId=request.requestId;
  const sourceTrack={...structuredClone(value.tracks.source),cues:structuredClone(request.source.cues),capture:{fullEpisode:true,mediaKey:value.mediaKey,resourceSha256:'a'.repeat(64)},sync:{offsetMs:0,scale:1}};
  previewJobs.set(jobId,{jobId,media:value.media,mediaKey:value.mediaKey,sourceHash:request.sourceHash,request,sourceTrack});
  entries.push({jobId,sourceHash:request.sourceHash,mediaKey:value.mediaKey,status:id===101?'translating':'complete',cueCount:2,readyCueCount:id===101?1:2,chunkCount:2,savedChunkCount:id===101?1:2,readChunkCount:2,readyThroughMs:id===101?2500:4000});
 }
 previewBatch={batchId:'preview-batch',createdAt:'2026-10-24T00:00:00Z',entries,completedCount:1,pendingCount:1,blockedCount:0,status:'translating'};
 const script=document.createElement('script');script.src='/subtitles/library-page.js';document.body.appendChild(script);
 document.getElementById('storage-proof').addEventListener('click',async()=>{
  const out=document.getElementById('storage-proof-result');out.textContent='실제 IndexedDB 검사 중';const key='netflix:999990001';
  try{
   let previous=await OTTSubtitleLibrary.get(key);if(previous)await OTTSubtitleLibrary.remove(key,previous.revision);
   const initial=await OTTSubtitleLibrary.put(synthetic(999990001)),stale=structuredClone(initial),edited=structuredClone(initial);
   edited.tracks.a.cues[0].text='새 합성 문안';const saved=await OTTSubtitleLibrary.put(edited);
   if(!saved.versions.some(v=>v.track.cues[0].text==='결정하기 전에 전부 읽어야죠.'))throw new Error('History was lost');
   let rejected=false;try{await OTTSubtitleLibrary.put(stale);}catch(error){rejected=error.name==='ConflictError';}if(!rejected)throw new Error('Stale write accepted');
   const backup=await OTTSubtitleCatalog.createBackup([saved]),restored=await OTTSubtitleCatalog.readBackup(JSON.stringify(backup));
   const outcome=await OTTSubtitleLibrary.restore(restored);if(outcome.skipped!==1||outcome.inserted!==0)throw new Error('Restore overwrote an existing episode');
   if((await OTTSubtitleLibrary.get(key)).tracks.a.cues[0].text!=='새 합성 문안')throw new Error('Existing A changed');
   const corrupt=structuredClone(backup);corrupt.sha256='0'.repeat(64);rejected=false;try{await OTTSubtitleCatalog.readBackup(corrupt);}catch{rejected=true;}if(!rejected)throw new Error('Corrupt backup accepted');
   await OTTSubtitleLibrary.remove(key,saved.revision);out.textContent='PASS · 실제 IndexedDB 저장·이전 버전 보존·오래된 쓰기 거부·기존 회차 복원 보호·손상 백업 거부';
  }catch(error){out.textContent='FAIL · '+error.message;}
 });
})();`;
const server=http.createServer(async(req,res)=>{
 try {
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'");res.setHeader('Cache-Control','no-store');
  if(path==='/fixture.js'){res.setHeader('Content-Type','text/javascript;charset=utf-8');return res.end(fixture);}
  if(path==='/subtitles/library.html'){
   const html=(await readFile(join(root,'subtitles/library.html'),'utf8')).replace('<main>','<main><section class="notice"><strong>합성 자료 전용 UI 검사 · 실제 계정/자막 미사용</strong><p>독립 localhost 저장소이며 Chrome 확장 저장소와 연결하지 않습니다.</p><button id="storage-proof" class="secondary">실제 저장소 회귀 검사</button><p id="storage-proof-result" role="status"></p></section>').replace('<script src="library-page.js"></script>','<script src="/fixture.js"></script>');
   res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(html);
  }
  const file=path.slice(1);if(!allowed.has(file)){res.statusCode=404;return res.end('Not found');}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript;charset=utf-8':file.endsWith('.css')?'text/css;charset=utf-8':'image/png');res.end(await readFile(join(root,file)));
 }catch{res.statusCode=500;res.end('Preview unavailable');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const info={pid:process.pid,url:`http://127.0.0.1:${server.address().port}/subtitles/library.html`,syntheticOnly:true};
await mkdir(join(root,'private-subtitles/bridge'),{recursive:true});await writeFile(join(root,'private-subtitles/bridge/library-preview.json'),JSON.stringify(info,null,2)+'\n');console.log(JSON.stringify(info));
process.stdin.on('data',data=>{if(data.toString().includes('stop'))server.close(()=>process.exit(0));});
