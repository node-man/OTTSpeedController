import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeEnvironment } from './dom.mjs';

const popupScript = await readFile(new URL('../../popup/popup.js', import.meta.url), 'utf8');
const backgroundScript = await readFile(new URL('../../scripts/background.js', import.meta.url), 'utf8');
const backgroundModules = new Map(await Promise.all(["shared/product.js","modules/app/senders.js","modules/app/message-router.js","modules/runtime/background.js","modules/translation/background.js","modules/capture/background.js","modules/playback/background.js","modules/app/background.js","modules/library/mcp-registration.js"].map(async path=>[path,await readFile(new URL('../../'+path,import.meta.url),'utf8')])));
const sharedTransport=await readFile(new URL('../../modules/runtime/bridge-http.js',import.meta.url),'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = [];
  return { listeners, addListener: listener => listeners.push(listener), emit: (...args) => Promise.all(listeners.map(listener => listener(...args))) };
}

async function popup({ activeTab = { id: 7 }, state = { hasVideo: true, isPlaying: true, currentSpeed: 1.5 }, copyError=false, bridgeError=false,launchReply={mode:'copy'},runtimeReply={ready:true} } = {}) {
  const env = await makeEnvironment(); const { document, context } = env;
  for (const id of ['main-content', 'no-video', 'workspace-btn', 'library-btn', 'translate-btn', 'copy-status', 'copy-prompt', 'play-translated-btn', 'translation-status', 'execution-status', 'status', 'speed-value', 'speed-slider', 'error', 'reset-btn', 'runtime-connect-btn', 'runtime-status']) {
    const element = document.createElement('div'); element.id = id; document.body.appendChild(element);
  }
  const status = document.createElement('span'); status.className = 'status-text'; document.body.appendChild(status);
  const preset = document.createElement('button'); preset.className = 'preset-btn'; preset.dataset = { speed: '1.5' }; document.body.appendChild(preset);
  const messages = []; const created = [];const intervals=[],copied=[],requests=[],runtimeMessages=[];
  context.navigator={clipboard:{writeText:async text=>{if(copyError)throw new Error('denied');copied.push(text);}}};
  context.OTTBridgeClient={prompt:job=>`synthetic prompt ${job.jobId} ${job.media.key}`};
  context.AbortController=AbortController;
  context.TypeError=TypeError;
  context.setTimeout=setTimeout;context.clearTimeout=clearTimeout;
  context.fetch=async(url,options)=>{requests.push({url,options});if(bridgeError)throw new TypeError('offline');return {ok:true,json:async()=>url.endsWith('/pair')?{token:'synthetic-token'}:url.endsWith('/start')?launchReply:{jobId:'synthetic-job'}};};
  context.setInterval=fn=>{intervals.push(fn);return intervals.length;};
  const onMessage = event();
  context.window = { close() {} };
  context.chrome = {
    tabs: {
      query: async () => activeTab ? [activeTab] : [],
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        if (!Number.isInteger(tabId)) throw new Error('No tab with id');
        return state;
      },
      create: async options => created.push(options)
    },
    storage:{local:{set:async()=>{}}},
    runtime: { id: 'synthetic-extension', onMessage, getURL: path => `chrome-extension://synthetic/${path}`,sendMessage:async message=>{runtimeMessages.push(message);return message.action==='ensureLocalRuntime'?runtimeReply:message.action==='getTranslationExecution'?null:message.action==='prepareTranslationSource'?{media:state.media,source:{cues:[]}}:{jobId:message.jobId};} }
  };
  vm.runInContext(backgroundModules.get('shared/product.js'),context);vm.runInContext(sharedTransport,context);
  vm.runInContext(popupScript, context, { filename: 'popup/popup.js' });
  await settle();
  return { ...env, status, preset, messages, created, onMessage,intervals,copied,requests,runtimeMessages };
}

