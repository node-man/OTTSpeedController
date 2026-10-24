import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, writeFile, mkdir, open, unlink, realpath} from 'node:fs/promises';
import {resolve, join, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const authHome=join(root,'private-subtitles','headless-auth');
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Only our dedicated, normally authenticated profile. Never attach to user tabs.
export async function openDedicatedBrowser(){
  await mkdir(authHome,{recursive:true});
  const privateRoot=await realpath(join(root,'private-subtitles')),home=await realpath(authHome);
  const rel=relative(privateRoot,home);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  const profile=join(home,'profile');await mkdir(profile,{recursive:true});
  assert.equal(await realpath(profile),profile,'Linked profile is not allowed.');
  const state=JSON.parse(await readFile(join(home,'profile-state.json'),'utf8'));
  assert.equal(state.kind,'ottspeed.headless-profile');assert.equal(state.version,1);
  let profileChoice;try{profileChoice=JSON.parse(await readFile(join(home,'profile-choice.json'),'utf8')).profileName;}catch(error){if(error.code!=='ENOENT')throw error;}
  const lockFile=join(home,'runner.lock'),lock=await open(lockFile,'wx');
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  let context;
  try{
    const runtime=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules');
    const require=createRequire(import.meta.url),{chromium}=require(require.resolve('playwright',{paths:[root,runtime]}));
    context=await chromium.launchPersistentContext(profile,{executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true,chromiumSandbox:true,ignoreDefaultArgs:true,viewport:{width:1280,height:900},args:[`--user-data-dir=${profile}`,'--remote-debugging-pipe','--headless','--no-first-run','--no-default-browser-check','--window-size=1280,900','about:blank'],timeout:30000});
    const page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(15000);
    for(let attempt=1;attempt<=3;attempt++){
      try{
        await page.goto('https://www.netflix.com/browse',{waitUntil:'domcontentloaded',timeout:30000});
        const memberNav=page.locator('a[href="/browse/my-list"]'),profileGate=page.getByText('넷플릭스를 시청할 프로필을 선택하세요.',{exact:true});
        await memberNav.or(profileGate).first().waitFor({state:'visible',timeout:20000});
        if(await profileGate.isVisible()){
          if(!profileChoice)throw new Error('profile_selection_required');
          await page.getByText(profileChoice,{exact:true}).click();
        }
        await memberNav.waitFor({state:'visible',timeout:20000});break;
      }catch(error){
        await page.screenshot({path:join(home,'last-startup-failure.png')}).catch(()=>{});
        await writeFile(join(home,'last-startup-failure.json'),JSON.stringify({at:new Date().toISOString(),attempt,path:new URL(page.url()).pathname,error:error.name}));
        if(attempt===3||error.message==='profile_selection_required'||new URL(page.url()).pathname.startsWith('/login'))throw error;
        await sleep(attempt*3000);
      }
    }
    assert.equal(new URL(page.url()).hostname,'www.netflix.com');assert(/^\/browse(?:\/|$)/.test(new URL(page.url()).pathname),'login_required');
    return {context,page,async close(){try{await context.close();}finally{await lock.close();await unlink(lockFile);}}};
  }catch(error){if(context)await context.close().catch(()=>{});await lock.close();await unlink(lockFile);throw error;}
}
