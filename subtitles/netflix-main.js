/* MAIN-world observer, installed before Netflix parses its playback manifest.
 * Only text tracks for the current watch ID are exposed. No DRM/media fetching. */
(() => {
  'use strict';
  if (window.__OTT_NETFLIX_CAPTURE__) return;
  window.__OTT_NETFLIX_CAPTURE__ = true;
  const nativeParse=JSON.parse, nativeStringify=JSON.stringify, nativeFetch=window.fetch.bind(window);
  const manifests=new Map();
  const diagnostic={version:'capture-3',jsonInspections:0,trackLists:0,englishTracks:0,usableFiles:0,profileRequests:0,lastManifestVideoId:null,languages:[],profiles:[],roots:[],candidates:[],observerErrors:[]};
  const currentId=()=>/^\/watch\/(\d+)/.exec(location.pathname)?.[1];
  const send=value=>window.postMessage({channel:'ottspeed-netflix-result',...value},location.origin);
  function observe(root) {
    diagnostic.jsonInspections++;
    if(diagnostic.roots.length<12)diagnostic.roots.push({type:typeof root,array:Array.isArray(root),keys:root&&typeof root==='object'?Object.keys(root).slice(0,35):[]});
    const seen=new WeakSet();const queue=[{obj:root,inherited:'',path:'$'}];let cursor=0;
    while(cursor<queue.length&&cursor<20000){
      const {obj,inherited,path}=queue[cursor++];
      if (!obj || typeof obj!=='object' || seen.has(obj)) continue;
      seen.add(obj);
      const id=String(obj.movieId || obj.viewableId || obj.videoId || inherited || '');
      const field=['textTracks','timedtexttracks','timedTextTracks','texttracks'].find(k=>obj[k]&&typeof obj[k]==='object');
      const trackContainer=field?obj[field]:null;
      const list=Array.isArray(trackContainer)?trackContainer:trackContainer?Object.values(trackContainer):null;
      if(diagnostic.candidates.length<20&&(field||obj.downloadables||obj.ttDownloadables))diagnostic.candidates.push({path,videoId:id||null,field:field||null,keys:Object.keys(obj).slice(0,35),trackCount:list?.length,firstTrackKeys:list?.[0]&&typeof list[0]==='object'?Object.keys(list[0]).slice(0,30):[],profiles:Object.keys(obj.downloadables||obj.ttDownloadables||{})});
      if (Array.isArray(list) && /^\d+$/.test(id) && id===currentId()) {
        diagnostic.trackLists++;diagnostic.lastManifestVideoId=id;
        diagnostic.languages=[...new Set(list.map(t=>String(t.language||t.bcp47||'')))];
        const tracks=[];
        for (const [i,t] of list.entries()) {
          if(!t||typeof t!=='object')continue;
          const language=t.bcp47 || t.language || '';
          if (!/^en(?:-|$)/i.test(language) || t.isNoneTrack || t.isForcedNarrative) continue;
          diagnostic.englishTracks++;
          const downloads=t.ttDownloadables || t.downloadables || {};
          diagnostic.profiles=[...new Set([...diagnostic.profiles,...Object.keys(downloads)])];
          const profiles=Object.keys(downloads).filter(p=>/webvtt|dfxp|ttml/i.test(p)).sort((a,b)=>Number(!/webvtt/i.test(a))-Number(!/webvtt/i.test(b)));
          for (const profile of profiles) {
            const item=downloads[profile];
            const urls=[...Object.values(item.downloadUrls || {}),...(Array.isArray(item.urls)?item.urls:[])].map(u=>typeof u==='string'?u:u?.url).filter(Boolean);
            if (!urls.length) continue;
            diagnostic.usableFiles++;
            tracks.push({id:String(t.new_track_id || t.trackId || t.id || `manifest-${i}`),language,
              label:String(t.languageDescription || t.displayName || t.name || language),profile,urls,
              rawTrackType:t.rawTrackType || t.type || null,
              segmented:Boolean(item.segments || item.chunks || item.segmentIndex),
              manifestTrackCount:list.length});
            break;
          }
        }
        manifests.set(id,{videoId:id,tracks,observedAt:new Date().toISOString()}); if(manifests.size>3)manifests.delete(manifests.keys().next().value);
      }
      if(queue.length<30000)for(const [key,value]of Object.entries(obj))if(value&&typeof value==='object')queue.push({obj:value,inherited:id,path:`${path}.${key}`.slice(0,220)});
    }
    diagnostic.lastVisitedNodes=cursor;
  }
  function inspect(value){try{observe(value);}catch(error){if(diagnostic.observerErrors.length<5)diagnostic.observerErrors.push(String(error.message).slice(0,180));}}
  const mayContainTracks=text=>typeof text==='string'&&/timedtexttracks|textTracks|timedTextTracks|texttracks|downloadables|ttDownloadables|isNoneTrack/.test(text);
  JSON.parse=function(...args){const value=Reflect.apply(nativeParse,this,args);if(mayContainTracks(args[0]))inspect(value);return value;};
  JSON.stringify=function(value,...args){
    try {
      const nodes=[];const seen=new WeakSet();
      function gather(obj){if(!obj||typeof obj!=='object'||seen.has(obj)||nodes.length>=1000)return;seen.add(obj);nodes.push(obj);for(const child of Object.values(obj))if(child&&typeof child==='object')gather(child);}
      gather(value);
      const manifestRequest=Boolean(value?.params?.profiles)||nodes.some(n=>typeof n.url==='string'&&/manifest|licensedManifest/i.test(n.url));
      if(manifestRequest)for(const node of nodes){
        const profiles=node.profiles;
        if(Array.isArray(profiles)&&profiles.length&&profiles.every(x=>typeof x==='string')&&!profiles.includes('webvtt-lssdh-ios8')){profiles.push('webvtt-lssdh-ios8');diagnostic.profileRequests++;}
      }
    }catch{}
    return Reflect.apply(nativeStringify,this,[value,...args]);
  };
  // Response.json() need not call the public JSON.parse function.
  window.fetch=async function(...args){const response=await nativeFetch(...args);try{
    if(/json/.test(response.headers.get('content-type')||''))void response.clone().text().then(text=>{
      if(text.length<10000000&&mayContainTracks(text))inspect(nativeParse(text));
    }).catch(()=>{});
  }catch{}return response;};
  const open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(...args){this.addEventListener('load',()=>{try{
    if(this.responseType==='json')inspect(this.response);
    else if((!this.responseType||this.responseType==='text')&&this.responseText.length<10000000&&mayContainTracks(this.responseText))inspect(nativeParse(this.responseText));
  }catch{}},{once:true});return Reflect.apply(open,this,args);};
  const publicTrack=t=>({id:t.id,language:t.language,label:t.label,profile:t.profile,rawTrackType:t.rawTrackType,segmented:t.segmented,manifestTrackCount:t.manifestTrackCount});
  window.addEventListener('message',event=>{
    const request=event.data;
    if(event.source!==window||event.origin!==location.origin||request?.channel!=='ottspeed-netflix-request'||typeof request.nonce!=='string')return;
    void (async()=>{
      const id=currentId(),manifest=manifests.get(id);
      if(!id || request.videoId!==id)throw new Error('현재 Netflix 회차가 바뀌었습니다.');
      if(request.action==='list')return {videoId:id,observedAt:manifest?.observedAt||null,tracks:(manifest?.tracks||[]).map(publicTrack),diagnostic};
      if(!manifest?.tracks.length)throw new Error(`영어 파일 미확보: ${diagnostic.version}. 구조 진단 파일을 확인하세요.`);
      if(request.action!=='capture')throw new Error('지원하지 않는 수집 동작입니다.');
      const selected=manifest.tracks.find(t=>t.id===request.trackId);
      if(!selected)throw new Error('선택한 영어 트랙을 찾지 못했습니다. 목록을 갱신하세요.');
      if(selected.segmented)throw new Error('분할 자막 자료여서 현재 경로로 전편 수집을 보장할 수 없습니다.');
      let rawText,bytes,resourceHash;
      for(const address of selected.urls){
        const url=new URL(address);
        if(url.protocol!=='https:'||!/(^|\.)nflxvideo\.net$/.test(url.hostname))continue;
        const response=await nativeFetch(url.href,{credentials:'omit',signal:AbortSignal.timeout(20000)});
        if(!response.ok)continue;
        bytes=new Uint8Array(await response.arrayBuffer());
        if(bytes.length>5*1024*1024)throw new Error('자막 자료가 5 MB를 초과합니다.');
        rawText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        resourceHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
        break;
      }
      if(rawText===undefined)throw new Error('Netflix 자막 파일을 내려받지 못했습니다.');
      if(currentId()!==id)throw new Error('자막 다운로드 중 회차가 바뀌었습니다.');
      const parsed=OTTNetflixSubtitles.parseAsset(rawText,OTTSubtitles,DOMParser);
      if(!parsed.cues.length)throw new Error('자막 파일에서 읽을 수 있는 본문이 없습니다.');
      const knownWholeFile=/^(?:webvtt-lssdh-ios8|dfxp-ls-sdh)$/i.test(selected.profile);
      const complete=knownWholeFile&&parsed.audit.documentComplete&&parsed.audit.allTimedEntriesAccountedFor;
      const capture={videoId:id,mediaKey:`netflix:${id}`,track:publicTrack(selected),capturedAt:new Date().toISOString(),
        resourceSha256:resourceHash,resourceBytes:bytes.length,format:parsed.format,audit:parsed.audit,
        coverage:complete?'complete':'partial',fullEpisode:complete,
        basis:'Current-video playback manifest selected English non-forced track; complete download of its single whole-file text representation; all parsed timed entries accounted for. Not inferred from the final timestamp.',
        knownWholeFileProfile:knownWholeFile,manifestObservedAt:manifest.observedAt,
        cueCount:parsed.cues.length,startMs:Math.min(...parsed.cues.map(c=>c.startMs)),endMs:Math.max(...parsed.cues.map(c=>c.endMs))};
      return {videoId:id,track:{name:`Netflix_${id}_${selected.id}.en.vtt`,language:selected.language,format:parsed.format,cues:parsed.cues,
        provenance:'netflix-manifest-resource',coverage:capture.coverage,timingVerified:false,timingBasis:'netflix-resource',sync:{offsetMs:0,scale:1},capture},rawText};
    })().then(result=>send({nonce:request.nonce,result})).catch(error=>send({nonce:request.nonce,error:error.message}));
  });
})();
