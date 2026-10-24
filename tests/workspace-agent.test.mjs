// Synthetic upstream only. Never calls api.chatgpt.com or provisions credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkspaceAgentLauncher,loadWorkspaceAgentSettings} from '../scripts/workspace-agent-launcher.mjs';

const token='synthetic-agent-secret-not-real';
const triggerId='agtch_synthetic';
const fixture=()=>({jobId:'12345678-1234-4234-8234-123456789abc',sourceHash:'a'.repeat(64),mediaKey:'netflix:101',media:{videoId:'101'},status:'translating'});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const accepted=()=>response({conversation_url:'https://chatgpt.com/c/synthetic',agent_trigger_run_id:'apirun_synthetic'},202);
async function environment(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'ottspeed-agent-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let time=100000;const requests=[];
  const config={enabled:true,triggerId,token,now:()=>time,fetch:async(url,options)=>{requests.push({url,options});return accepted();},...options};
  const create=extra=>new WorkspaceAgentLauncher(directory,{...config,...extra});
  return {directory,requests,create,launcher:create(),advance:ms=>{time+=ms;},record:async()=>JSON.parse(await readFile(join(directory,'workspace-agent-runs',`${fixture().jobId}.json`),'utf8'))};
}

test('disabled or missing configuration returns copy fallback without transmitting; completed translations never launch',async t=>{
  const f=await environment(t,{enabled:false});
  assert.equal((await f.launcher.start(fixture())).mode,'copy');assert.equal(f.requests.length,0);
  assert.equal((await f.launcher.start({...fixture(),status:'complete'})).mode,'complete');
  assert.equal(JSON.stringify(f.launcher.configuration()).includes(token),false);
  const wrong=f.create({triggerId:'agt_not_an_api_channel'});assert.equal((await wrong.start(fixture())).mode,'copy');
  assert.equal(f.requests.length,0);
});

test('concurrent clicks and bridge restart reuse one accepted fixed-job trigger with no caption or credential persistence',async t=>{
  const f=await environment(t);const job=fixture();
  const values=await Promise.all([f.launcher.start(job),f.launcher.start(job)]);
  assert(values.every(v=>v.state==='queued'));assert.equal(f.requests.length,1);
  const request=f.requests[0];assert.equal(request.url,`https://api.chatgpt.com/v1/workspace_agents/${triggerId}/trigger`);
  assert.equal(request.options.method,'POST');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers['OpenAI-Beta'],'workspace_agent_runs=v1');
  const body=JSON.parse(request.options.body);assert(body.input.includes(job.jobId));assert(body.conversation_key.includes(job.sourceHash));assert(!body.input.includes(token));
  assert.equal((await f.create().start(job)).state,'queued');assert.equal(f.requests.length,1);
  const record=await f.record();assert.equal(record.idempotencyKey,request.options.headers['Idempotency-Key']);
  assert(!JSON.stringify(record).includes(token));assert(!('input' in record));assert(!('token' in record));
});

test('a lost trigger response persists intent and replays exactly the same event after restart',async t=>{
  const f=await environment(t);let first=true;
  const fetch=async(url,options)=>{f.requests.push({url,options});const saved=await f.record();assert.equal(saved.state,'uncertain');
    if(first){first=false;throw new Error(`network failure with ${token}`);}return accepted();};
  let launcher=f.create({fetch});assert.equal((await launcher.start(fixture())).state,'uncertain');
  assert.equal(f.requests.length,1);assert.equal((await launcher.start(fixture())).state,'uncertain');assert.equal(f.requests.length,1);
  f.advance(30000);launcher=f.create({fetch});assert.equal((await launcher.start(fixture())).state,'queued');
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].options.body,f.requests[1].options.body);
  assert.equal(f.requests[0].options.headers['Idempotency-Key'],f.requests[1].options.headers['Idempotency-Key']);
  assert(!JSON.stringify(await f.record()).includes(token));
});

test('HTTP errors are sanitized and rate-limit retries are bounded with the same event key',async t=>{
  const f=await environment(t);let status=429;
  const launcher=f.create({fetch:async(url,options)=>{f.requests.push({url,options});return status===202?accepted():response({error:{message:token}},status);}});
  const failed=await launcher.start(fixture());assert.equal(failed.errorCode,'rate_limited');assert.equal(failed.retryable,true);assert(!JSON.stringify(failed).includes(token));
  await launcher.start(fixture());assert.equal(f.requests.length,1);
  f.advance(30000);status=202;assert.equal((await launcher.start(fixture())).state,'queued');assert.equal(f.requests.length,2);
  assert.equal(f.requests[0].options.headers['Idempotency-Key'],f.requests[1].options.headers['Idempotency-Key']);
});

