/* Authenticated headless experiment, explicitly separate from the user's browser.
 * Normal Netflix login only. Never imports cookies, passwords or another profile.
 * Reuses the existing MAIN collector and independent whole-file inspector. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,open,unlink,realpath} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DOMParser} from '@xmldom/xmldom';
import core from '../subtitles/core.js';
import validation from '../subtitles/capture-validation.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const setup=args.includes('--setup')||args.includes('--setup-and-capture');
const capture=!args.includes('--setup')||args.includes('--setup-and-capture');
const videoId=option('--video-id')||'70262107';
assert(/^\d{1,15}$/.test(videoId),'Invalid Netflix video ID.');
const home=join(root,'private-subtitles','headless-auth'),profile=join(home,'profile');
const stateFile=join(home,'profile-state.json'),lockFile=join(home,'runner.lock');
await mkdir(home,{recursive:true});
// This tool can only operate its own dedicated profile, never Chrome's default.
const actualHome=await realpath(home),privateRoot=await realpath(join(root,'private-subtitles'));
const rel=relative(privateRoot,actualHome);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Unsafe profile directory.');
await mkdir(profile,{recursive:true});
assert.equal(await realpath(profile),join(actualHome,'profile'),'Linked profile directory is not allowed.');
const run=join(home,'runs',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
await mkdir(run,{recursive:true});
const report={startedAt:new Date().toISOString(),videoId,profileIsDedicated:true,existingUserProfileUsed:false,cookiesImported:false,setupLoginConfirmed:false,authenticatedHeadlessConfirmed:false,manifestReceived:false,fullSubtitleFileAcquired:false,phase:'initializing',outputDirectory:run};
const emit=phase=>{report.phase=phase;console.log(JSON.stringify({phase,outputDirectory:run}));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let context,lock;
try {
  lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:report.startedAt}));
  const runtime=option('--runtime-root')||process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules');
  const require=createRequire(import.meta.url),{chromium}=require(require.resolve('playwright',{paths:[root,runtime]}));
  const executablePath=option('--chrome')||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  // Use normal Chrome defaults: the automation library otherwise disables
  // component updates and changes protected browser features. Keep our own
  // profile and pipe explicit when ignoring those defaults.
  const launch=headless=>chromium.launchPersistentContext(profile,{executablePath,headless,chromiumSandbox:true,
    ignoreDefaultArgs:true,viewport:{width:1280,height:900},
    args:[`--user-data-dir=${profile}`,'--remote-debugging-pipe',...(headless?['--headless']:[]),
      '--no-first-run','--no-default-browser-check','--window-size=1280,900','about:blank'],timeout:30000});
  async function authenticated(page){
    if(new URL(page.url()).hostname!=='www.netflix.com')return false;
    // Visible member navigation, rather than a cookie or hidden account object.
    return /^\/browse(?:\/|$)/.test(new URL(page.url()).pathname)&&await page.locator('a[href="/browse/my-list"]').isVisible().catch(()=>false);
  }
  if(setup){
    emit('opening_dedicated_login_window');context=await launch(false);
    const page=context.pages()[0]||await context.newPage();
    await page.goto('https://www.netflix.com/login',{waitUntil:'domcontentloaded',timeout:30000});
    await page.screenshot({path:join(run,'login-window.png')});
    emit('awaiting_manual_login_and_profile_selection');
    const deadline=Date.now()+10*60*1000;
    while(Date.now()<deadline&&!await authenticated(page)){
      if(page.isClosed())throw new Error('setup_window_closed');
      await sleep(1000);
    }
    if(!await authenticated(page))throw new Error('setup_login_timeout');
    report.setupLoginConfirmed=true;
    await writeFile(stateFile,JSON.stringify({kind:'ottspeed.headless-profile',version:1,loginObservedAt:new Date().toISOString()},null,2)+'\n');
    emit('dedicated_login_confirmed');await context.close();context=null;
  }
  if(capture){
    const state=JSON.parse(await readFile(stateFile,'utf8').catch(()=>'{"kind":"missing"}'));
    if(state.kind!=='ottspeed.headless-profile'||state.version!==1)throw new Error('dedicated_profile_not_authenticated');
    emit('launching_authenticated_headless');context=await launch(true);
    report.browserVersion=context.browser()?.version()||null;
    report.headlessRequested=true;report.observer='existing-netflix-main.js';report.ottspeedExtensionLoaded=false;
    const observer=(await Promise.all(['core.js','netflix.js','netflix-main.js'].map(f=>readFile(join(root,'subtitles',f),'utf8')))).join('\n;\n');
    await context.addInitScript({content:`if(location.hostname==='www.netflix.com'){\n${observer}\n}`});
    const page=context.pages()[0]||await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto('https://www.netflix.com/browse',{waitUntil:'domcontentloaded',timeout:30000});
    const gateDeadline=Date.now()+15000;
    while(!await authenticated(page)&&Date.now()<gateDeadline)await sleep(500);
    if(!await authenticated(page)){
      await page.screenshot({path:join(run,'headless-auth-gate.png')});throw new Error('headless_login_not_confirmed');
    }
    report.authenticatedHeadlessConfirmed=true;emit('authenticated_headless_confirmed');
    report.chromeDefaultsRestored=true;
    async function mediaCapability(){return page.evaluate(async()=>{
      if(typeof navigator.requestMediaKeySystemAccess!=='function')return {apiAvailable:false,widevineAvailable:false};
      try{await navigator.requestMediaKeySystemAccess('com.widevine.alpha',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]}]);return {apiAvailable:true,widevineAvailable:true};}catch(error){return {apiAvailable:true,widevineAvailable:false,errorName:error.name};}
    });}
    report.mediaCapability=await mediaCapability();
    if(!report.mediaCapability.widevineAvailable){
      emit('waiting_for_normal_chrome_component_initialization');
      const warmupDeadline=Date.now()+60000;
      while(!report.mediaCapability.widevineAvailable&&Date.now()<warmupDeadline){await sleep(5000);report.mediaCapability=await mediaCapability();}
    }
    await page.goto(`https://www.netflix.com/watch/${videoId}`,{waitUntil:'domcontentloaded',timeout:30000});
    async function request(action,trackId){return page.evaluate(({videoId,action,trackId})=>new Promise((resolve,reject)=>{
      const nonce=crypto.randomUUID(),timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(new Error('collector_timeout'));},25000);
      function receive(event){if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='ottspeed-netflix-result'||event.data.nonce!==nonce)return;clearTimeout(timer);window.removeEventListener('message',receive);event.data.error?reject(new Error('collector_returned_error')):resolve(event.data.result);}
      window.addEventListener('message',receive);window.postMessage({channel:'ottspeed-netflix-request',nonce,videoId,action,trackId},location.origin);
    }),{videoId,action,trackId});}
    const deadline=Date.now()+90000;let listing;
    emit('waiting_for_actual_manifest');
    while(Date.now()<deadline){
      const body=await page.locator('body').innerText();
      report.visibleErrorCodes=[...new Set(body.match(/\b(?:M\d{4}(?:-\d+)?|NSES-\d{3})\b/g)||[])];
      if(new URL(page.url()).pathname.startsWith('/login'))throw new Error('login_required');
      listing=await request('list');report.collectorDiagnostic=listing.diagnostic;
      report.manifestReceived=Boolean(listing.observedAt);
      if(listing.tracks?.length)break;
      if(report.visibleErrorCodes.length)throw new Error('netflix_player_error');
      await sleep(2000);
    }
    if(!listing?.tracks?.length)throw new Error('manifest_timeout');
    report.manifestReceived=true;report.englishTrackCount=listing.tracks.length;
    const chosen=listing.tracks.find(t=>t.rawTrackType==='closedcaptions')||listing.tracks[0];
    assert(/^en(?:-|$)/i.test(chosen.language),'English track required.');
    emit('downloading_actual_english_text_resource');
    const result=await request('capture',chosen.id),media=core.mediaIdentity(`https://www.netflix.com/watch/${videoId}`);
    report.independentInspection=await validation.resource(result,media,DOMParser);
    const captureFile=join(run,'capture.received.json');
    await writeFile(captureFile,JSON.stringify({kind:'ottspeed.netflix-capture',schemaVersion:1,mediaKey:media.key,media,track:result.track,rawText:result.rawText},null,2)+'\n',{flag:'wx'});
    emit('independent_whole_file_audit');
    const output=execFileSync(process.execPath,[join(root,'scripts','inspect-netflix-capture.mjs'),captureFile,join(run,'verified'),videoId],{encoding:'utf8',maxBuffer:1024*1024,windowsHide:true});
    const audit=JSON.parse(output);
    assert(audit.fullEpisodeResourceAcquired&&audit.independentByteHashVerified&&audit.independentReparseMatches&&audit.excludedCount===0,'Whole-file verification did not pass.');
    report.fullSubtitleFileAcquired=true;report.audit=audit;report.phase='verified_whole_english_subtitle';
    await page.screenshot({path:join(run,'headless-capture-result.png')});
  }else report.phase='setup_complete';
}catch(error){
  // Never echo browser launch arguments, account inputs, session data or text.
  const known=new Set(['setup_window_closed','setup_login_timeout','dedicated_profile_not_authenticated','headless_login_not_confirmed','netflix_player_error','login_required','manifest_timeout','collector_timeout','collector_returned_error']);
  report.errorCode=known.has(error.message)?error.message:error.code==='EEXIST'?'profile_runner_already_open':error.name==='TimeoutError'?'browser_timeout':'experiment_failed';
  report.failedPhase=report.phase;report.phase='not_verified';
  if(context){const page=context.pages()[0];if(page&&!page.isClosed())await page.screenshot({path:join(run,'not-verified.png')}).catch(()=>{});}
  process.exitCode=2;
}finally{
  if(context)await context.close().catch(()=>{});
  if(lock){await lock.close();await unlink(lockFile);}
  report.finishedAt=new Date().toISOString();await writeFile(join(run,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
