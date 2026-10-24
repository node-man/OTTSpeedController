/* Native host has only start/status operations; no web/content-script access. */
(() => {
  'use strict';
  globalThis.OTTLocalRuntime = ({chrome}) => {
    let pending=null;
    const errors={native_host_missing:'로컬 연결 도우미를 한 번 설치해야 합니다.',native_host_unavailable:'로컬 도우미와 통신하지 못했습니다. 확장 권한과 연결 상태를 확인하세요.',start_failed:'번역 연결을 시작하지 못했습니다. 로컬 연결 도우미 설정을 확인하세요.',start_timeout:'번역 연결 준비가 지연되고 있습니다. 잠시 후 다시 눌러 주세요.',invalid_response:'로컬 연결 상태를 확인하지 못했습니다.'};
    function native(action) {
      return new Promise(resolve=>{
        if(typeof chrome.runtime.sendNativeMessage!=='function')return resolve({error:errors.native_host_missing,errorCode:'native_host_missing'});
        try {chrome.runtime.sendNativeMessage('com.ottspeed.runtime',{action},value=>{
          if(chrome.runtime.lastError){const code=/not found|not installed/i.test(chrome.runtime.lastError.message||'')?'native_host_missing':'native_host_unavailable';return resolve({error:errors[code],errorCode:code});}
          if(value?.kind!=='ottspeed.local-runtime'||value.version!==1||typeof value.ok!=='boolean')return resolve({error:errors.invalid_response,errorCode:'invalid_response'});
          if(!value.ok)return resolve({error:errors[value.errorCode]||errors.invalid_response,errorCode:value.errorCode||'invalid_response'});
          const ready=value.state==='ready'&&value.bridgeReady===true&&value.tunnelReady===true&&value.supervisorReady===true;
          resolve({ready,state:ready?'ready':'stopped',bridgeReady:value.bridgeReady===true,tunnelReady:value.tunnelReady===true});
        });}catch{resolve({error:errors.native_host_missing,errorCode:'native_host_missing'});}
      });
    }
    return Object.freeze({status:()=>native('status'),ensure:()=>{
      if(!pending)pending=native('ensure').finally(()=>{pending=null;});
      return pending;
    }});
  };
})();