test('run completion is distinct from translation finalization; status polling validates identity and is rate-limited',async t=>{
  const f=await environment(t);await f.launcher.start(fixture());f.advance(15000);
  let remoteStatus='completed',badId=false;
  const launcher=f.create({fetch:async(url,options)=>{f.requests.push({url,options});return response({id:badId?'apirun_other':'apirun_synthetic',api_trigger_id:triggerId,status:remoteStatus,error:{message:token}});}});
  const completed=await launcher.status(fixture(),{refresh:true});assert.equal(completed.state,'completed');assert.equal(completed.resultPending,true);assert.equal(completed.translationComplete,false);
  assert.equal((await launcher.start(fixture())).state,'completed');assert.equal(f.requests.length,2);
  assert.equal((await launcher.status({...fixture(),status:'complete'},{refresh:true})).translationComplete,true);assert.equal(f.requests.length,2);
  // Restore a queued state only inside this isolated synthetic fixture.
  const saved=await f.record();saved.state='queued';saved.lastPolledAt=100000;await writeFile(join(f.directory,'workspace-agent-runs',`${saved.jobId}.json`),JSON.stringify(saved));
  badId=true;remoteStatus='in_progress';const mismatched=await launcher.status(fixture(),{refresh:true});assert.equal(mismatched.state,'queued');assert.equal(mismatched.errorCode,'status_unavailable');
  const count=f.requests.length;await launcher.status(fixture(),{refresh:true});assert.equal(f.requests.length,count);
  assert(!JSON.stringify(await f.record()).includes(token));
});

test('changed job source, trigger, or prompt cannot silently submit another event',async t=>{
  const f=await environment(t);await f.launcher.start(fixture());
  await assert.rejects(()=>f.launcher.start({...fixture(),sourceHash:'b'.repeat(64)}),/원문/);
  assert.equal((await f.create({triggerId:'agtch_other'}).start(fixture())).errorCode,'configuration_changed');assert.equal(f.requests.length,1);
});

test('settings require explicit enabling and keep protected credentials in the backend only',async t=>{
  const f=await environment(t);let decrypts=0;
  await writeFile(join(f.directory,'workspace-agent.json'),JSON.stringify({enabled:false,triggerId,useProtectedToken:true}));
  const decrypt=async()=>{decrypts++;return token;};
  const disabled=await loadWorkspaceAgentSettings(f.directory,{env:{},decrypt});assert.equal(disabled.enabled,false);assert.equal(decrypts,0);
  const enabled=await loadWorkspaceAgentSettings(f.directory,{env:{OTTSPEED_WORKSPACE_AGENT_ENABLED:'1'},decrypt});assert.equal(decrypts,1);assert.equal(enabled.token,token);
  assert(!JSON.stringify(new WorkspaceAgentLauncher(f.directory,enabled).configuration()).includes(token));
  await writeFile(join(f.directory,'workspace-agent.json'),`invalid JSON ${token}`);
  const broken=await loadWorkspaceAgentSettings(f.directory,{env:{}});assert.equal(broken.problem,'invalid_configuration');assert(!JSON.stringify(broken).includes(token));
});

test('untrusted conversation URLs and missing run IDs never cause page access or false finalization',async t=>{
  const f=await environment(t);
  const hostile=f.create({fetch:async()=>response({conversation_url:'https://evil.example/collect',agent_trigger_run_id:'apirun_synthetic'},202)});
  assert.equal((await hostile.start(fixture())).state,'uncertain');assert.equal((await f.record()).conversationUrl,undefined);
  f.advance(30000);
  const compatible=f.create({fetch:async()=>response({conversation_url:'https://chatgpt.com/c/synthetic'},202)});
  const submitted=await compatible.start(fixture());assert.equal(submitted.state,'submitted');assert.equal(submitted.translationComplete,false);assert.equal(submitted.runId,null);
});

test('Windows DPAPI credential survives child-process loading without plaintext storage',{skip:process.platform!=='win32'},async t=>{
  const f=await environment(t),file=join(f.directory,'workspace-agent-token.dpapi');
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; [IO.File]::WriteAllText($env:OTTSPEED_TEST_TOKEN_PATH, ('synthetic-agent-secret-not-real' | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString))"],
    {env:{...process.env,OTTSPEED_TEST_TOKEN_PATH:file},windowsHide:true,timeout:10000});
  await writeFile(join(f.directory,'workspace-agent.json'),JSON.stringify({schemaVersion:1,enabled:true,triggerId,useProtectedToken:true}));
  const settings=await loadWorkspaceAgentSettings(f.directory,{env:{}});
  assert.equal(settings.token,token);assert.equal(new WorkspaceAgentLauncher(f.directory,settings).configuration().ready,true);
  assert(!(await readFile(file,'utf8')).includes(token));
});
