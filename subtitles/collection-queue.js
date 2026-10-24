/* Durable, serial background collection. Only explicit watch IDs; no player API. */
(() => {
  'use strict';
  globalThis.OTTCollectionQueue=function({chrome,core,validation,library,now=()=>Date.now(),timeoutMs=90000}) {
    const KEY='ottspeedCollection',ALARM='ottspeed-collection-poll',terminal=new Set(['complete','needs_attention','cancelled']);
    let mutations=Promise.resolve(),ticking=null,timer=null,processingId=null;
    const read=async()=>{const s=(await chrome.storage.local.get(KEY))[KEY];return s?.version===1?s:{version:1,paused:false,entries:[]};};
    const mutate=fn=>{const task=mutations.then(async()=>{const s=await read(),out=await fn(s);await chrome.storage.local.set({[KEY]:s});return out;});mutations=task.catch(()=>{});return task;};
    const current=async id=>(await read()).entries.find(e=>e.id===id);
    async function update(id,change){return mutate(s=>{const e=s.entries.find(e=>e.id===id);if(e&&!terminal.has(e.status))Object.assign(e,change);return e;});}
    async function ask(tabId,message,ms=2000){let handle;try{return await Promise.race([chrome.tabs.sendMessage(tabId,message),new Promise((_,reject)=>{handle=setTimeout(()=>reject(new Error('page_timeout')),ms);})]);}finally{clearTimeout(handle);}}
    async function page(tabId){try{return await ask(tabId,{action:'captureQueueState'});}catch{return null;}}
    async function occupied(ownedId) {
      const tabs=await chrome.tabs.query({});
      const states=await Promise.all(tabs.filter(t=>t.id!==ownedId).map(async tab=>{
        if(/^https:\/\/www\.netflix\.com\/watch\/\d+/.test(tab.url||''))return true;
        const state=await page(tab.id);if(state?.videoId)return true;
        try{const old=await ask(tab.id,{action:'checkVideo'});return old?.media?.platform==='netflix';}catch{return false;}
      }));return states.some(Boolean);
    }
    async function closeOwned(entry) {
      if(!Number.isInteger(entry.tabId))return true;
      const tab=await chrome.tabs.get(entry.tabId).catch(()=>null);if(!tab)return true;
      try{const state=await page(entry.tabId);
        if(tab.active){if(state?.ownerToken===entry.ownerToken)await ask(entry.tabId,{action:'captureQueueRelease',ownerToken:entry.ownerToken}).catch(()=>{});return false;}
        if(state?.ownerToken!==entry.ownerToken||state.videoId!==entry.videoId)return false;
        await mutate(s=>{const e=s.entries.find(e=>e.id===entry.id);if(e)e.cleanupExpected=true;});
        // Recheck after the storage await: the user may have selected this tab.
        if((await chrome.tabs.get(entry.tabId)).active){await mutate(s=>{const e=s.entries.find(e=>e.id===entry.id);if(e)e.cleanupExpected=false;});return false;}
        await chrome.tabs.remove(entry.tabId);
        await mutate(s=>{const e=s.entries.find(e=>e.id===entry.id);if(e)Object.assign(e,{tabId:null,cleanupExpected:false,cleanupPending:false});});return true;
      }catch{return false;}
    }
    async function schedule() {
      const s=await read(),pending=s.entries.some(e=>e.cleanupPending)||!s.paused&&s.entries.some(e=>!terminal.has(e.status));
      if(!pending){if(timer)clearTimeout(timer);timer=null;await chrome.alarms.clear(ALARM);return;}
      if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:0.5});
      if(!timer)timer=setTimeout(()=>{timer=null;void tick().catch(()=>{});},s.entries.some(e=>e.status==='waiting_for_viewer')?10000:2000);
    }
    async function fail(entry,errorCode) {
      // Never close a foreground, navigated, or unidentifiable tab.
      const closed=await closeOwned(entry);
      await update(entry.id,{status:'needs_attention',errorCode,tabId:closed?null:entry.tabId,cleanupPending:!closed&&!['capture_tab_taken_over','capture_tab_navigated','wrong_episode'].includes(errorCode),cleanupStartedAt:now()});
    }
    async function save(entry,result) {
      const media=core.mediaIdentity(entry.url);validation.track(result.track,media);
      if(!result.inspection?.independentByteHashVerified||!result.inspection?.independentReparseMatches)throw new Error('resource_not_validated');
      for(let attempt=0;attempt<3;attempt++){
        const state=await read(),live=state.entries.find(e=>e.id===entry.id);if(state.paused||!live||terminal.has(live.status))return false;
        const old=await library.get(media.key)||{mediaKey:media.key,media,tracks:{source:null,a:null,b:null},settings:{enabled:true,display:'target',activeTarget:'a',offsetMs:0,scale:1,fontSize:28,bottomPercent:10,hideNative:false},revision:0};
        old.tracks.source=structuredClone(result.track);old.pendingRequest=null;if(old.bridge)old.bridge.suspended=true;
        old.netflixCapture={kind:'ottspeed.netflix-capture',schemaVersion:1,mediaKey:media.key,media,track:structuredClone(result.track),rawText:result.rawText};
        const latest=await read(),pending=latest.entries.find(e=>e.id===entry.id);if(latest.paused||!pending||terminal.has(pending.status))return false;
        try{await library.put(old);return true;}catch(error){if(error.name!=='ConflictError'||attempt===2)throw error;}
      }
    }
    async function step() {
      const s=await read();
      const cleanup=s.entries.find(e=>e.cleanupPending);
      if(cleanup){const closed=await closeOwned(cleanup);if(!closed&&now()-cleanup.cleanupStartedAt>timeoutMs)await mutate(state=>{const e=state.entries.find(e=>e.id===cleanup.id);if(e)Object.assign(e,{cleanupPending:false,errorCode:'cleanup_unverified'});});return;}
      if(s.paused)return;let entry=s.entries.find(e=>!terminal.has(e.status));if(!entry)return;processingId=entry.id;
      const media=core.mediaIdentity(entry.url);
      if(!entry.tabId){
        if(entry.status==='opening'&&entry.ownerToken){
          const tabs=await chrome.tabs.query({}),owned=(await Promise.all(tabs.map(async tab=>({tab,state:await page(tab.id)})))).find(v=>v.state?.ownerToken===entry.ownerToken&&v.state.videoId===entry.videoId);
          if(owned){await update(entry.id,{tabId:owned.tab.id});entry={...entry,tabId:owned.tab.id};}
          else{if(now()-entry.startedAt>timeoutMs)await fail(entry,'capture_tab_unidentified');return;}
        }
      }
      if(!entry.tabId){
        const cached=await library.get(media.key);try{validation.track(cached?.tracks.source,media);await update(entry.id,{status:'complete',cached:true,cueCount:cached.tracks.source.cues.length,errorCode:null});return;}catch{}
        if(await occupied(null)){await update(entry.id,{status:'waiting_for_viewer',errorCode:'netflix_tab_open'});return;}
        const live=await current(entry.id);if((await read()).paused||!live||terminal.has(live.status))return;
        const ownerToken=crypto.randomUUID();await update(entry.id,{status:'opening',ownerToken,startedAt:now(),errorCode:null});
        const tab=await chrome.tabs.create({url:`${entry.url}#ottspeed-capture=${ownerToken}`,active:false});
        await mutate(state=>{const e=state.entries.find(e=>e.id===entry.id);if(e)e.tabId=tab.id;});entry={...entry,ownerToken,tabId:tab.id,startedAt:now()};
        // Cancellation while create() was pending must still record/clean up our tab.
        const latest=await current(entry.id);if(!latest||terminal.has(latest.status)||(await read()).paused){const closed=await closeOwned(entry);if(!closed)await mutate(state=>{const e=state.entries.find(e=>e.id===entry.id);if(e)Object.assign(e,{cleanupPending:true,cleanupStartedAt:now()});});return;}
      }
      const tab=await chrome.tabs.get(entry.tabId).catch(()=>null);if(!tab){await fail(entry,'capture_tab_closed');return;}
      if(tab.active){await ask(entry.tabId,{action:'captureQueueRelease',ownerToken:entry.ownerToken}).catch(()=>{});await fail(entry,'capture_tab_taken_over');return;}
      if(await occupied(entry.tabId)){if(await closeOwned(entry))await update(entry.id,{status:'waiting_for_viewer',tabId:null,errorCode:'netflix_tab_open'});else await fail(entry,'capture_tab_navigated');return;}
      const state=await page(entry.tabId);
      if(state?.issue){await fail(entry,state.issue);return;}
      if(state&&state.ownerToken!==entry.ownerToken){await fail(entry,'capture_tab_navigated');return;}
      if(state?.videoId&&state.videoId!==entry.videoId){await fail(entry,'wrong_episode');return;}
      if(now()-entry.startedAt>timeoutMs){await fail(entry,'manifest_timeout');return;}
      if(!state?.ready){await update(entry.id,{status:'observing'});return;}
      const tracks=await ask(entry.tabId,{action:'listNetflixTracks',mediaKey:media.key});
      const chosen=tracks?.tracks?.find(t=>t.rawTrackType==='closedcaptions')||tracks?.tracks?.[0];
      if(!chosen){await update(entry.id,{status:'observing'});return;}
      await update(entry.id,{status:'capturing'});
      const result=await ask(entry.tabId,{action:'captureQueueCollect',mediaKey:media.key,trackId:chosen.id,ownerToken:entry.ownerToken},35000);
      if(result?.error)throw new Error('collection_failed');
      if((await chrome.tabs.get(entry.tabId)).active){await ask(entry.tabId,{action:'captureQueueRelease',ownerToken:entry.ownerToken}).catch(()=>{});await fail(entry,'capture_tab_taken_over');return;}
      const after=await page(entry.tabId);if(after?.ownerToken!==entry.ownerToken||after.videoId!==entry.videoId)throw new Error('wrong_episode');
      if(await occupied(entry.tabId))throw new Error('netflix_tab_open');
      if(await save(entry,result)){const closed=await closeOwned(entry);await update(entry.id,{status:'complete',tabId:closed?null:entry.tabId,cleanupPending:!closed,cleanupStartedAt:now(),cached:false,cueCount:result.track.cues.length,errorCode:closed?null:'cleanup_unverified',completedAt:now()});}
    }
    async function tick(){if(ticking)return ticking;ticking=(async()=>{try{await step();}catch(error){const s=await read(),e=s.entries.find(e=>e.id===processingId);if(e&&!terminal.has(e.status)&&!s.paused)await fail(e,['wrong_episode','netflix_tab_open'].includes(error.message)?error.message:'collection_failed');}finally{processingId=null;ticking=null;await schedule();}})();return ticking;}
    return {
      alarm:ALARM,tick,
      status:()=>read(),
      initialize:async()=>{await schedule();},
      enqueue:async inputs=>{
        if(!Array.isArray(inputs)||!inputs.length||inputs.length>100)throw new Error('회차 주소는 1~100개까지 입력하세요.');
        const media=inputs.map(value=>{if(typeof value!=='string')throw new Error('Netflix 회차 주소가 필요합니다.');const text=value.trim(),url=/^\d{1,15}$/.test(text)?`https://www.netflix.com/watch/${text}`:text;const m=core.mediaIdentity(url);if(m.platform!=='netflix'||!/^https:\/\/www\.netflix\.com\/watch\/\d+$/.test(m.url))throw new Error('Netflix /watch/ 회차 주소 또는 영상 ID를 입력하세요.');return m;});
        await mutate(s=>{if(s.entries.length+media.length>500)throw new Error('수집 기록은 최대 500개까지 보관합니다.');for(const m of media){if(s.entries.some(e=>e.videoId===m.videoId&&!terminal.has(e.status)))continue;s.entries.push({id:crypto.randomUUID(),videoId:m.videoId,url:m.url,status:'queued',createdAt:now(),tabId:null,errorCode:null});}});
        await schedule();void tick();return read();
      },
      pause:async()=>{await mutate(s=>{s.paused=true;});const s=await read();for(const e of s.entries.filter(e=>e.tabId&&!terminal.has(e.status))){const closed=await closeOwned(e);await update(e.id,{status:closed?'queued':'needs_attention',tabId:closed?null:e.tabId,errorCode:closed?null:'cleanup_unverified',cleanupPending:!closed,cleanupStartedAt:now()});}await schedule();return read();},
      resume:async()=>{await mutate(s=>{s.paused=false;for(const e of s.entries)if(e.status==='needs_attention'&&!e.tabId)Object.assign(e,{status:'queued',errorCode:null,startedAt:null});});await schedule();void tick();return read();},
      cancel:async id=>{let entry;await mutate(s=>{entry=s.entries.find(e=>e.id===id);if(entry&&!terminal.has(entry.status))entry.status='cancelled';});if(entry&&!await closeOwned(entry))await mutate(s=>{const e=s.entries.find(e=>e.id===id);if(e)Object.assign(e,{cleanupPending:true,cleanupStartedAt:now()});});await schedule();return read();},
      removed:async id=>{await mutate(s=>{for(const e of s.entries)if(e.tabId===id){e.tabId=null;e.cleanupPending=false;if(!terminal.has(e.status)&&!e.cleanupExpected)Object.assign(e,{status:'needs_attention',errorCode:'capture_tab_closed'});}});void tick();}
    };
  };
})();