test('popup copies the fixed-job prompt without opening tabs, then enables explicit prefix playback',async()=>{
  const state={hasVideo:true,isPlaying:false,currentSpeed:1,media:{key:'netflix:101',platform:'netflix'},subtitles:{settings:{enabled:true,activeTarget:'b'},translation:null}};
  const f=await popup({state});
  const el=id=>f.document.getElementById(id);
  assert.equal(el('play-translated-btn').disabled,true);
  el('translate-btn').dispatchEvent('click');await settle();
  assert.equal(f.created.length,0);
  assert.deepEqual(f.copied,['synthetic prompt synthetic-job netflix:101']);
  assert.match(el('copy-status').textContent,/복사 완료/);
  assert(f.runtimeMessages.some(m=>m.action==='prepareTranslationSource'));
  assert(f.runtimeMessages.some(m=>m.action==='watchTranslation'));
  assert.equal(f.requests[1].options.headers.Authorization,'Bearer synthetic-token');
  assert.equal(f.requests[1].options.method,'POST');
  assert(!f.messages.some(m=>m.message.action==='playTranslationFromStart'));
  state.subtitles.translation={requestId:'synthetic-job',partial:true,readyCueCount:150,totalCueCount:1831,readyThroughMs:184000};
  await f.intervals[0]();
  assert.equal(el('play-translated-btn').disabled,false);
  assert.match(el('translation-status').textContent,/03:04/);
  el('play-translated-btn').dispatchEvent('click');await settle();
  const play=f.messages.find(m=>m.message.action==='playTranslationFromStart');
  assert.deepEqual(structuredClone(play),{tabId:7,message:{action:'playTranslationFromStart',mediaKey:'netflix:101',requestId:'synthetic-job'}});
});

test('configured official execution submits the fixed job without tabs or clipboard, and unknown outcomes never fall back to another submission',async()=>{
  const state={hasVideo:true,media:{key:'netflix:101',platform:'netflix'}};
  for(const execution of [{mode:'workspace-agent',state:'queued'}, {mode:'workspace-agent',state:'uncertain',retryable:true},
    {mode:'workspace-agent',state:'completed',resultPending:true},{mode:'complete',translationComplete:true}]) {
    const f=await popup({state,launchReply:execution});f.document.getElementById('translate-btn').dispatchEvent('click');await settle();
    assert.equal(f.created.length,0);assert.equal(f.copied.length,0);
    const start=f.requests.find(r=>r.url.endsWith('/synthetic-job/start'));assert(start);assert.equal(start.options.body,'{}');
    const text=f.document.getElementById('execution-status').textContent;
    if(execution.state==='queued')assert.match(text,/접수/);
    if(execution.state==='uncertain')assert.match(text,/접수 여부/);
    if(execution.resultPending){assert.match(text,/아직/);assert(!/번역.*완료/.test(text));}
  }
});

test('copy and bridge failures are visible and do not launch another page',async()=>{
  const state={hasVideo:true,media:{key:'netflix:101',platform:'netflix'}};
  const f=await popup({state,copyError:true});
  f.document.getElementById('translate-btn').dispatchEvent('click');await settle();
  assert.equal(f.document.getElementById('copy-prompt').hidden,false);
  assert.match(f.document.getElementById('error').textContent,/직접 복사/);
  assert.equal(f.created.length,0);
  const offline=await popup({state,bridgeError:true});
  offline.document.getElementById('translate-btn').dispatchEvent('click');await settle();
  assert.match(offline.document.getElementById('error').textContent,/브리지를 실행/);
  assert.equal(offline.copied.length,0);assert.equal(offline.created.length,0);
});

test('popup ignores other tabs and extensions while accepting its selected video tab', async () => {
  const f = await popup();
  assert.equal(f.document.getElementById('speed-value').textContent, '1.5');
  assert.equal(f.status.textContent, '재생 중');
  const message = { action: 'videoStateChanged', hasVideo: false, isPlaying: false, currentSpeed: 3 };
  await f.onMessage.emit(message, { id: 'synthetic-extension', tab: { id: 8 } });
  await f.onMessage.emit(message, { id: 'other-extension', tab: { id: 7 } });
  assert.equal(f.document.getElementById('speed-value').textContent, '1.5');
  assert.equal(f.status.textContent, '재생 중');
  await f.onMessage.emit(message, { id: 'synthetic-extension', tab: { id: 7 } });
  assert.equal(f.status.textContent, '비디오 없음');
  assert.equal(f.document.getElementById('workspace-btn').disabled, true);
});

test('popup workspace links bind to the selected tab and missing tabs disable controls', async () => {
  const f = await popup();
  f.document.getElementById('workspace-btn').dispatchEvent('click'); await settle();
  assert.equal(f.created[0].url, 'chrome-extension://synthetic/subtitles/workspace.html?tabId=7');
  const missing = await popup({ activeTab: null });
  assert.equal(missing.document.getElementById('main-content').hidden, true);
  assert.equal(missing.document.getElementById('workspace-btn').disabled, true);
  missing.document.getElementById('library-btn').dispatchEvent('click');await settle();
  assert.equal(missing.created[0].url,'chrome-extension://synthetic/subtitles/library.html');
});

