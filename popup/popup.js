'use strict';
const $ = id => document.getElementById(id);
let currentTabId = null;
let currentState = {};
let openingTranslation = false;
let currentExecution = null;
const bridgeHttp=OTTDeckBridgeHttp({offlineMessage:'로컬 번역 브리지를 실행한 뒤 다시 시도하세요.'});
let connectingRuntime = null;
function ensureRuntime() {
  if(connectingRuntime)return connectingRuntime;
  $('runtime-connect-btn').disabled=true;
  $('runtime-status').textContent='번역 연결 준비 중…';
  connectingRuntime=(async()=>{
    try {
      const value=await chrome.runtime.sendMessage({action:'ensureLocalRuntime'});
      if(!value)throw new Error('연결 기능을 적용하려면 확장을 한 번 새로고침해 주세요.');
      if(!value?.ready)throw new Error(value?.error||'번역 연결이 아직 준비되지 않았습니다.');
      $('runtime-status').textContent='로컬 번역 연결 준비됨';
      return value;
    } catch(error) {$('runtime-status').textContent=error.message;throw error;}
    finally {$('runtime-connect-btn').disabled=false;connectingRuntime=null;}
  })();
  return connectingRuntime;
}
$('runtime-connect-btn').addEventListener('click',()=>void ensureRuntime().catch(()=>{}));
const readyTime = ms => `${String(Math.floor(ms / 60000)).padStart(2,'0')}:${String(Math.floor(ms / 1000)%60).padStart(2,'0')}`;

function render(result = {}) {
  if(result.media?.key && result.media.key!==currentState.media?.key)currentExecution=null;
  currentState = { ...currentState, ...result };
  result = currentState;
  const available = Boolean(result.hasVideo);
  $('main-content').hidden = !available;
  $('no-video').style.display = available ? 'none' : 'block';
  $('workspace-btn').disabled = !available;
  $('translate-btn').disabled = !available || result.media?.platform !== 'netflix' || openingTranslation;
  const translation = result.subtitles?.translation;
  const ready = available && translation?.readyCueCount > 0 && result.subtitles?.settings?.enabled && result.subtitles.settings.activeTarget === 'b' && result.subtitles.settings.display !== 'source';
  $('play-translated-btn').disabled = !ready;
  $('translation-status').textContent = translation?.readyCueCount ?
    (translation.partial ? translation.readyCueCount === translation.totalCueCount ? '전체 문안이 저장됐습니다. 전편 확정 중입니다.' : `${readyTime(translation.readyThroughMs)}까지 번역됨 · ${translation.readyCueCount}/${translation.totalCueCount}개. 뒤 구간은 번역 중이며 영어로 표시됩니다.` : '전편 B 번역이 준비됐습니다.') : 'ChatGPT에 복사한 요청을 보내면 준비된 앞부분부터 자동으로 받습니다.';
  $('execution-status').textContent=executionText(currentExecution);
  $('status').className = `status ${available ? 'active' : 'inactive'}`;
  document.querySelector('.status-text').textContent = available ? (result.isPlaying ? '재생 중' : '일시정지') : '비디오 없음';
  if (Number.isFinite(result.currentSpeed)) renderSpeed(result.currentSpeed);
}

function executionText(value) {
  if(!value || value.mode!=='workspace-agent' || value.translationComplete)return '';
  if(value.errorCode==='execution_record_unavailable')return '자동 실행 기록을 확인하지 못했습니다. 저장된 자막 수신은 계속됩니다.';
  if(value.errorCode==='configuration_changed'||value.errorCode==='configuration_unavailable'||value.errorCode==='prompt_changed')return '자동 연결 설정이 변경됐습니다. 기존 실행 기록은 보존됐습니다.';
  if(value.errorCode==='unauthorized'||value.errorCode==='forbidden')return '자동 번역 연결의 인증·권한을 확인해야 합니다.';
  if(value.resultPending)return '에이전트 실행 종료 · 자막 전편 확정은 아직 확인되지 않았습니다.';
  const text={queued:'자동 번역 요청이 접수됐습니다. 첫 구간을 기다리는 중입니다.',in_progress:'자동 번역 진행 중 · 준비된 자막부터 받습니다.',suspended:'자동 번역 실행이 외부 작업을 기다리고 있습니다.',submitted:'자동 번역 요청 접수 · 자막 수신 대기 중입니다.',completed:'에이전트 실행 종료 · 자막 확정 대기 중입니다.',uncertain:'자동 요청의 접수 여부를 확인하지 못했습니다. 다시 누르면 같은 요청으로 재확인합니다.',failed:'자동 번역 실행 실패 · 원문과 수신한 자막은 보존됐습니다.'};
  return text[value.state]||'';
}
async function refreshExecution() {
  const key=currentState.media?.key;if(!key || openingTranslation)return;
  try {const run=await chrome.runtime.sendMessage({action:'getTranslationExecution',mediaKey:key});if(currentState.media?.key===key){if(run?.execution)currentExecution=run.execution;render();}}catch{}
}

