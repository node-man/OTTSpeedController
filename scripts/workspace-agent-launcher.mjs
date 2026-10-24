/* Official Workspace Agents trigger transport. Credentials never cross the bridge. */
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import prompt from '../subtitles/translation-prompt.js';

const TRIGGER=/^agtch_[A-Za-z0-9_-]{1,180}$/;
const RUN=/^apirun_[A-Za-z0-9_-]{1,180}$/;
const JOB=/^[a-f0-9-]{36}$/i;
const ACTIVE=new Set(['queued','in_progress','suspended']);
const STATES=new Set([...ACTIVE,'completed','failed']);
const sha=value=>createHash('sha256').update(value).digest('hex');
const exec=promisify(execFile);
const conversation=value=>{
  if(typeof value!=='string'||!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{1,200}$/.test(value))return null;
  return value;
};
export async function loadWorkspaceAgentSettings(directory,{env=process.env,decrypt}={}) {
  let config={};
  try {
    const text=await readFile(join(directory,'workspace-agent.json'),'utf8');
    if(text.length>8192)throw new Error('large');
    config=JSON.parse(text);
    if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('shape');
  } catch(error){if(error.code!=='ENOENT')return {enabled:false,problem:'invalid_configuration'};}
  const enabled=env.OTTSPEED_WORKSPACE_AGENT_ENABLED===undefined?config.enabled===true:env.OTTSPEED_WORKSPACE_AGENT_ENABLED==='1';
  const triggerId=env.OTTSPEED_WORKSPACE_AGENT_TRIGGER_ID||config.triggerId||null;
  let token=env.OTTSPEED_WORKSPACE_AGENT_TOKEN||null;
  if(enabled&&!token&&config.useProtectedToken===true) {
    try {
      const file=join(directory,'workspace-agent-token.dpapi');
      if(decrypt)token=await decrypt(file);
      else {
        if(process.platform!=='win32')throw new Error('platform');
        const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',join(dirname(fileURLToPath(import.meta.url)),'read-workspace-agent-token.ps1'),'-Path',file],{windowsHide:true,timeout:10000,maxBuffer:16384});
        token=result.stdout.trim();
      }
    } catch{return {enabled,triggerId,problem:'protected_token_unavailable'};}
  }
  return {enabled,triggerId,token};
}