function background({ storedSession = null, liveState = { hasVideo: true, isPlaying: true } } = {}) {
  const actionCalls = []; const queried = []; const stored = {}; const libraryKeys = [];const collections=[],runtimeCalls=[];
  const chrome = {
    runtime: { id: 'synthetic-extension', onMessage: event(), onInstalled: event(),onStartup:event(),getURL:path=>`chrome-extension://synthetic/${path}` },
    alarms:{onAlarm:event(),create:async()=>{}},
    action: Object.fromEntries(['setIcon', 'setBadgeText', 'setTitle'].map(name => [name, async value => actionCalls.push({ name, value })])),
    tabs: {
      onRemoved: event(), onUpdated: event(), onActivated: event(),
      sendMessage: async (tabId, message) => { queried.push({ tabId, message }); return liveState; }
    },
    storage: { local: { set: async value => Object.assign(stored, value) } }
  };
  const context = vm.createContext({
    chrome, importScripts(...paths) {for(const path of paths){const code=backgroundModules.get(path.replace('../',''));if(code)vm.runInContext(code,context,{filename:path});}}, OTTSubtitles:{},OTTSubtitleCatalog:{},OTTBridgeClient:{},OTTCaptureValidation:{},
    OTTLocalRuntime:()=>({ensure:async()=>{runtimeCalls.push('ensure');return {ready:true};},status:async()=>{runtimeCalls.push('status');return {ready:false};}}),
    OTTCollectionQueue:()=>({initialize:async()=>{},tick:async()=>{},removed:async()=>{},status:async()=>({version:1,entries:[]}),...Object.fromEntries(['enqueue','pause','resume','cancel'].map(name=>[name,async value=>{collections.push({name,value});return {version:1,entries:[]};}]))}),
    OTTTranslationWorker:()=>({initialize:async()=>{},observe:async()=>{},removed:async()=>{},prepareSource:async tabId=>({tabId}),watch:async tabId=>({tabId}),status:async()=>null,refreshStored:async()=>({saved:true}),poll:async()=>{}}),
    OTTSubtitleLibrary: { get: async key => { libraryKeys.push(key); return storedSession; } }
  });
  vm.runInContext(backgroundScript, context, { filename: 'scripts/background.js' });
  const send = (message, sender = { id: chrome.runtime.id, tab: { id: 0 } }) => new Promise(resolve => {
    const handled = chrome.runtime.onMessage.listeners.map(listener => listener(message, sender, resolve)).some(result => result === true);
    if (!handled) resolve({ unhandled: true });
  });
  return { chrome, actionCalls, queried, stored, libraryKeys, send,collections,runtimeCalls };
}

test('only exact extension management pages can start the local runtime; page payloads cannot forward commands',async()=>{
  const f=background();
  for(const path of ['popup/popup.html','subtitles/library.html','subtitles/workspace.html?tabId=7']) {
    assert.equal((await f.send({action:'ensureLocalRuntime',command:'ignored'}, {id:'synthetic-extension',url:`chrome-extension://synthetic/${path}`})).ready,true);
  }
  for(const sender of [
    {id:'other-extension',url:'chrome-extension://synthetic/popup/popup.html'},
    {id:'synthetic-extension',url:'https://www.netflix.com/watch/101',tab:{id:7}},
    {id:'synthetic-extension',url:'chrome-extension://synthetic/subtitles/workspace.html?tabId=7&command=evil'},
    {id:'synthetic-extension',url:'chrome-extension://synthetic/subtitles/library.html?foreign=1'}
  ])assert.equal((await f.send({action:'ensureLocalRuntime'},sender)).unhandled,true);
  assert.equal(f.runtimeCalls.length,3);
  await f.chrome.runtime.onStartup.emit();assert.equal(f.runtimeCalls.length,4);
});

test('popup starts the connection without a video and blocks translation preparation on startup failure',async()=>{
  const f=await popup({activeTab:null});
  assert.match(f.document.getElementById('runtime-status').textContent,/준비됨/);
  f.document.getElementById('runtime-connect-btn').dispatchEvent('click');await settle();
  assert.equal(f.runtimeMessages.filter(m=>m.action==='ensureLocalRuntime').length,2);
  assert.equal(f.created.length,0);
  const bad=await popup({state:{hasVideo:true,media:{key:'netflix:101',platform:'netflix'}},runtimeReply:{error:'도우미 설치 필요'}});
  bad.document.getElementById('translate-btn').dispatchEvent('click');await settle();
  assert.match(bad.document.getElementById('error').textContent,/도우미/);
  assert(!bad.runtimeMessages.some(m=>m.action==='prepareTranslationSource'));
  assert.equal(bad.requests.length,0);assert.equal(bad.copied.length,0);
});

