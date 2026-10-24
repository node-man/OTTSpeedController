/* User-requested source preparation and GET-only background result delivery. */
(() => {
  'use strict';
  globalThis.OTTTranslationWorker=function({chrome,core,client,library,fetch:fetcher=fetch}) {
    const KEY='ottspeedTranslation',ALARM='ottspeed-translation-poll';
    let queue=Promise.resolve(),timer=null,polling=null;
    const preparations=new Map(),bridgeHttp=OTTDeckBridgeHttp({fetch:fetcher});
    const read=async()=>{const data=(await chrome.storage.local.get(KEY))[KEY];return data?.version===1?data:{version:1,runs:{},tabs:{}};};
    const mutate=fn=>{const task=queue.then(async()=>{const s=await read();const result=await fn(s);await chrome.storage.local.set({[KEY]:s});return result;});queue=task.catch(()=>{});return task;};
    const ask=async(tabId,message)=>{const value=await chrome.tabs.sendMessage(tabId,message);if(!value || value.error)throw new Error(value?.error || '영상 탭에 연결하지 못했습니다.');return value;};
    async function get(path) {
      const token=(await chrome.storage.local.get('ottspeedBridge')).ottspeedBridge?.token;
      if(!token)throw new Error('팝업에서 번역 시작을 다시 눌러 브리지를 연결하세요.');
      return bridgeHttp('/extension'+path,{token});
    }
    async function schedule() {
      const active=Object.values((await read()).runs).some(r=>r.phase!=='complete');
      if(!active){if(timer)clearTimeout(timer);timer=null;await chrome.alarms.clear(ALARM);return;}
      if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:0.5});
      if(!timer)timer=setTimeout(()=>{timer=null;void poll().catch(()=>{});},3000);
    }
    async function deliver(session) {
      for(const [id,key] of Object.entries((await read()).tabs)) {
        if(key!==session.mediaKey)continue;
        try {
          const state=await ask(Number(id),{action:'subtitleState'});
          if(!state.hasVideo || state.media?.key!==session.mediaKey)continue;
          await ask(Number(id),{action:'loadSubtitleSession',session:{mediaKey:session.mediaKey,tracks:session.tracks,settings:session.settings}});
        } catch { /* The saved session is restored when its episode returns. */ }
      }
    }
    async function poll() {
      if(polling)return polling;
      polling=(async()=>{
        try {
          const s=await read();if(!Object.values(s.runs).some(r=>r.phase!=='complete'))return;
          const {jobs}=await get('/jobs'),newest=new Map();for(const j of jobs)if(!newest.has(j.mediaKey))newest.set(j.mediaKey,j.jobId);
          for(const job of jobs) {
            if(!s.runs[job.jobId] || s.runs[job.jobId].phase==='complete')continue;
            try {
              const saved=await library.get(job.mediaKey),final=saved?.bridgeResults?.[job.jobId],pending=saved?.bridgeProgress?.[job.jobId];
              const needed=job.status==='complete'?!final || final.resultHash!==job.resultHash:Boolean(job.progressHash && !final && pending?.progressHash!==job.progressHash);
              if(needed){const result=await client.receive(await get(`/jobs/${job.jobId}`),s.runs[job.jobId].selectResults!==false&&newest.get(job.mediaKey)===job.jobId,library);if(result.changed&&result.selected)await deliver(result.session);}
              await mutate(state=>{const run=state.runs[job.jobId];if(run)Object.assign(run,{phase:job.status==='complete'?'complete':'translating',readyCueCount:job.readyCueCount||0,totalCueCount:job.cueCount,readyThroughMs:job.readyThroughMs||0,execution:job.execution||null,lastError:null});});
            } catch(error){await mutate(state=>{if(state.runs[job.jobId])state.runs[job.jobId].lastError=error.message;});}
          }
        } catch(error){await mutate(s=>{for(const r of Object.values(s.runs))if(r.phase!=='complete')r.lastError=error.message;});}
        finally{polling=null;await schedule();}
      })();return polling;
    }
    async function current(tabId,key) {
      const state=await ask(tabId,{action:'subtitleState'});
      if(!state.hasVideo || state.media?.platform!=='netflix' || (key&&key!==state.media.key))throw new Error('작업 준비 중 영상이 바뀌었습니다. 원래 회차에서 다시 시작하세요.');
      return state;
    }
    async function prepare(tabId) {
      const media=(await current(tabId)).media;
      await mutate(s=>{s.tabs[tabId]=media.key;});
      const old=await library.get(media.key)||client.emptySession(media);
      let source=old.tracks.source;
      if(source?.provenance!=='netflix-manifest-resource'||!source.capture?.fullEpisode) {
        const list=await ask(tabId,{action:'listNetflixTracks',mediaKey:media.key});
        const chosen=list.tracks?.find(t=>t.rawTrackType==='closedcaptions')||list.tracks?.[0];
        if(!chosen)throw new Error('Netflix 영어 트랙이 없습니다. 영상에서 영어 자막을 선택한 뒤 다시 시도하세요.');
        const captured=await ask(tabId,{action:'captureNetflixTrack',mediaKey:media.key,trackId:chosen.id});source=captured.track;
        if(source?.capture?.mediaKey!==media.key || !source.capture.fullEpisode)throw new Error('현재 회차의 영어 전편 파일을 확보하지 못했습니다.');
        core.serializeVtt(source.cues);await current(tabId,media.key);
        // Reload after collection so edits made while fetching cannot be overwritten.
        const saved=await library.get(media.key)||client.emptySession(media);
        saved.tracks.source=source;saved.pendingRequest=null;saved.bridge=null;
        saved.netflixCapture={kind:'ottspeed.netflix-capture',schemaVersion:1,mediaKey:media.key,media,track:source,rawText:captured.rawText};
        saved.settings.offsetMs=0;saved.settings.scale=1;await library.put(saved);
      }
      await current(tabId,media.key);
      return {media,source};
    }
    function prepareSource(tabId) {
      if(!Number.isInteger(tabId))return Promise.reject(new Error('영상 탭을 선택하세요.'));
      if(preparations.has(tabId))return preparations.get(tabId);
      const task=prepare(tabId).finally(()=>preparations.delete(tabId));preparations.set(tabId,task);return task;
    }
    async function watch(tabId,jobId,mediaKey,{selectResults=true}={}) {
      if(tabId!==null&&!Number.isInteger(tabId)||typeof jobId!=='string'||!(/^[a-z\d-]{1,100}$/i.test(jobId)))throw new Error('잘못된 번역 작업입니다.');
      const detail=await get(`/jobs/${jobId}`);await client.validateJob(detail);
      if(detail.mediaKey!==mediaKey)throw new Error('다른 회차의 번역 작업입니다.');
      if(!selectResults){const previous=(await read()).runs[jobId];if(previous&&previous.phase!=='complete'&&previous.selectResults!==false){await poll();return {jobId,alreadyWatching:true};}}
      const saved=await library.get(mediaKey);
      if(!saved||selectResults&&saved.tracks.source?.capture?.resourceSha256!==detail.capture.resourceSha256)throw new Error('번역 준비 중 원문이 바뀌었습니다. 다시 시작하세요.');
      const select=selectResults&&(tabId!==null||detail.status!=='complete');
      if(select){saved.pendingRequest=detail.request;saved.pendingTiming={offsetMs:0,scale:1};saved.bridge={jobId,sourceHash:detail.sourceHash,resourceSha256:detail.capture.resourceSha256};}
      saved.bridgeSnapshots||={};saved.bridgeSnapshots[jobId]={source:detail.sourceTrack,request:detail.request};await library.put(saved);
      await mutate(s=>{s.runs[jobId]={jobId,mediaKey,phase:'translating',selectResults,readyCueCount:detail.readyCueCount||0,totalCueCount:detail.cueCount,lastError:null};if(Number.isInteger(tabId))s.tabs[tabId]=mediaKey;});
      await schedule();
      if(detail.progress||detail.status==='complete') {
        const result=await client.receive(detail,select,library,{force:select&&tabId!==null});if(result.changed&&result.selected)await deliver(result.session);
      }
      await poll();return {jobId};
    }
    return {prepareSource,watch,poll,
      status:async mediaKey=>Object.values((await read()).runs).reverse().find(run=>run.mediaKey===mediaKey)||null,
      refreshStored:async mediaKey=>{const session=await library.get(mediaKey);if(session)await deliver(session);return {saved:Boolean(session)};},
      observe:(tabId,key)=>mutate(s=>{if(/^netflix:\d+$/.test(key||''))s.tabs[tabId]=key;else delete s.tabs[tabId];}),
      removed:tabId=>mutate(s=>{delete s.tabs[tabId];}),
      initialize:async()=>{await schedule();},alarm:ALARM};
  };
})();