function renderSpeed(speed) {
  $('speed-value').textContent = speed.toFixed(2).replace(/\.?0+$/, '');
  $('speed-slider').value = speed;
  for (const button of document.querySelectorAll('.preset-btn')) button.classList.toggle('active', Number(button.dataset.speed) === speed);
}

async function setSpeed(speed) {
  try {
    const result = await chrome.tabs.sendMessage(currentTabId, { action: 'setSpeed', speed });
    if (!result || result.error) throw new Error(result?.error || '영상 탭을 새로고침해 주세요.');
    render(result);
    $('error').textContent = '';
  } catch (error) { $('error').textContent = error.message; }
}

$('speed-slider').addEventListener('input', event => { renderSpeed(Number(event.target.value)); void setSpeed(Number(event.target.value)); });
for (const button of document.querySelectorAll('.preset-btn')) button.addEventListener('click', () => void setSpeed(Number(button.dataset.speed)));
$('reset-btn').addEventListener('click', () => void setSpeed(1));
$('workspace-btn').addEventListener('click', async () => {
  if (!Number.isInteger(currentTabId)) return;
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('subtitles/workspace.html')}?tabId=${currentTabId}` });
  window.close();
});
$('library-btn').addEventListener('click',async()=>{await chrome.tabs.create({url:chrome.runtime.getURL('subtitles/library.html')});window.close();});
$('translate-btn').addEventListener('click', async () => {
  if (!Number.isInteger(currentTabId) || openingTranslation) return;
  openingTranslation = true;render();
  $('error').textContent='';$('copy-prompt').hidden=true;
  $('copy-status').textContent='영어 전편·번역 작업 준비 중… 요청이 끝날 때까지 팝업을 열어 두세요.';
  try {
    await ensureRuntime();
    const source=await chrome.runtime.sendMessage({action:'prepareTranslationSource',tabId:currentTabId});
    if(!source || source.error)throw new Error(source?.error || '원문을 준비하지 못했습니다.');
    const paired=await bridgePost('/pair',{client:'OTTSpeed'});
    if(!paired.token)throw new Error('브리지 연결 토큰이 없습니다.');
    await chrome.storage.local.set({ottspeedBridge:{token:paired.token}});
    const job=await bridgePost('/jobs',source,paired.token);
    const watched=await chrome.runtime.sendMessage({action:'watchTranslation',tabId:currentTabId,jobId:job.jobId,mediaKey:source.media.key});
    if(!watched || watched.error)throw new Error(watched?.error || '번역 결과 수신을 준비하지 못했습니다.');
    const execution=await bridgePost(`/jobs/${job.jobId}/start`,{},paired.token);
    if(execution.mode==='workspace-agent') {
      currentExecution=execution;
      $('copy-status').textContent='';
      return;
    }
    if(execution.mode==='complete') {
      $('copy-status').textContent='이 회차의 전편 B 번역이 이미 준비됐습니다.';
      return;
    }
    const prompt=OTTBridgeClient.prompt({...job,media:source.media});
    $('copy-prompt').value=prompt;
    try {await navigator.clipboard.writeText(prompt);}
    catch { $('copy-prompt').hidden=false;throw new Error('클립보드에 복사하지 못했습니다. 아래 프롬프트를 직접 복사하세요.'); }
    $('copy-status').textContent='프롬프트 복사 완료 · ChatGPT의 OTTSpeed 앱에 붙여넣어 보내세요. 이 팝업은 닫아도 됩니다.';
  } catch(error) { $('copy-status').textContent='';$('error').textContent=error.message; }
  finally {openingTranslation=false;render();}
});
// Writes originate from this visible extension page; background requests remain GET-only.
async function bridgePost(path,body,token) { return bridgeHttp('/extension'+path,{body,token}); }
$('play-translated-btn').addEventListener('click', async () => {
  if ($('play-translated-btn').disabled) return;
  try {
    const result=await chrome.tabs.sendMessage(currentTabId,{action:'playTranslationFromStart',mediaKey:currentState.media?.key,requestId:currentState.subtitles?.translation?.requestId});
    if(!result || result.error) throw new Error(result?.error || '현재 영상의 번역 준비 상태를 다시 확인하세요.');
    render(result);$('error').textContent='';window.close();
  } catch(error) {$('error').textContent=error.message;}
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && sender.tab?.id === currentTabId && message?.action === 'videoStateChanged') render(message);
  return false;
});

(async () => {
  void ensureRuntime().catch(()=>{});
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;
    const result = await chrome.tabs.sendMessage(currentTabId, { action: 'checkVideo' });
    if (result?.error) throw new Error(result.error);
    render(result);
    await refreshExecution();
  } catch { render({hasVideo:false}); }
})();
setInterval(async()=> {
  if(!Number.isInteger(currentTabId)) return;
  try {const result=await chrome.tabs.sendMessage(currentTabId,{action:'checkVideo'});if(!result?.error) render(result);else render({hasVideo:false});}
  catch {render({hasVideo:false});}
  await refreshExecution();
},1000);
