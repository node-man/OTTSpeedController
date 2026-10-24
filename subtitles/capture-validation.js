/* Validate downloaded Netflix text, independently of the MAIN-world observer. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./core.js'):root.OTTSubtitles,typeof module==='object'&&module.exports?require('./netflix.js'):root.OTTNetflixSubtitles);if(typeof module==='object'&&module.exports)module.exports=api;else root.OTTCaptureValidation=api;})(globalThis,(core,netflix)=>{
  'use strict';
  const requireValue=(ok,message)=>{if(!ok)throw new Error(message);};
  function track(value,media) {
    const identity=core.mediaIdentity(media?.url),c=value?.capture;
    requireValue(identity.platform==='netflix'&&identity.key===media?.key&&c?.mediaKey===identity.key&&c.videoId===identity.videoId,'수집 회차가 일치하지 않습니다.');
    requireValue(value.provenance==='netflix-manifest-resource'&&/^en(?:-|$)/i.test(value.language)&&c.track?.language===value.language,'Netflix 영어 원문이 아닙니다.');
    core.createIndex(value.cues);
    requireValue(value.cues.length&&value.sync?.offsetMs===0&&value.sync?.scale===1,'원래 자막 시각을 유지해야 합니다.');
    requireValue(c.fullEpisode===true&&c.coverage==='complete'&&/^(webvtt-lssdh-ios8|dfxp-ls-sdh)$/.test(c.track.profile)&&!c.track.segmented,'영어 전편 파일을 확인하지 못했습니다.');
    requireValue(/^[a-f0-9]{64}$/.test(c.resourceSha256||'')&&Number.isSafeInteger(c.resourceBytes)&&c.resourceBytes>0,'원문 바이트 근거가 없습니다.');
    requireValue(c.audit?.documentComplete&&c.audit.allTimedEntriesAccountedFor&&c.audit.excludedCount===0&&c.audit.inputCount===value.cues.length&&c.audit.acceptedCount===value.cues.length,'원문 입력 항목 검사가 일치하지 않습니다.');
    requireValue(c.cueCount===value.cues.length&&c.startMs===Math.min(...value.cues.map(c=>c.startMs))&&c.endMs===Math.max(...value.cues.map(c=>c.endMs)),'원문 시각 범위가 다릅니다.');
    return value;
  }
  async function resource(result,media,Parser) {
    track(result?.track,media);requireValue(typeof result.rawText==='string','수집한 원본 파일이 없습니다.');
    const encoder=new TextEncoder(),raw=encoder.encode(result.rawText),c=result.track.capture;
    requireValue(raw.length<=core.limits.maxBytes,'수집 원문이 크기 제한을 초과합니다.');
    const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    let bytes=raw,bomReconstructed=false;
    if(await digest(bytes)!==c.resourceSha256){bytes=new Uint8Array(raw.length+3);bytes.set([239,187,191]);bytes.set(raw,3);bomReconstructed=true;}
    requireValue(bytes.length===c.resourceBytes&&await digest(bytes)===c.resourceSha256,'수집 원본 바이트 해시가 다릅니다.');
    const parsed=netflix.parseAsset(result.rawText,core,Parser);
    requireValue(JSON.stringify(parsed.cues)===JSON.stringify(result.track.cues)&&JSON.stringify(parsed.audit)===JSON.stringify(c.audit),'수집 원문의 독립 파싱 검사가 다릅니다.');
    return {independentByteHashVerified:true,independentReparseMatches:true,bomReconstructed};
  }
  return Object.freeze({track,resource});
});