export class WorkspaceAgentLauncher {
  constructor(directory,{enabled=false,triggerId=null,token=null,problem=null,fetch:fetcher=fetch,now=()=>Date.now(),pollMs=15000,timeoutMs=12000}={}) {
    Object.assign(this,{directory:join(directory,'workspace-agent-runs'),enabled,triggerId,token,problem,fetcher,now,pollMs,timeoutMs});
    this.queues=new Map();this.refreshes=new Map();
  }
  configuration() {
    const missing=[];
    if(!this.enabled)missing.push('not_enabled');
    if(!TRIGGER.test(this.triggerId||''))missing.push('trigger_id_missing_or_invalid');
    if(typeof this.token!=='string'||this.token.length<16||this.token.length>8192||/[\s\x00-\x1f\x7f]/.test(this.token))missing.push('workspace_agent_token_missing_or_invalid');
    if(this.problem)missing.push(this.problem);
    return {provider:'workspace-agent',ready:missing.length===0,enabled:this.enabled,missing};
  }
  path(id){if(!JOB.test(id))throw new Error('Invalid translation job ID.');return join(this.directory,`${id}.json`);}
  async read(id) {
    try {const value=JSON.parse(await readFile(this.path(id),'utf8'));if(value.jobId!==id||value.schemaVersion!==1)throw new Error('Invalid launch record.');return value;}
    catch(error){if(error.code==='ENOENT')return null;throw new Error('Workspace Agent 실행 기록을 읽지 못했습니다.');}
  }
  async write(record) {
    await mkdir(this.directory,{recursive:true});
    const file=this.path(record.jobId),temp=`${file}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,file);
  }
  serial(id,task){
    const result=(this.queues.get(id)||Promise.resolve()).then(task),tail=result.catch(()=>{});
    this.queues.set(id,tail);void tail.then(()=>{if(this.queues.get(id)===tail)this.queues.delete(id);});return result;
  }
  public(record,job) {
    return {mode:'workspace-agent',state:record.state,runId:record.runId||null,conversationUrl:record.conversationUrl||null,
      errorCode:record.errorCode||null,retryable:record.state==='uncertain'||record.retryable===true,
      translationComplete:job.status==='complete',resultPending:record.state==='completed'&&job.status!=='complete'};
  }
  async request(path,{method='GET',body,key}={}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try {
      const response=await this.fetcher(`https://api.chatgpt.com/v1/workspace_agents/${path}`,{
        method,headers:{Authorization:`Bearer ${this.token}`,'OpenAI-Beta':'workspace_agent_runs=v1',...(body?{'Content-Type':'application/json','Idempotency-Key':key}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'error',credentials:'omit'
      });
      if(!response.ok){const e=new Error('Workspace Agent HTTP failure');e.status=response.status;throw e;}
      if(method==='POST'&&response.status!==202)throw new Error('Unexpected trigger response.');
      const text=await response.text();if(text.length>65536)throw new Error('Unexpected response size.');
      return JSON.parse(text);
    } finally{clearTimeout(timer);}
  }
  async start(job) {
    return this.serial(job.jobId,async()=>{
      if(job.kind==='ottspeed.translation-batch'&&job.blockedCount)throw new Error('일괄 작업에 누락되거나 변경된 원문이 있습니다.');
      if(job.status==='complete')return {mode:'complete',translationComplete:true};
      const config=this.configuration();
      let record=await this.read(job.jobId);
      if(record&&record.sourceHash!==job.sourceHash)throw new Error('번역 원문과 실행 기록이 일치하지 않습니다.');
      if(!record&&!config.ready)return {mode:'copy',reason:'workspace_agent_not_configured',configuration:config};
      if(record&&record.triggerId!==this.triggerId)return {...this.public(record,job),errorCode:'configuration_changed',retryable:false};
      if(record&&!['prepared','uncertain'].includes(record.state)&&!(record.state==='failed'&&record.retryable))return this.public(record,job);
      if(!config.ready)return {...this.public(record,job),errorCode:'configuration_unavailable',retryable:false};
      if(record?.nextAttemptAt>this.now())return this.public(record,job);
      const input=job.kind==='ottspeed.translation-batch'?prompt.buildBatch(job):prompt.build(job);
      const digest=sha(input);
      if(record&&record.promptHash!==digest)return {...this.public(record,job),errorCode:'prompt_changed',retryable:false};
      if(!record) {
        record={schemaVersion:1,jobId:job.jobId,sourceHash:job.sourceHash,triggerId:this.triggerId,promptVersion:prompt.version,promptHash:digest,
          idempotencyKey:sha(`ottspeed-workspace-agent:${job.jobId}:${job.sourceHash}:${this.triggerId}:${digest}`),
          state:'prepared',attempts:0,createdAt:new Date(this.now()).toISOString()};
      }
      // Persist intent before any transmission; restart/retry uses the identical event key.
      record.attempts++;record.state='uncertain';record.errorCode=null;record.retryable=false;
      record.nextAttemptAt=this.now()+Math.min(30000,2000*2**Math.min(record.attempts-1,4));
      await this.write(record);
      try {
        const value=await this.request(`${this.triggerId}/trigger`,{method:'POST',key:record.idempotencyKey,
          body:{conversation_key:`ottspeed:${job.jobId}:${job.sourceHash}`,input}});
        const url=conversation(value.conversation_url);
        if(!url||value.agent_trigger_run_id!==undefined&&!RUN.test(value.agent_trigger_run_id))throw new Error('Invalid trigger identity.');
        record.state=value.agent_trigger_run_id?'queued':'submitted';record.runId=value.agent_trigger_run_id||null;record.conversationUrl=url;
        record.errorCode=null;record.lastPolledAt=this.now();record.acceptedAt=new Date(this.now()).toISOString();
      } catch(error) {
        const status=error.status;
        record.state=status&&status<500?'failed':'uncertain';record.retryable=status===429;
        record.errorCode=status===401?'unauthorized':status===403?'forbidden':status===404?'trigger_not_found':status===409?'agent_not_runnable':status===429?'rate_limited':status?'upstream_unavailable':'trigger_outcome_unknown';
      }
      await this.write(record);return this.public(record,job);
    });
  }
  async status(job,{refresh=false}={}) {
    const inspect=async()=>{
      const record=await this.read(job.jobId);if(!record)return null;
      if(record.sourceHash!==job.sourceHash)throw new Error('번역 원문과 실행 기록이 일치하지 않습니다.');
      if(refresh&&job.status!=='complete'&&ACTIVE.has(record.state)&&RUN.test(record.runId||'')&&
        this.configuration().ready&&record.triggerId===this.triggerId&&this.now()-(record.lastPolledAt||0)>=this.pollMs) {
        record.lastPolledAt=this.now();
        try {
          const value=await this.request(`${record.triggerId}/runs/${record.runId}`);
          if(value.id!==record.runId||value.api_trigger_id!==record.triggerId||!STATES.has(value.status))throw new Error('Invalid run identity.');
          record.state=value.status;record.errorCode=value.status==='failed'?'agent_run_failed':null;
          // Never trust/reflect upstream exception text, input, headers or arbitrary URLs.
          record.retryable=false;
        } catch(error){record.errorCode=error.status===401?'unauthorized':error.status===403?'forbidden':'status_unavailable';}
        await this.write(record);
      }
      return this.public(record,job);
    };
    if(!refresh)return inspect();
    if(this.refreshes.has(job.jobId))return this.refreshes.get(job.jobId);
    const task=this.serial(job.jobId,inspect).finally(()=>this.refreshes.delete(job.jobId));
    this.refreshes.set(job.jobId,task);return task;
  }
}