test('a fresh MV3 worker recovers active-tab icon state from the live content script', async () => {
  const f = background();
  await f.chrome.tabs.onActivated.emit({ tabId: 0 });
  assert.equal(f.queried.length, 1); assert.equal(f.queried[0].message.action, 'checkVideo');
  const icon = f.actionCalls.find(call => call.name === 'setIcon');
  assert.equal(icon.value.tabId, 0); assert.equal(icon.value.path['16'], 'icons/icon-16.png');
  assert.equal(f.actionCalls.find(call => call.name === 'setTitle').value.title, 'OTTDeck · 재생 중');
});

test('worker loads durable display data and rejects messages from unrelated senders', async () => {
  const session = {
    mediaKey: 'netflix:synthetic', tracks: { source: null, a: null, b: null }, settings: { enabled: true },
    pendingRequest: { requestId: 'not-needed-in-content-script' }
  };
  const f = background({ storedSession: session });
  const response = await f.send({ action: 'getSubtitleSession', mediaKey: session.mediaKey });
  assert.equal(response.session.mediaKey, session.mediaKey);
  assert.equal(response.session.pendingRequest, undefined);
  assert.equal(f.libraryKeys.length, 1);
  await f.send({ action: 'getSubtitleSession', mediaKey: session.mediaKey }, { id: 'other-extension', tab: { id: 0 } });
  await f.send({ action: 'getSubtitleSession', mediaKey: session.mediaKey }, { id: 'synthetic-extension' });
  assert.equal(f.libraryKeys.length, 1);
});

test('extension updates preserve speed preferences while initial installation sets the default', async () => {
  const f = background(); f.stored.speed = 1.75;
  await f.chrome.runtime.onInstalled.emit({ reason: 'update' });
  assert.equal(f.stored.speed, 1.75);
  await f.chrome.runtime.onInstalled.emit({ reason: 'install' });
  assert.equal(f.stored.speed, 1);
});

test('only the extension popup can request source preparation or background watching',async()=>{
  const f=background(),message={action:'prepareTranslationSource',tabId:7};
  assert.equal((await f.send(message,{id:'synthetic-extension',url:'chrome-extension://synthetic/popup/popup.html'})).tabId,7);
  for(const sender of [{id:'other-extension',url:'chrome-extension://synthetic/popup/popup.html'},
    {id:'synthetic-extension',url:'https://www.netflix.com/watch/101',tab:{id:7}},
    {id:'synthetic-extension',url:'chrome-extension://synthetic/subtitles/workspace.html'}]) {
    assert.equal((await f.send(message,sender)).unhandled,true);
  }
});

test('the library can watch fixed jobs and refresh saved data, but cannot request video capture',async()=>{
  const f=background(),sender={id:'synthetic-extension',url:'chrome-extension://synthetic/subtitles/library.html',tab:{id:9}};
  assert.equal((await f.send({action:'watchLibraryTranslation',jobId:'fixed',mediaKey:'netflix:101'},sender)).tabId,null);
  assert.equal((await f.send({action:'refreshLibrarySession',mediaKey:'netflix:101'},sender)).saved,true);
  assert.equal((await f.send({action:'prepareTranslationSource',tabId:7},sender)).unhandled,true);
  assert.equal((await f.send({action:'watchLibraryTranslation',jobId:'fixed',mediaKey:'netflix:101'},{...sender,url:'https://evil.example'})).unhandled,true);
});

test('only the exact owned library may add, pause or cancel background collection',async()=>{
  const f=background(),sender={id:'synthetic-extension',url:'chrome-extension://synthetic/subtitles/library.html'};
  for(const action of ['enqueueCollection','pauseCollection','resumeCollection','cancelCollection']){
    assert.equal((await f.send({action,urls:['123'],id:'entry'},sender)).version,1);
    for(const other of [{...sender,id:'other-extension'},{...sender,url:'https://www.netflix.com/watch/123',tab:{id:7}},{...sender,url:'chrome-extension://synthetic/popup/popup.html'},{...sender,url:sender.url+'?foreign=1'}])assert.equal((await f.send({action,urls:['124'],id:'entry'},other)).unhandled,true);
  }
  assert.equal(f.collections.length,4);
});
