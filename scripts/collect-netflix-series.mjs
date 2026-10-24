/* Netflix's rendered episode list -> one dedicated headless collector -> durable
 * independent audits. No connection or commands to the user's Chrome tabs. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DOMParser} from '@xmldom/xmldom';
import core from '../subtitles/core.js';
import validation from '../subtitles/capture-validation.js';
import {root,openDedicatedBrowser,sleep} from './netflix-headless-browser.mjs';
import {validateInventory,createQueue,validateQueue,readJson,atomicJson,saveQueue,queueSummary} from './netflix-series-queue.mjs';

const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?null:args[i+1];};
const home=join(root,'private-subtitles','series-capture','west-wing');
const seriesId='70157152',series='The West Wing',detailUrl=`https://www.netflix.com/search?q=The%20West%20Wing&jbv=${seriesId}`;
const limit=option('--limit')===null?Infinity:Number(option('--limit'));assert(limit===Infinity||Number.isSafeInteger(limit)&&limit>0);
await mkdir(home,{recursive:true});
let browser,queue;const execution={startedAt:new Date().toISOString(),phase:'opening_dedicated_browser'};
const emit=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
async function discover(page){
  emit({phase:'discovering_rendered_season_list'});
  await page.goto(detailUrl,{waitUntil:'domcontentloaded',timeout:30000});
  const dropdown=()=>page.getByRole('button',{name:'dropdown-menu-trigger-button',exact:true});
  await dropdown().waitFor({state:'visible'});await dropdown().click();
  const menu=await page.locator('li[data-uia="dropdown-menu-item"]').evaluateAll(nodes=>nodes.map(n=>({label:n.innerText,index:n.getAttribute('data-index')})));
  const seasons=menu.flatMap(item=>{const match=/시즌\s+(\d+)[\s\S]*?\((\d+)개 에피소드\)/.exec(item.label);return match?[{season:Number(match[1]),expectedCount:Number(match[2]),menuIndex:item.index,episodes:[]}]:[];});
  assert(seasons.length>0,'No rendered season list.');await dropdown().click();
  const inventory={kind:'ottspeed.netflix-series-inventory',version:1,seriesId,series,discoveredAt:new Date().toISOString(),basis:'Rendered Netflix season menu, episode titles, episode numbers and video_id tracking attributes on episode cards; no internal catalog API or sequential-ID inference.',seasons};
  for(const season of seasons){
    await dropdown().click();await page.locator(`li[data-uia="dropdown-menu-item"][data-index="${season.menuIndex}"]`).click();
    await page.getByRole('heading',{name:'회차',exact:true}).scrollIntoViewIfNeeded();
    const expand=page.getByRole('button',{name:'expand section',exact:true}).first();
    if(await expand.isVisible())await expand.click();
    await page.waitForFunction(expected=>document.querySelectorAll('.episodeSelector-container .episode-item').length===expected,season.expectedCount,{timeout:20000});
    season.episodes=await page.locator('.episodeSelector-container .episode-item').evaluateAll((nodes,season)=>nodes.map(n=>{
      const candidates=[...n.querySelectorAll('[data-ui-tracking-context]')].map(e=>{try{return JSON.parse(decodeURIComponent(e.getAttribute('data-ui-tracking-context'))).video_id;}catch{return null;}}).filter(Boolean).map(String);
      return {season,episode:Number(n.querySelector('.titleCard-title_index')?.textContent),title:n.querySelector('.titleCard-title_text')?.textContent.trim()||'',videoId:new Set(candidates).size===1?candidates[0]:'',observedAt:new Date().toISOString()};
    }),season.season);
    await atomicJson(join(home,`season-${season.season}.json`),season);
    emit({phase:'season_discovered',season:season.season,count:season.episodes.length,last:season.episodes.at(-1)?.title});
  }
  validateInventory(inventory);await atomicJson(join(home,'inventory.json'),inventory);await page.screenshot({path:join(home,'last-season-list.png')});return inventory;
}
async function inspect(captureFile,out,videoId){
  const capture=await readJson(captureFile),media=core.mediaIdentity(`https://www.netflix.com/watch/${videoId}`);
  assert.equal(capture.mediaKey,media.key);await validation.resource({track:capture.track,rawText:capture.rawText},media,DOMParser);
  const audit=JSON.parse(execFileSync(process.execPath,[join(root,'scripts','inspect-netflix-capture.mjs'),captureFile,out,videoId],{encoding:'utf8',maxBuffer:1024*1024,windowsHide:true}));
  assert(audit.fullEpisodeResourceAcquired&&audit.independentByteHashVerified&&audit.independentReparseMatches&&audit.excludedCount===0);
  return {directory:out,captureFile:join(out,'capture.original.json'),auditFile:join(out,'capture-audit.json'),vttFile:join(out,'netflix.en.vtt'),cueCount:audit.acceptedCount,resourceSha256:audit.resourceSha256,resourceBytes:audit.resourceBytes,startMs:audit.startMs,endMs:audit.endMs,verifiedAt:new Date().toISOString()};
}
async function request(page,videoId,action,trackId){return page.evaluate(({videoId,action,trackId})=>new Promise((resolve,reject)=>{
  const nonce=crypto.randomUUID(),timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(new Error('collector_timeout'));},25000);
  function receive(event){if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='ottspeed-netflix-result'||event.data.nonce!==nonce)return;clearTimeout(timer);window.removeEventListener('message',receive);event.data.error?reject(new Error('collector_returned_error')):resolve(event.data.result);}
  window.addEventListener('message',receive);window.postMessage({channel:'ottspeed-netflix-request',nonce,videoId,action,trackId},location.origin);
}),{videoId,action,trackId});}
async function capture(entry,out){
  const page=await browser.context.newPage();page.setDefaultTimeout(10000);
  try{
    await page.goto(`https://www.netflix.com/watch/${entry.videoId}`,{waitUntil:'domcontentloaded',timeout:30000});
    let listing;const deadline=Date.now()+90000;
    while(Date.now()<deadline){
      if(new URL(page.url()).pathname.startsWith('/login'))throw new Error('login_required');
      const text=await page.locator('body').innerText(),codes=[...new Set(text.match(/\b(?:M\d{4}(?:-\d+)?|NSES-\d{3})\b/g)||[])];
      listing=await request(page,entry.videoId,'list');
      if(listing.tracks?.length)break;
      if(codes.length){await atomicJson(join(out,'player-error.json'),{codes,diagnostic:listing.diagnostic});throw new Error('netflix_player_error');}
      await sleep(1500);
    }
    if(!listing?.tracks?.length)throw new Error('manifest_timeout');
    const chosen=listing.tracks.find(t=>t.rawTrackType==='closedcaptions')||listing.tracks[0];assert(/^en(?:-|$)/i.test(chosen.language));
    const result=await request(page,entry.videoId,'capture',chosen.id),media=core.mediaIdentity(`https://www.netflix.com/watch/${entry.videoId}`);
    await validation.resource(result,media,DOMParser);
    const input=join(out,'capture.received.json');await atomicJson(input,{kind:'ottspeed.netflix-capture',schemaVersion:1,mediaKey:media.key,media,track:result.track,rawText:result.rawText});
    return await inspect(input,join(out,'verified'),entry.videoId);
  }catch(error){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});throw error;}
  finally{await page.close();}
}
const safeError=error=>['profile_selection_required','login_required','manifest_timeout','collector_timeout','collector_returned_error','netflix_player_error'].includes(error.message)?error.message:error.name==='TimeoutError'?'browser_timeout':'verification_or_runtime_failed';
try{
  browser=await openDedicatedBrowser();
  let inventory;
  try{inventory=validateInventory(await readJson(join(home,'inventory.json')));}catch(error){if(error.code!=='ENOENT')throw error;inventory=await discover(browser.page);}
  if(args.includes('--discover-only')){emit({phase:'inventory_complete',episodes:inventory.seasons.reduce((n,s)=>n+s.episodes.length,0)});}
  else {
    try{queue=validateQueue(await readJson(join(home,'queue.json')),inventory);}catch(error){if(error.code!=='ENOENT')throw error;queue=createQueue(inventory);}
    for(const e of queue.entries)if(e.status==='collecting'||e.status==='failed')e.status='queued';
    queue.status='running';queue.startedAt=new Date().toISOString();await saveQueue(home,queue);
    const observer=(await Promise.all(['core.js','netflix.js','netflix-main.js'].map(f=>readFile(join(root,'subtitles',f),'utf8')))).join('\n;\n');
    await browser.context.addInitScript({content:`if(location.hostname==='www.netflix.com'){\n${observer}\n}`});
    await browser.page.close();let acquired=0;
    for(const entry of queue.entries){
      if(acquired>=limit)break;
      const previous=entry.artifact;
      const existing=previous?.captureFile||join(root,'private-subtitles','netflix-native-20261024','headless',entry.key,'capture.original.json');
      const out=join(home,'episodes',entry.key,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());await mkdir(out,{recursive:true});
      try{
        try{await readFile(existing);entry.artifact=await inspect(existing,join(out,'reverified'),entry.videoId);entry.status='verified';entry.reused=true;await saveQueue(home,queue);emit({phase:'existing_capture_reverified',episode:entry.key,...queueSummary(queue)});continue;}
        catch(error){if(error.code!=='ENOENT'){entry.attempts.push({at:new Date().toISOString(),phase:'reverify',error:safeError(error)});entry.status='queued';entry.artifact=null;}}
        for(let attempt=1;attempt<=3;attempt++){
          const attemptOut=join(out,`attempt-${attempt}`);await mkdir(attemptOut,{recursive:true});entry.status='collecting';await saveQueue(home,queue);emit({phase:'collecting',episode:entry.key,attempt});
          try{entry.artifact=await capture(entry,attemptOut);entry.status='verified';entry.reused=false;entry.attempts.push({at:new Date().toISOString(),attempt,status:'verified',directory:attemptOut});acquired++;break;}
          catch(error){const code=safeError(error);entry.attempts.push({at:new Date().toISOString(),attempt,error:code,directory:attemptOut});await saveQueue(home,queue);emit({phase:'capture_attempt_failed',episode:entry.key,code,attempt});if(code==='login_required')throw error;if(attempt===3)entry.status='failed';else await sleep(attempt*5000);}
        }
        await saveQueue(home,queue);emit({phase:'episode_finished',episode:entry.key,...queueSummary(queue)});await sleep(1500);
      }catch(error){entry.status='failed';await saveQueue(home,queue);throw error;}
    }
    queue.status=queue.entries.every(e=>e.status==='verified')?'complete':queue.entries.some(e=>e.status==='failed')?'incomplete':'paused_at_limit';await saveQueue(home,queue);emit({phase:'queue_finished',...queueSummary(queue)});if(queue.status==='incomplete')process.exitCode=2;
  }
}catch(error){execution.error=safeError(error);if(queue){queue.status='stopped';queue.error=execution.error;await saveQueue(home,queue);}emit({phase:'stopped',error:execution.error});process.exitCode=2;}
finally{if(browser)await browser.close();execution.finishedAt=new Date().toISOString();execution.phase=execution.error?'stopped':args.includes('--discover-only')?'inventory_complete':queue?.status||'not_verified';await atomicJson(join(home,'latest-run.json'),execution);}
