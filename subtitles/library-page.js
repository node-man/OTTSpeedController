/* Library management has no dependency on a playback tab. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),catalog=OTTSubtitleCatalog,library=OTTSubtitleLibrary;
  const selected=new Set(),cache=new Map(),executionIntents=new Map();let rows=[],chosenKey=null,chosenAsset=null,busy=false,bridgeToken=null,batch=null,batchChoices=[],metadataDirty=false,executionReady=false,refreshing=false,archiveSyncing=false;
  const bridgeHttp=OTTDeckBridgeHttp({timeoutMs:20000,offlineMessage:'로컬 브리지에 연결하지 못했습니다. 저장된 자막은 계속 관리할 수 있습니다.'});
  const registration=OTTDeckMcpRegistration({core:OTTSubtitles,catalog,validation:OTTCaptureValidation,library,bridge,
    watch:async job=>{const reply=await chrome.runtime.sendMessage({action:'watchLibraryTranslation',jobId:job.jobId,mediaKey:job.mediaKey,selectResults:false});if(reply?.error)throw new Error(reply.error);}});
  const hasExecution=()=>batch?.execution?.mode==='workspace-agent';
  const stamp=ms=>{const n=Math.max(0,Math.floor(ms||0));return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')}.${String(n%1000).padStart(3,'0')}`;};
  const notice=(text,error=false)=>{$('notice').textContent=text;$('notice').classList.toggle('error',error);};
  const title=row=>row.catalog.title||'작품 미지정';
  const episode=row=>row.catalog.season&&row.catalog.episode?`시즌 ${row.catalog.season} · ${row.catalog.episode}화 · S${String(row.catalog.season).padStart(2,'0')}E${String(row.catalog.episode).padStart(2,'0')}`:'시즌·회차 미지정';
  const visible=()=>rows.filter(row=>catalog.matches(row,{query:$('search').value,season:$('season-filter').value,state:$('state-filter').value}));
  const append=(parent,tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;parent.appendChild(el);return el;};
  function clear(el){el.textContent='';}
  const collectionLabels={queued:'대기',opening:'수집 탭 여는 중',observing:'영어 manifest 대기',capturing:'원문 수집·검사 중',waiting_for_viewer:'Netflix 시청 탭 닫힘 대기',complete:'원문 보관 완료',needs_attention:'확인 필요',cancelled:'취소'};
  const collectionErrors={netflix_tab_open:'다른 Netflix 회차 탭이 열려 있습니다.',login_required:'Netflix 로그인이 필요합니다.',netflix_concurrent_stream:'Netflix M7020 동시 재생 오류',manifest_timeout:'제한 시간 내 영어 manifest를 확보하지 못했습니다.',capture_tab_taken_over:'사용자가 수집 탭을 선택하여 중단했습니다.',capture_tab_navigated:'수집 탭이 다른 페이지로 이동했습니다.',capture_tab_unidentified:'수집 탭의 소유 상태를 확인하지 못했습니다.',capture_tab_closed:'수집 탭이 닫혔습니다.',wrong_episode:'다른 회차 응답을 거부했습니다.',collection_failed:'원문 수집 또는 전편 검사에 실패했습니다.',cleanup_unverified:'탭 소유 상태를 확인할 수 없어 자동 닫기를 보류했습니다.'};
  function renderCollection(state){
    if(state?.version!==1||!Array.isArray(state.entries))throw new Error('수집 대기열에 연결하지 못했습니다. 저장된 자막은 계속 관리할 수 있습니다.');
    const done=state.entries.filter(e=>e.status==='complete').length;
    $('collection-status').textContent=`${state.paused?'일시정지 · ':''}${state.entries.length}개 회차 · ${done}개 원문 보관 완료`;
    clear($('collection-entries'));
    for(const entry of state.entries){const tr=append($('collection-entries'),'tr');append(tr,'td',entry.videoId);append(tr,'td',collectionLabels[entry.status]||'상태 확인 필요');append(tr,'td',entry.cueCount?`${entry.cueCount}개${entry.cached?' · 기존 원문 재사용':''}`:'아직 없음');append(tr,'td',collectionErrors[entry.errorCode]||'');const cell=append(tr,'td');if(!['complete','cancelled','needs_attention'].includes(entry.status)){const button=append(cell,'button','취소','quiet');button.addEventListener('click',()=>void collectionAction('cancelCollection',{id:entry.id}));}}
  }
  async function collectionRead(){const state=await chrome.runtime.sendMessage({action:'getCollectionQueue'});if(state?.error)throw new Error(state.error);renderCollection(state);}
  async function collectionAction(action,extra={}){await run(async()=>{const state=await chrome.runtime.sendMessage({action,...extra});if(state?.error)throw new Error(state.error);renderCollection(state);if(action==='enqueueCollection')$('collection-urls').value='';await refresh();});}
  function controls() {
    for(const el of document.querySelectorAll('button,input,select'))el.disabled=busy;
    $('backup-selected').disabled=busy||!selected.size;$('backup-all').disabled=busy||!rows.length;$('prepare-batch').disabled=busy||!selected.size;
    const unavailable=busy||!batch||batch.blockedCount>0||batch.status==='complete';
    $('batch-copy').disabled=unavailable||hasExecution();
    $('batch-resume').disabled=busy||!batch||batch.blockedCount>0;
    $('batch-start').hidden=!executionReady&&!hasExecution();
    $('batch-start').disabled=unavailable||!executionReady||(hasExecution()&&!batch.execution.retryable);
    $('batch-start').textContent=hasExecution()?'같은 공식 요청 재확인':'공식 자동 연결로 요청';
    $('execution-mode').textContent=hasExecution()?'공식 실행 기록이 있습니다. 중복 요청을 막기 위해 프롬프트 복사는 보류합니다.':executionReady?'공식 자동 연결이 설정돼 있습니다. 프롬프트 복사도 선택할 수 있습니다.':'기본 방식은 프롬프트 복사입니다. ChatGPT의 OTTSpeed 앱에 보내면 준비된 번역부터 받습니다.';
    if(hasExecution())$('batch-prompt').hidden=true;
    for(const id of ['export-vtt','export-srt','use-version'])$(id).disabled=busy||!chosenAsset;
    $('batch-history').disabled=busy||!batchChoices.length;
    $('selected-count').textContent=`${selected.size}개 회차 선택`;
  }
  function renderRows() {
    clear($('episode-list'));const filtered=visible();$('empty-state').hidden=filtered.length!==0;$('library-count').textContent=`${rows.length}개 회차 보관 · ${filtered.length}개 표시`;
    for(const row of filtered) {
      const tr=append($('episode-list'),'tr');const check=append(append(tr,'td'),'input');check.type='checkbox';check.checked=selected.has(row.mediaKey);check.setAttribute('aria-label',`${title(row)} ${episode(row)} 선택`);
      check.addEventListener('change',()=>{if(check.checked)selected.add(row.mediaKey);else selected.delete(row.mediaKey);controls();});
      const name=append(tr,'td',title(row));append(name,'small',episode(row));if(row.catalog.episodeTitle)append(name,'small',row.catalog.episodeTitle);append(name,'small',row.mediaKey);
      append(tr,'td',`${row.sourceCount}개 버전`);append(tr,'td',`A ${row.aCount} / B ${row.bCount}`);
      const state=append(tr,'td',row.state);if(row.readyCueCount)append(state,'small',`${row.readyCueCount}/${row.totalCueCount}개${row.readyThroughMs?' · '+stamp(row.readyThroughMs)+'까지':''}`);
      append(tr,'td',row.inspectionState);
      const open=append(append(tr,'td'),'button','열기','quiet');open.addEventListener('click',()=>{chosenKey=row.mediaKey;metadataDirty=false;chosenAsset=null;renderDetail();});
      const registered=append(tr,'td',row.mcpState);if(row.mcpJobId)append(registered,'small',row.mcpJobId);
    }controls();
  }
  function renderDetail() {
    const row=rows.find(r=>r.mediaKey===chosenKey);$('detail').hidden=!row;if(!row)return;
    $('detail-heading').textContent=`${title(row)} · ${episode(row)}${row.catalog.episodeTitle?' · '+row.catalog.episodeTitle:''}`;$('detail-identity').textContent=row.mediaKey;
    if(!metadataDirty){$('title').value=row.catalog.title;$('season').value=row.catalog.season||'';$('episode').value=row.catalog.episode||'';}
    const previous=chosenAsset?.assetId;clear($('asset-select'));
    for(const item of row.assets){const option=append($('asset-select'),'option',`${item.role==='source'?'EN':item.role.toUpperCase()} · ${item.current?'현재':'보관'} · ${item.track.name} · ${item.track.cues.length}개${item.track.partial?' · 번역 중':''}`);option.value=item.assetId;}
    chosenAsset=row.assets.find(a=>a.assetId===previous)||row.assets.find(a=>a.current)||row.assets[0]||null;
    $('asset-select').value=chosenAsset?.assetId||'';renderPreview();controls();
  }
  function renderPreview() {
    clear($('cue-preview'));const item=chosenAsset;if(!item){$('asset-status').textContent='보관한 자막이 없습니다.';$('preview-count').textContent='';return;}
    $('asset-status').textContent=`${item.inspection?.state||catalog.connection(item)} · ${item.hash.slice(0,12)} · ${item.track.partial?'부분 번역':'저장된 자막'}${item.track.timingVerified?' · 재생 확인 기록 있음':' · 실제 싱크 확인 별도'}`;
    const q=$('cue-search').value.toLocaleLowerCase(),cues=item.track.cues.filter(c=>!q||`${c.id} ${c.text}`.toLocaleLowerCase().includes(q));
    $('preview-count').textContent=`검색 결과 ${cues.length}개 · 앞 60개 미리보기`;
    for(const cue of cues.slice(0,60)){const el=append($('cue-preview'),'div',undefined,'cue-entry');append(el,'small',`${cue.id} · ${stamp(cue.startMs)} → ${stamp(cue.endMs)}`);append(el,'p',cue.text);}
  }
  async function refresh() {
    const sessions=await library.list(),keys=new Set(sessions.map(s=>s.mediaKey));rows=[];
    for(const session of sessions){const cached=cache.get(session.mediaKey);if(!cached||cached.revision!==session.revision)cache.set(session.mediaKey,{revision:session.revision,row:await catalog.summarize(session)});rows.push(cache.get(session.mediaKey).row);}
    rows.sort((a,b)=>title(a).localeCompare(title(b))||(a.catalog.season||10000)-(b.catalog.season||10000)||(a.catalog.episode||10000)-(b.catalog.episode||10000)||a.mediaKey.localeCompare(b.mediaKey));
    for(const key of selected)if(!keys.has(key))selected.delete(key);for(const key of cache.keys())if(!keys.has(key))cache.delete(key);
    const season=$('season-filter').value;clear($('season-filter'));append($('season-filter'),'option','전체 시즌').value='';
    for(const n of [...new Set(rows.map(r=>r.catalog.season).filter(Boolean))].sort((a,b)=>a-b))append($('season-filter'),'option',`${n}시즌`).value=String(n);
    $('season-filter').value=season;renderRows();renderDetail();
  }
  async function run(task){if(busy)return;busy=true;controls();try{await task();}catch(error){notice(error.message,true);}finally{busy=false;controls();}}
  $('collection-enqueue').addEventListener('click',()=>{const urls=$('collection-urls').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);void collectionAction('enqueueCollection',{urls});});
  $('collection-pause').addEventListener('click',()=>void collectionAction('pauseCollection'));
  $('collection-resume').addEventListener('click',()=>void collectionAction('resumeCollection'));
  $('collection-refresh').addEventListener('click',()=>void run(collectionRead));
  function download(name,value,type='application/json;charset=utf-8') {
    const blob=new Blob([value],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function bridge(path,body,pair=false) { return bridgeHttp('/extension'+path,{body,token:pair?null:bridgeToken}); }
  async function checkExecution(){try{executionReady=(await bridge('/execution')).ready===true;}catch{executionReady=false;}controls();}
  async function ensureRuntime(){const state=await chrome.runtime.sendMessage({action:'ensureLocalRuntime'});if(!state?.ready)throw new Error(state?.error||'로컬 번역 연결을 시작하지 못했습니다.');}
  async function pair(){await ensureRuntime();const value=await bridge('/pair',{client:'OTTSpeed'},true);bridgeToken=value.token;await chrome.storage.local.set({ottspeedBridge:{token:bridgeToken}});await checkExecution();}
  async function syncArchive() {
    if(archiveSyncing)return 0;archiveSyncing=true;let imported=0;
    try {
      if(!bridgeToken)await pair();
      const index=await bridge('/library/archive');if(index.kind!=='ottspeed.library-archive-index'||index.version!==1||!Array.isArray(index.episodes))throw new Error('브리지를 최신 버전으로 다시 실행해야 합니다.');
      for(const item of index.episodes){
        const existing=await library.get(item.mediaKey);if(existing?.archiveImport?.revision===item.revision)continue;
        notice(`수집 보관소 연결 중 · ${imported}/${index.episodeCount}개 · ${item.catalog.title} S${item.catalog.season}E${item.catalog.episode}`);
        const entry=await bridge(`/library/archive/${item.videoId}`);
        if(entry.mediaKey!==item.mediaKey||entry.revision!==item.revision)throw new Error('보관소 목록과 회차 버전이 다릅니다. 다시 불러오세요.');
        for(let attempt=0;attempt<3;attempt++){
          const latest=await library.get(item.mediaKey)||OTTBridgeClient.emptySession(entry.media);
          const candidate=await catalog.mergeArchive(latest,entry);
          try{await library.put(candidate);break;}catch(error){if(error.name!=='ConflictError'||attempt===2)throw error;}
        }
        imported++;if(imported%20===0)await refresh();
      }
      // Also migrate entries imported by older versions with an archived B but
      // an empty selected A. A matching completed translation needs no reimport.
      let activated=0;
      for(const value of await library.list()){
        if(!value.archiveImport)continue;
        for(let attempt=0;attempt<3;attempt++){
          const latest=await library.get(value.mediaKey);if(!latest)break;const result=await catalog.selectReadyTranslation(latest);if(!result.changed)break;
          try{await library.put(result.session);activated++;try{await chrome.runtime.sendMessage({action:'refreshLibrarySession',mediaKey:value.mediaKey});}catch{}break;}
          catch(error){if(error.name!=='ConflictError'||attempt===2)throw error;}
        }
      }
      await registration.sync();await refresh();return imported;
    }finally{archiveSyncing=false;}
  }
  async function readBatch(id){const value=await bridge(`/batches/${id}`);if(value.execution||value.status==='complete')executionIntents.delete(id);else if(executionIntents.has(id))value.execution=executionIntents.get(id);return value;}
  function renderBatchChoices() {
    clear($('batch-history'));append($('batch-history'),'option','보관한 묶음을 선택하세요').value='';
    for(const value of batchChoices){const label=`${value.createdAt?.slice(0,16).replace('T',' ')||'시각 미확인'} · ${value.entries.length}개 회차 · ${value.status==='complete'?'전편 완료':value.status==='blocked'?'검사 필요':`${value.completedCount}개 완료 / ${value.pendingCount}개 대기`} · ${value.batchId.slice(0,8)}`;append($('batch-history'),'option',label).value=value.batchId;}
    $('batch-history').value=batch?.batchId||'';
  }
  function renderBatch(){if(!batch)return;if(!batchChoices.some(b=>b.batchId===batch.batchId))batchChoices.unshift(batch);else batchChoices=batchChoices.map(b=>b.batchId===batch.batchId?batch:b);renderBatchChoices();$('batch-prompt').value=OTTTranslationPrompt.buildBatch(batch);$('batch-status').textContent=`${batch.entries.length}개 회차 · ${batch.completedCount}개 전편 완료 · ${batch.pendingCount}개 번역 대기${batch.blockedCount?' · '+batch.blockedCount+'개 원문 확인 필요':''}${batch.execution?' · 공식 실행 '+batch.execution.state:''}`;
    clear($('batch-entries'));
    for(const entry of batch.entries){const row=rows.find(r=>r.mediaKey===entry.mediaKey),tr=append($('batch-entries'),'tr');append(tr,'td',row?`${title(row)} · ${episode(row)}`:entry.episode||entry.mediaKey);append(tr,'td',`${entry.readyCueCount||0}/${entry.cueCount||0}개`);append(tr,'td',`${entry.savedChunkCount||0}/${entry.chunkCount||0}개`);append(tr,'td',entry.readyThroughMs?stamp(entry.readyThroughMs):'아직 없음');append(tr,'td',entry.status==='complete'?'전편 확정':entry.status==='blocked'?'원문 확인 필요':entry.savedChunkCount?'부분 저장':entry.readChunkCount?'원문 읽음':'요청 전달 대기');}
    controls();
  }
  $('batch-resume').addEventListener('click',()=>void run(async()=>{
    if(!batch)return;await pair();const current=await readBatch(batch.batchId);if(current.blockedCount)throw new Error('묶음의 원문을 먼저 확인해야 합니다.');
    const details=[];for(const entry of current.entries){const detail=await bridge(`/jobs/${entry.jobId}`);await OTTBridgeClient.validateJob(detail);if(detail.mediaKey!==entry.mediaKey||detail.sourceHash!==entry.sourceHash)throw new Error('묶음의 고정 원문과 결과 수신 대상이 다릅니다.');details.push(detail);}
    for(const detail of details){const saved=await library.get(detail.mediaKey)||OTTBridgeClient.emptySession(detail.media);saved.bridgeSnapshots||={};saved.bridgeSnapshots[detail.jobId]={source:detail.sourceTrack,request:detail.request};if(!saved.tracks.source)saved.tracks.source=detail.sourceTrack;await library.put(saved);const reply=await chrome.runtime.sendMessage({action:'watchLibraryTranslation',jobId:detail.jobId,mediaKey:detail.mediaKey,selectResults:false});if(!reply||reply.error)throw new Error(reply?.error||'결과 수신을 재개하지 못했습니다.');}
    batch=current;await refresh();renderBatch();notice(`${details.length}개 회차의 결과 수신을 재개했습니다. 현재 A/B 선택과 재생은 유지했습니다.`);
  }));
  $('batch-list').addEventListener('click',()=>void run(async()=>{await pair();const result=await bridge('/batches');batchChoices=result.batches.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));renderBatchChoices();notice(`${batchChoices.length}개 보관 묶음을 불러왔습니다. 묶음을 선택하면 진행 상태를 확인할 수 있습니다.`);}));
  $('batch-history').addEventListener('change',()=>void run(async()=>{const id=$('batch-history').value;if(!id)return;const value=await readBatch(id);batch=value;await chrome.storage.local.set({ottspeedLibrary:{lastBatchId:id}});renderBatch();notice('보관한 묶음의 진행 상태를 불러왔습니다. 원문과 자막 선택은 유지했습니다.');}));
  $('refresh').addEventListener('click',()=>void run(async()=>{await refresh();try{const n=await syncArchive();notice(`저장된 자료를 새로 불러왔습니다.${n?' 보관소 '+n+'개 회차를 연결했습니다.':''}`);}catch(error){notice(`브라우저 보관 자료는 표시했습니다. ${error.message}`,true);}}));
  for(const id of ['search','season-filter','state-filter'])$(id).addEventListener(id==='search'?'input':'change',renderRows);
  $('select-visible').addEventListener('click',()=>{for(const r of visible())selected.add(r.mediaKey);renderRows();});
  $('clear-selection').addEventListener('click',()=>{selected.clear();renderRows();});
  for(const id of ['title','season','episode'])$(id).addEventListener('input',()=>{metadataDirty=true;});
  $('save-metadata').addEventListener('click',()=>void run(async()=>{const session=await library.get(chosenKey);if(!session)throw new Error('회차를 다시 선택하세요.');session.catalog=catalog.metadata({...session.catalog,title:$('title').value,season:$('season').value,episode:$('episode').value});await library.put(session);metadataDirty=false;await refresh();notice('작품·회차 정보를 저장했습니다.');}));
  $('asset-select').addEventListener('change',()=>{chosenAsset=rows.find(r=>r.mediaKey===chosenKey)?.assets.find(a=>a.assetId===$('asset-select').value)||null;renderPreview();controls();});
  $('cue-search').addEventListener('input',renderPreview);
  $('compare').addEventListener('click',()=>{
    const row=rows.find(r=>r.mediaKey===chosenKey),time=Number($('compare-time').value);if(!row||!Number.isFinite(time)||time<0)return;
    $('comparison').textContent=['source','a','b'].map(role=>{const item=chosenAsset?.role===role?chosenAsset:row.assets.find(a=>a.role===role&&a.current)||row.assets.find(a=>a.role===role);const cues=item?OTTSubtitles.activeCues(OTTSubtitles.createIndex(item.track.cues),time*1000):[];return `${role==='source'?'EN':role.toUpperCase()}\n${cues.map(c=>c.text).join('\n')||'(이 시각 자막 없음)'}`;}).join('\n\n');
  });
  $('use-version').addEventListener('click',()=>void run(async()=>{if(!chosenAsset)return;const item=chosenAsset,session=await library.get(chosenKey);if(!session)throw new Error('회차가 없어졌습니다.');session.tracks[item.role]=structuredClone(item.track);if(item.role==='source')session.pendingRequest=null;else{if(item.request)session.pendingRequest=structuredClone(item.request);Object.assign(session.settings,{activeTarget:item.role,enabled:true,display:session.settings.display==='bilingual'?'bilingual':'target',hideNative:true});}if(session.bridge)session.bridge.suspended=true;await library.put(session);try{await chrome.runtime.sendMessage({action:'refreshLibrarySession',mediaKey:chosenKey});}catch{}await refresh();notice('선택한 버전을 저장하고 해당 영상에 전달했습니다. 이전 버전은 보관됩니다.');}));
  for(const format of ['vtt','srt'])$('export-'+format).addEventListener('click',()=>void run(async()=>{if(!chosenAsset)return;const output=format==='vtt'?OTTSubtitles.serializeVtt(chosenAsset.track.cues):OTTSubtitles.serializeSrt(chosenAsset.track.cues);const name=`${chosenKey}_${chosenAsset.role}_${chosenAsset.hash.slice(0,8)}.${format}`.replace(/[<>:"/\\|?*]/g,'_');download(name,output,format==='vtt'?'text/vtt;charset=utf-8':'application/x-subrip;charset=utf-8');notice(format==='vtt'?'원래 ID와 시각의 VTT를 저장했습니다.':'원래 시각의 SRT를 저장했습니다. SRT 순번은 다시 매깁니다.');}));
  async function backup(onlySelected){const sessions=await library.list(),chosen=onlySelected?sessions.filter(s=>selected.has(s.mediaKey)):sessions;if(!chosen.length)throw new Error('백업할 회차를 선택하세요.');const value=await catalog.createBackup(chosen);download('OTTSpeed_subtitle-library.backup.json',JSON.stringify(value,null,2));notice(`${chosen.length}개 회차의 자막·이전 버전을 백업했습니다.`);}
  $('backup-selected').addEventListener('click',()=>void run(()=>backup(true)));$('backup-all').addEventListener('click',()=>void run(()=>backup(false)));
  $('restore-file').addEventListener('change',()=>void run(async()=>{const file=$('restore-file').files?.[0];if(!file)return;if(file.size>catalog.limits.maxBackupBytes)throw new Error('백업이 100 MB를 초과합니다.');const sessions=await catalog.readBackup(await file.text()),result=await library.restore(sessions);await refresh();notice(`${result.inserted}개 회차 복원 · 기존 ${result.skipped}개 회차는 보존했습니다.`);$('restore-file').value='';}));
  $('bridge-connect').addEventListener('click',()=>void run(async()=>{
    await pair();const archived=await syncArchive();const {jobs}=await bridge('/jobs');let imported=0,unlinked=0;
    for(const job of jobs){notice(`브리지 자막 정리 중 · ${imported}/${jobs.length}`);const detail=await bridge(`/jobs/${job.jobId}`);
      try{await OTTBridgeClient.validateJob(detail);}catch{unlinked++;continue;}
      const session=await library.get(detail.mediaKey)||OTTBridgeClient.emptySession(detail.media);session.bridgeSnapshots||={};session.bridgeSnapshots[detail.jobId]={source:detail.sourceTrack,request:detail.request};
      if(!session.tracks.source){session.tracks.source=detail.sourceTrack;session.pendingRequest=detail.request;}
      if((!session.catalog?.season||!session.catalog?.episode)&&/^S\d+E\d+$/.test(detail.episode||'')){const parts=/^S(\d+)E(\d+)$/.exec(detail.episode);session.catalog=catalog.metadata({...session.catalog,season:session.catalog?.season||parts[1],episode:session.catalog?.episode||parts[2]});}
      await library.put(session);if(detail.progress||detail.status==='complete')await OTTBridgeClient.receive(detail,false,library);imported++;
    }await refresh();notice(`보관소 ${archived}개 회차와 ${imported}개 작업의 원문·번역을 가져왔습니다.${unlinked?' 과거 작업 '+unlinked+'개는 연결 재검사가 필요해 기존 자료를 유지했습니다.':''} 현재 선택한 자막은 유지했습니다.`);
  }));
  $('prepare-batch').addEventListener('click',()=>void run(async()=>{
    const sessions=await Promise.all([...selected].map(key=>library.get(key)));if(!sessions.length)throw new Error('회차를 선택하세요.');
    for(const session of sessions)if(session?.tracks.source?.provenance!=='netflix-manifest-resource'||!session.tracks.source.capture?.fullEpisode)throw new Error(`${session?.mediaKey||'선택 회차'}의 검증된 Netflix 영어 원문이 없습니다.`);
    if(sessions.length>1&&sessions.some(s=>!s.catalog?.season||!s.catalog?.episode))throw new Error('여러 회차를 순서대로 준비하려면 시즌·회차 정보가 필요합니다. 원문과 기존 자막은 그대로 보관됩니다.');
    sessions.sort((a,b)=>(a.catalog?.season||0)-(b.catalog?.season||0)||(a.catalog?.episode||0)-(b.catalog?.episode||0)||a.mediaKey.localeCompare(b.mediaKey));
    await pair();const jobIds=[];
    await registration.sync({force:true});
    for(const session of sessions){const latest=await library.get(session.mediaKey),linked=latest?.mcpRegistration;if(!linked?.jobId||linked.sourceFingerprint!==await catalog.sourceFingerprint(latest.tracks.source))throw new Error('선택 회차의 MCP 등록을 먼저 확인하세요.');jobIds.push(linked.jobId);const reply=await chrome.runtime.sendMessage({action:'watchLibraryTranslation',jobId:linked.jobId,mediaKey:session.mediaKey,selectResults:false});if(reply?.error)throw new Error(reply.error);}
    const prepared=await bridge('/batches',{jobIds});batch=await readBatch(prepared.batchId);await chrome.storage.local.set({ottspeedLibrary:{lastBatchId:batch.batchId}});renderBatch();notice('선택 회차의 고정 작업 묶음을 준비했습니다. 원문과 A는 보존됩니다.');
  }));
  $('batch-copy').addEventListener('click',()=>void run(async()=>{
    if(!batch)return;batch=await readBatch(batch.batchId);renderBatch();
    if(hasExecution())throw new Error('공식 실행 기록이 있어 중복 번역 요청의 복사를 보류했습니다.');
    if(batch.blockedCount||batch.status==='complete')throw new Error(batch.blockedCount?'묶음의 원문을 확인해야 합니다.':'이 묶음의 번역은 이미 전편 확정됐습니다.');
    try{await navigator.clipboard.writeText($('batch-prompt').value);notice('묶음 프롬프트를 복사했습니다. ChatGPT의 OTTSpeed 앱에 보내세요.');}catch{$('batch-prompt').hidden=false;throw new Error('복사하지 못했습니다. 표시된 프롬프트를 직접 복사할 수 있습니다.');}
  }));
  $('batch-start').addEventListener('click',()=>void run(async()=>{
    if(!batch||!executionReady)return;
    batch=await readBatch(batch.batchId);renderBatch();
    if(batch.blockedCount||batch.status==='complete'||hasExecution()&&!batch.execution.retryable)return;
    batch.execution={mode:'workspace-agent',state:'uncertain',retryable:true};executionIntents.set(batch.batchId,batch.execution);renderBatch();
    try{
      const value=await bridge(`/batches/${batch.batchId}/start`,{});
      executionIntents.delete(batch.batchId);
      if(value.mode==='copy'){batch.execution=null;executionReady=false;renderBatch();notice('프롬프트 복사를 사용할 수 있습니다. 공식 자동 연결은 설정되지 않았습니다.');}
      else{if(value.mode==='complete')batch=await readBatch(batch.batchId);else batch.execution=value;renderBatch();notice(value.mode==='complete'?'선택한 회차의 번역이 모두 확정됐습니다.':'공식 실행 상태를 받았습니다. 자막 완료는 분할 저장·전편 확정 후 표시합니다.');}
    }catch(error){renderBatch();throw new Error(`${error.message} 접수 여부가 불명확하여 프롬프트 복사는 보류했습니다.`);}
  }));
  (async()=>{try{bridgeToken=(await chrome.storage.local.get('ottspeedBridge')).ottspeedBridge?.token||null;await refresh();notice('보관한 자막을 불러왔습니다.');const last=(await chrome.storage.local.get('ottspeedLibrary')).ottspeedLibrary?.lastBatchId;if(bridgeToken){await checkExecution();if(last){try{batch=await readBatch(last);renderBatch();}catch(error){$('batch-status').textContent=error.message;}}}
    await run(async()=>{try{if(bridgeToken)await ensureRuntime();const n=await syncArchive();notice(`보관한 자막을 불러왔습니다.${n?' 수집 보관소 '+n+'개 회차와 완료된 번역을 연결했습니다.':''}`);}catch(error){notice(`브라우저 보관 자료는 표시했습니다. ${error.message}`,true);}});
  }catch(error){notice(error.message,true);}finally{controls();}})();
  void collectionRead().catch(error=>{$('collection-status').textContent=error.message;});
  setInterval(()=>{
    if(busy||archiveSyncing||refreshing||metadataDirty||['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))return;
    refreshing=true;void (async()=>{await collectionRead().catch(error=>{$('collection-status').textContent=error.message;});if(bridgeToken)await syncArchive();await refresh();if(batch&&bridgeToken){const id=batch.batchId,value=await readBatch(id);if(!busy&&batch?.batchId===id){batch=value;renderBatch();}}})().catch(()=>{}).finally(()=>{refreshing=false;});
  },5000);
})();
