/* Catalogue, asset versions and portable backups. No network or browser control. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./core.js'));else root.OTTSubtitleCatalog=factory(root.OTTSubtitles);})(globalThis,core=>{
  'use strict';
  const ROLES=['source','a','b'],MAX_BACKUP=100*1024*1024;
  const clone=value=>structuredClone(value);
  const ensure=(condition,message)=>{if(!condition)throw new Error(message);};
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),x=>x.toString(16).padStart(2,'0')).join('');
  function metadata(input={}) {
    input=input||{};
    const title=typeof input.title==='string'?input.title.trim():'';
    ensure(title.length<=200,'작품명은 200자 이하여야 합니다.');
    const number=value=>{if(value===undefined||value===null||value==='')return null;const n=Number(value);ensure(Number.isSafeInteger(n)&&n>=1&&n<=1000,'시즌·회차는 1~1000 사이의 정수여야 합니다.');return n;};
    const episodeTitle=typeof input.episodeTitle==='string'?input.episodeTitle.trim():'';ensure(episodeTitle.length<=200,'회차 제목은 200자 이하여야 합니다.');
    return {title,season:number(input.season),episode:number(input.episode),...(episodeTitle?{episodeTitle}:{})};
  }
  function cleanMedia(session) {
    ensure(session&&typeof session.mediaKey==='string'&&session.mediaKey.length<=2048&&session.media?.key===session.mediaKey,'영상 식별자가 일치하지 않습니다.');
    const identity=core.mediaIdentity(session.media.url);
    if(identity.supportedPlatform)ensure(identity.key===session.mediaKey,'영상 주소와 식별자가 다릅니다.');
    else ensure(session.mediaKey===identity.key||new RegExp('^'+identity.key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+':document:[a-f\\d-]{36}:video:\\d+:source:\\d+$','i').test(session.mediaKey),'임시 영상 식별자가 올바르지 않습니다.');
    return {...identity,key:session.mediaKey};
  }
  function cleanCapture(value) {
    if(!value)return undefined;
    const out={};
    for(const key of ['videoId','mediaKey','capturedAt','resourceSha256','resourceBytes','format','coverage','fullEpisode','basis','knownWholeFileProfile','manifestObservedAt','cueCount','startMs','endMs','audit'])if(value[key]!==undefined)out[key]=clone(value[key]);
    if(value.track)out.track=Object.fromEntries(['id','language','label','profile','rawTrackType','segmented','manifestTrackCount'].filter(k=>value.track[k]!==undefined).map(k=>[k,clone(value.track[k])]));
    return out;
  }
  function track(input) {
    ensure(input&&typeof input==='object'&&Array.isArray(input.cues),'자막 트랙이 올바르지 않습니다.');
    core.createIndex(input.cues);
    const out={name:String(input.name||'subtitle.vtt').slice(0,300),language:String(input.language||'').slice(0,35),format:['srt','vtt','ttml'].includes(input.format)?input.format:'vtt',
      cues:input.cues.map(c=>({id:c.id,startMs:c.startMs,endMs:c.endMs,text:c.text}))};
    for(const key of ['provenance','coverage','requestId','partial','totalCueCount','readyThroughMs','timingVerified','timingBasis'])if(input[key]!==undefined)out[key]=clone(input[key]);
    const sync=input.sync||{offsetMs:0,scale:1};
    ensure(Number.isFinite(sync.offsetMs)&&Math.abs(sync.offsetMs)<=3600000&&Number.isFinite(sync.scale)&&sync.scale>=0.5&&sync.scale<=2,'자막 시간 보정이 올바르지 않습니다.');out.sync={offsetMs:sync.offsetMs,scale:sync.scale};
    if(input.capture)out.capture=cleanCapture(input.capture);
    return out;
  }
  const signature=t=>({language:t.language||'',cues:t.cues.map(c=>({id:c.id,startMs:c.startMs,endMs:c.endMs,text:c.text})),requestId:t.requestId||null,provenance:t.provenance||null,resourceSha256:t.capture?.resourceSha256||null});
  async function asset(role,input,request=null,extra={}) {
    const normalized=track(input),digest=await hash(signature(normalized));
    return {assetId:`${role}:${digest}`,role,hash:digest,track:normalized,request:request?.requestId===normalized.requestId?clone(request):null,...extra};
  }
  async function prepareWrite(previous,candidate) {
    const result=clone(candidate),versions=new Map();
    for(const v of [...(previous?.versions||[]),...(candidate.versions||[])])if(v&&ROLES.includes(v.role)&&v.assetId)versions.set(v.assetId,clone(v));
    for(const role of ROLES) {
      const old=previous?.tracks?.[role],next=candidate.tracks?.[role];if(!old)continue;
      const orphanedRequest=role==='b'&&old.requestId&&old.requestId===previous.pendingRequest?.requestId&&candidate.pendingRequest?.requestId!==old.requestId;
      if(!orphanedRequest&&next&&await hash(signature(old))===await hash(signature(next)))continue;
      // One growing MCP prefix is one translation version, not hundreds of snapshots.
      if(role==='b'&&old.partial&&old.requestId&&old.requestId===next?.requestId&&next.cues.length>=old.cues.length)continue;
      const value=await asset(role,old,previous.pendingRequest,{savedAt:previous.updatedAt||new Date().toISOString()});versions.set(value.assetId,value);
    }
    result.versions=[...versions.values()];return result;
  }
  async function assets(session) {
    const values=new Map();
    const requestFor=t=>session.bridgeSnapshots?.[t.requestId]?.request||(session.pendingRequest?.requestId===t.requestId?session.pendingRequest:null)||(session.versions||[]).find(v=>v.request?.requestId===t.requestId)?.request||null;
    for(const v of session.versions||[])values.set(v.assetId,{...clone(v),current:false});
    for(const [jobId,snapshot] of Object.entries(session.bridgeSnapshots||{}))if(snapshot?.source) {
      const item=await asset('source',snapshot.source,snapshot.request,{current:false,jobId});values.set(item.assetId,item);
    }
    for(const record of Object.values(session.bridgeResults||{}))if(record?.track) {
      const request=requestFor(record.track);
      const item=await asset('b',record.track,request,{current:false});values.set(item.assetId,item);
    }
    for(const record of Object.values(session.bridgeProgress||{}))if(record?.track) {
      const request=requestFor(record.track);
      const item=await asset('b',record.track,request,{current:false});values.set(item.assetId,item);
    }
    for(const role of ROLES)if(session.tracks?.[role]) {
      const item=await asset(role,session.tracks[role],requestFor(session.tracks[role]),{current:true});values.set(item.assetId,item);
    }
    return [...values.values()];
  }
  async function validateRequest(request,mediaKey) {
    if(!request)return null;
    ensure(request.mediaKey===mediaKey&&typeof request.requestId==='string'&&request.requestId.length<=100,'번역 요청의 영상·ID가 다릅니다.');
    const fresh=await core.makeTranslationRequest({media:request.media,source:request.source,reference:request.reference,mode:request.mode,outputSlots:request.slots});
    ensure(fresh.sourceHash===request.sourceHash&&fresh.mediaKey===mediaKey,'번역 요청의 원문 해시가 다릅니다.');
    return {...fresh,requestId:request.requestId,outputTemplate:{...fresh.outputTemplate,requestId:request.requestId}};
  }
  function connection(item) {
    if(item.role==='source')return item.track.capture?.fullEpisode?'전편 수집 기록':'파일 원문';
    if(!item.request||item.request.requestId!==item.track.requestId)return '연결 미확인';
    try {
      const response={kind:'ottspeed.translation-response',schemaVersion:1,requestId:item.request.requestId,mediaKey:item.request.mediaKey,sourceHash:item.request.sourceHash,cues:item.track.cues.map(c=>({id:c.id,text:c.text}))};
      const validated=item.track.partial?core.validateTranslationProgress({...response,kind:'ottspeed.translation-progress',revision:1},item.request):core.validateTranslationResponse(response,item.request);
      ensure(JSON.stringify(validated.cues)===JSON.stringify(item.track.cues),'시각 불일치');return '요청·ID·시각 일치';
    } catch{return '연결 검사 실패';}
  }
  async function inspection(item,session) {
    const link=connection(item);
    if(item.role==='source')return {state:link,requestHashVerified:false,sourceMatches:null};
    if(link==='연결 미확인')return {state:link,requestHashVerified:false,sourceMatches:null};
    try {
      await validateRequest(item.request,session.mediaKey);
      ensure(link==='요청·ID·시각 일치','자막 슬롯 불일치');
      const original=session.tracks?.source;
      if(!original)return {state:'현재 원문 없음',requestHashVerified:true,sourceMatches:null};
      const cues=value=>core.createIndex(value.cues).cues.map(({id,startMs,endMs,text})=>({id,startMs,endMs,text}));
      const sourceMatches=JSON.stringify(cues(original))===JSON.stringify(cues(item.request.source));
      return {state:sourceMatches?'현재 원문·요청·시각 일치':'다른 원문 버전의 번역',requestHashVerified:true,sourceMatches};
    }catch{return {state:'연결 검사 실패',requestHashVerified:false,sourceMatches:null};}
  }
  async function summarize(session) {
    const all=await assets(session),b=all.filter(a=>a.role==='b');
    for(const item of all)item.inspection=await inspection(item,session);
    const target=b.find(a=>!a.track.partial&&a.inspection.sourceMatches===true)||b.find(a=>a.current)||b.find(a=>!a.track.partial)||b[0];
    const inspectionState=target?.inspection.state||'번역 연결 없음';
    const state=!session.tracks?.source?'원문 없음':!target?'번역 대기':inspectionState==='연결 검사 실패'?'검사 필요':target.inspection.sourceMatches===false?'원문 변경':target.track.partial?'일부 번역':'B 보관';
    return {mediaKey:session.mediaKey,media:session.media,catalog:metadata(session.catalog),assets:all,state,updatedAt:session.updatedAt||null,
      inspectionState,
      sourceCount:all.filter(a=>a.role==='source').length,aCount:all.filter(a=>a.role==='a').length,bCount:b.length,
      readyCueCount:target?.track.cues.length||0,totalCueCount:target?.track.totalCueCount||target?.track.cues.length||0,readyThroughMs:target?.track.readyThroughMs||0};
  }
  function matches(row,{query='',season='',state=''}={}) {
    const m=row.catalog,episode=m.season&&m.episode?`S${String(m.season).padStart(2,'0')}E${String(m.episode).padStart(2,'0')}`:'';
    return (!query||`${m.title} ${m.episodeTitle||''} ${m.season||''} ${m.episode||''} ${episode} ${row.mediaKey}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))&&
      (!season||String(m.season)===season)&&(!state||row.state===state);
  }
  async function cleanSession(input) {
    const settings={};for(const key of ['enabled','display','activeTarget','offsetMs','scale','fontSize','bottomPercent','hideNative'])if(input.settings?.[key]!==undefined)settings[key]=clone(input.settings[key]);
    const media=cleanMedia(input),result={mediaKey:input.mediaKey,media,catalog:metadata(input.catalog),tracks:{source:null,a:null,b:null},settings,revision:0};
    for(const role of ROLES)if(input.tracks?.[role])result.tracks[role]=track(input.tracks[role]);
    if(input.pendingRequest)result.pendingRequest=await validateRequest(input.pendingRequest,input.mediaKey);
    result.versions=[];
    for(const old of input.versions||[]) {
      ensure(ROLES.includes(old.role),'이전 버전의 역할이 올바르지 않습니다.');
      const request=await validateRequest(old.request,input.mediaKey),value=await asset(old.role,old.track,request,{savedAt:old.savedAt||null});
      ensure(!old.hash||old.hash===value.hash,'이전 자막 버전 해시가 다릅니다.');result.versions.push(value);
    }
    // Archive non-current bridge assets into portable versions; no pairing/launch state.
    for(const item of await assets(input))if(!item.current&&!result.versions.some(v=>v.assetId===item.assetId)) {
      const request=await validateRequest(item.request,input.mediaKey);result.versions.push(await asset(item.role,item.track,request,{savedAt:item.savedAt||null}));
    }
    if(input.netflixCapture) {
      ensure(input.netflixCapture.mediaKey===input.mediaKey&&typeof input.netflixCapture.rawText==='string','수집 원본 기록이 올바르지 않습니다.');
      ensure(new TextEncoder().encode(input.netflixCapture.rawText).length<=6*1024*1024,'수집 원본이 크기 제한을 초과합니다.');
      result.netflixCapture={kind:'ottspeed.netflix-capture',schemaVersion:1,mediaKey:input.mediaKey,media,track:track(input.netflixCapture.track),rawText:input.netflixCapture.rawText};
    }
    // A restored backup never resumes a remote execution or overwrites a current job selection.
    return result;
  }
  async function createBackup(sessions) {
    ensure(Array.isArray(sessions)&&sessions.length<=500,'백업은 최대 500개 회차까지 가능합니다.');
    const clean=await Promise.all(sessions.map(cleanSession));ensure(new Set(clean.map(s=>s.mediaKey)).size===clean.length,'중복 회차가 있습니다.');
    const payload={sessions:clean};const value={kind:'ottspeed.subtitle-library-backup',schemaVersion:1,createdAt:new Date().toISOString(),payload,sha256:await hash(payload)};
    ensure(new TextEncoder().encode(JSON.stringify(value)).length<=MAX_BACKUP,'백업이 100 MB를 초과합니다. 회차를 나눠 선택하세요.');return value;
  }
  async function readBackup(input) {
    ensure(new TextEncoder().encode(typeof input==='string'?input:JSON.stringify(input)).length<=MAX_BACKUP,'백업이 100 MB를 초과합니다.');
    const value=typeof input==='string'?JSON.parse(input):input;
    ensure(value?.kind==='ottspeed.subtitle-library-backup'&&value.schemaVersion===1&&Array.isArray(value.payload?.sessions)&&value.payload.sessions.length<=500,'지원하지 않는 라이브러리 백업입니다.');
    ensure(await hash(value.payload)===value.sha256,'백업 해시가 일치하지 않습니다.');
    const sessions=await Promise.all(value.payload.sessions.map(cleanSession));ensure(new Set(sessions.map(s=>s.mediaKey)).size===sessions.length,'백업에 중복 회차가 있습니다.');return sessions;
  }
  async function mergeArchive(session,entry) {
    ensure(entry?.kind==='ottspeed.library-archive-episode'&&entry.version===1&&entry.mediaKey===session.mediaKey&&entry.media?.key===session.mediaKey,'보관소 회차 식별자가 다릅니다.');
    cleanMedia({media:entry.media,mediaKey:entry.mediaKey});
    const source=track(entry.sourceTrack),capture=source.capture;
    ensure(source.provenance==='netflix-manifest-resource'&&capture?.fullEpisode&&capture.mediaKey===entry.mediaKey,'보관소 영어 전편 근거가 없습니다.');
    const original=await core.makeTranslationRequest({media:entry.media,source:entry.sourceTrack,reference:null,mode:'translate'});
    ensure(original.sourceHash===entry.sourceHash,'보관소 원문 해시가 다릅니다.');
    const additions=[await asset('source',source)];
    for(const result of entry.translations||[]) {
      const request=await validateRequest(result.request,entry.mediaKey);
      ensure(request.sourceHash===entry.sourceHash&&await hash(result.response)===result.resultHash,'보관소 번역 연결 또는 결과 해시가 다릅니다.');
      const validated=core.validateTranslationResponse(result.response,request);
      const translated={name:result.name,language:'ko',format:'vtt',cues:validated.cues,requestId:request.requestId,provenance:'chatgpt-plan',partial:false,
        totalCueCount:request.slots.length,readyThroughMs:Math.max(...validated.cues.map(c=>c.endMs)),timingVerified:false,sync:{offsetMs:0,scale:1}};
      additions.push(await asset('b',translated,request,{savedAt:result.createdAt||null}));
    }
    const candidate=clone(session),current=metadata(session.catalog),incoming=metadata(entry.catalog);
    candidate.catalog=metadata({title:current.title||incoming.title,season:current.season||incoming.season,episode:current.episode||incoming.episode,episodeTitle:current.episodeTitle||incoming.episodeTitle});
    const versions=new Map((candidate.versions||[]).map(v=>[v.assetId,v]));for(const item of additions)versions.set(item.assetId,versions.get(item.assetId)||item);candidate.versions=[...versions.values()];
    if(!candidate.tracks.source)candidate.tracks.source=source;
    candidate.archiveImport={revision:entry.revision,sourceHash:entry.sourceHash};return candidate;
  }
  async function selectReadyTranslation(session) {
    const settings=session.settings||{},role=settings.activeTarget==='b'?'b':'a';
    // Respect an existing selection and explicit subtitles-off / English-only.
    if(settings.enabled===false||settings.display==='source'||session.tracks?.[role]?.cues?.length)return {session,changed:false};
    const candidates=(await assets(session)).filter(item=>item.role==='b'&&!item.track.partial&&item.request)
      .sort((a,b)=>(b.savedAt||'').localeCompare(a.savedAt||''));
    for(const item of candidates){
      const checked=await inspection(item,session);if(!checked.requestHashVerified||checked.sourceMatches!==true)continue;
      const candidate=clone(session);candidate.tracks.b=clone(item.track);candidate.pendingRequest=clone(item.request);
      candidate.settings={...settings,enabled:true,activeTarget:'b',display:settings.display==='bilingual'?'bilingual':'target',hideNative:true};
      if(candidate.bridge)candidate.bridge.suspended=true;
      return {session:candidate,changed:true};
    }
    return {session,changed:false};
  }
  return Object.freeze({metadata,track,asset,assets,prepareWrite,summarize,matches,connection,inspection,cleanSession,createBackup,readBackup,hash,mergeArchive,selectReadyTranslation,limits:{maxBackupBytes:MAX_BACKUP}});
});
