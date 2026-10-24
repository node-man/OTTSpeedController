/* Shared, DOM-free validation and durable delivery for workspace/worker clients. */
(() => {
  'use strict';
  const core=globalThis.OTTSubtitles;
  const emptySession=media=>({mediaKey:media.key,media:{...media},tracks:{source:null,a:null,b:null},
    settings:{enabled:true,display:'target',activeTarget:'a',offsetMs:0,scale:1,fontSize:28,bottomPercent:10,hideNative:false},pendingRequest:null,revision:0});
  async function validateJob(detail) {
    const r=detail.request;
    if(!r || detail.jobId!==r.requestId || detail.sourceHash!==r.sourceHash || r.mode!=='translate' || r.reference!==null ||
      detail.mediaKey!==r.mediaKey || detail.media?.key!==r.mediaKey || detail.sourceTrack?.capture?.mediaKey!==r.mediaKey || !detail.sourceTrack.capture.fullEpisode) throw new Error('브리지 작업의 영상·원문 계약이 일치하지 않습니다.');
    const fresh=await core.makeTranslationRequest({media:detail.media,source:detail.sourceTrack,reference:null,mode:'translate'});
    if(fresh.sourceHash!==r.sourceHash || JSON.stringify(fresh.slots)!==JSON.stringify(r.slots)) throw new Error('브리지 원문 스냅샷이 변경됐습니다.');
  }
  async function hash(value) {
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function receive(detail,isLatest,library,{force=false}={}) {
    await validateJob(detail);
    const partial=detail.status!=='complete';
    const validated=partial?core.validateTranslationProgress(detail.progress,detail.request):core.validateTranslationResponse(detail.response,detail.request);
    const fingerprint=partial?detail.progressHash:detail.resultHash;
    if(await hash(partial?detail.progress:detail.response)!==fingerprint) throw new Error('브리지 결과 해시가 일치하지 않습니다.');
    for(let attempt=0;attempt<3;attempt++) {
      const original=await library.get(detail.mediaKey)||emptySession(detail.media);
      const final=original.bridgeResults?.[detail.jobId],previous=original.bridgeProgress?.[detail.jobId];
      if(final && (partial || (!force && final.resultHash===detail.resultHash))) return {changed:false,session:original,selected:false};
      if(partial && previous) {
        if(previous.revision>detail.progress.revision) return {changed:false,session:original,selected:false};
        if(previous.revision===detail.progress.revision && previous.progressHash!==fingerprint) throw new Error('같은 번역 진행 버전의 내용이 달라졌습니다.');
        if(!force && previous.progressHash===fingerprint) return {changed:false,session:original,selected:false};
        if(previous.track.cues.length>validated.cues.length) throw new Error('이미 시청 가능한 번역 범위가 줄어들었습니다.');
      }
      const track={name:`Netflix_${detail.media.videoId}.ko.B${partial?'.partial':''}.vtt`,language:'ko',format:'vtt',cues:validated.cues,
        requestId:detail.jobId,provenance:partial?'chatgpt-mcp-partial':'chatgpt-mcp',partial,totalCueCount:detail.request.slots.length,
        readyThroughMs:partial?validated.readyThroughMs:detail.capture.endMs,timingVerified:false,sync:{offsetMs:0,scale:1}};
      const candidate=structuredClone(original);
      if(partial) {
        candidate.bridgeProgress||={};candidate.bridgeProgress[detail.jobId]={progressHash:fingerprint,revision:detail.progress.revision,receivedAt:new Date().toISOString(),track};
      } else {
        candidate.bridgeResults||={};candidate.bridgeResults[detail.jobId]={resultHash:fingerprint,receivedAt:new Date().toISOString(),track};
        if(candidate.bridgeProgress) delete candidate.bridgeProgress[detail.jobId];
      }
      const sameSource=!candidate.tracks.source || candidate.tracks.source.capture?.resourceSha256===detail.capture.resourceSha256;
      const selected=isLatest && sameSource && !candidate.bridge?.suspended && (!candidate.bridge || candidate.bridge.jobId===detail.jobId);
      if(selected) {
        const continuing=candidate.tracks.b?.requestId===detail.jobId;
        candidate.tracks.source=structuredClone(detail.sourceTrack);candidate.tracks.source.sync={offsetMs:0,scale:1};candidate.tracks.b=track;
        candidate.pendingRequest=detail.request;candidate.pendingTiming={offsetMs:0,scale:1};
        candidate.bridge={jobId:detail.jobId,sourceHash:detail.sourceHash,resourceSha256:detail.capture.resourceSha256};
        if(force || !continuing) Object.assign(candidate.settings,{enabled:true,activeTarget:'b',offsetMs:0,scale:1,hideNative:true,display:candidate.settings.display==='bilingual'?'bilingual':'target'});
      }
      try {return {changed:true,selected,session:await library.put(candidate)};}
      catch(error) {if(error.name!=='ConflictError'||attempt===2) throw error;}
    }
  }
  const prompt=job=>globalThis.OTTTranslationPrompt.build(job);
  globalThis.OTTBridgeClient=Object.freeze({emptySession,validateJob,receive,hash,prompt});
})();
