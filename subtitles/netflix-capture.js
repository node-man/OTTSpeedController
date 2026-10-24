/* Isolated-world collector and ownership guard for dedicated background tabs. */
(() => {
  'use strict';
  if(location.hostname!=='www.netflix.com')return;
  let ownerToken=/^#ottspeed-capture=([a-f0-9-]{36})$/i.exec(location.hash)?.[1]||null;
  const videoId=()=>/^\/watch\/(\d+)/.exec(location.pathname)?.[1]||null;
  document.addEventListener('play',event=>{if(ownerToken&&document.visibilityState==='hidden'&&event.target?.tagName==='VIDEO')event.target.pause();},true);
  function pageState(){
    const text=(document.body?.innerText||'').slice(0,100000);
    const issue=/^\/login(?:\/|$)/.test(location.pathname)?'login_required':/\bM7020\b/.test(text)?'netflix_concurrent_stream':null;
    return {videoId:videoId(),ownerToken,ready:document.readyState!=='loading',issue};
  }
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(sender.id!==chrome.runtime.id)return false;
    if(message?.action==='captureQueueState'){sendResponse(pageState());return false;}
    if(message?.action==='captureQueueRelease'){
      if(ownerToken&&message.ownerToken===ownerToken)ownerToken=null;
      sendResponse({released:!ownerToken});return false;
    }
    const queued=message?.action==='captureQueueCollect';
    if(!['listNetflixTracks','captureNetflixTrack','captureQueueCollect'].includes(message?.action))return false;
    const id=videoId();
    if(!id||message.mediaKey!==`netflix:${id}`){sendResponse({error:'Netflix 회차 식별자가 일치하지 않습니다.'});return false;}
    if(queued&&(!ownerToken||message.ownerToken!==ownerToken||document.visibilityState!=='hidden')){sendResponse({error:'수집 전용 비활성 탭이 아닙니다.'});return false;}
    const nonce=crypto.randomUUID();
    const timer=setTimeout(()=>{window.removeEventListener('message',receive);sendResponse({error:'Netflix 자막 수집기가 응답하지 않습니다.'});},25000);
    async function receive(event){
      const data=event.data;
      if(event.source!==window||event.origin!==location.origin||data?.channel!=='ottspeed-netflix-result'||data.nonce!==nonce)return;
      clearTimeout(timer);window.removeEventListener('message',receive);
      if(data.error){sendResponse({error:data.error});return;}
      try{
        if(data.result?.videoId!==id||videoId()!==id)throw new Error('수집 중 Netflix 회차가 바뀌었습니다.');
        if(queued&&(ownerToken!==message.ownerToken||document.visibilityState!=='hidden'))throw new Error('수집 탭이 사용자에게 전환됐습니다.');
        if(data.result.track){
          OTTSubtitles.serializeVtt(data.result.track.cues);
          if(!/^en(?:-|$)/i.test(data.result.track.language)||data.result.track.capture?.mediaKey!==`netflix:${id}`)throw new Error('영어 트랙 또는 회차가 일치하지 않습니다.');
          if(queued)data.result.inspection=await OTTCaptureValidation.resource(data.result,OTTSubtitles.mediaIdentity(location.href),DOMParser);
        }
        if(queued&&(ownerToken!==message.ownerToken||document.visibilityState!=='hidden'||videoId()!==id))throw new Error('수집 탭의 회차 또는 소유 상태가 바뀌었습니다.');
        sendResponse(data.result);
      }catch(error){sendResponse({error:error.message});}
    }
    window.addEventListener('message',receive);
    window.postMessage({channel:'ottspeed-netflix-request',nonce,videoId:id,action:message.action==='listNetflixTracks'?'list':'capture',trackId:message.trackId},location.origin);
    return true;
  });
})();
