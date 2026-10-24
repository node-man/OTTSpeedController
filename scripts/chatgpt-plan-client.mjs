/* Official SIWC dynamic-client flow. Uses only auth.openai.com and the public
 * Responses API. Never reads browser sessions, Codex credentials or API keys. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,rename,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {root} from './netflix-headless-browser.mjs';
import {atomicJson} from './netflix-series-queue.mjs';

export const planHome=join(root,'private-subtitles','chatgpt-plan');
const resource='https://api.openai.com/v1',scope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const credentialFile=join(planHome,'credentials.dpapi');
const random=()=>randomBytes(32).toString('base64url');
const now=()=>new Date().toISOString();
export function buildAuthorization({hostId,redirectUri,state,nonce,verifier,clientId='dynamic_agent_client'}){
  assert(/^urn:uuid:[a-f0-9-]{36}$/.test(hostId));const redirect=new URL(redirectUri);assert.equal(redirect.hostname,'127.0.0.1');assert.equal(redirect.protocol,'http:');assert.equal(redirect.pathname,'/auth/callback');
  const url=new URL('https://auth.openai.com/api/accounts/authorize');
  const params={client_id:clientId,ext_agent_host_id:hostId,response_type:'code',redirect_uri:redirectUri,scope,resource,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
  if(clientId==='dynamic_agent_client')params.agent_name_hint='OTTSpeed';url.search=new URLSearchParams(params);return url;
}
export async function validateIdentity(idToken,{clientId,nonce,issuer='https://auth.openai.com',keys}={}){
  const jwks=keys||createRemoteJWKSet(new URL('https://auth.openai.com/.well-known/jwks.json'));
  const {payload}=await jwtVerify(idToken,jwks,{issuer,audience:clientId,algorithms:['RS256','ES256']});
  assert.equal(payload.nonce,nonce,'oidc_nonce_mismatch');assert(typeof payload.sub==='string'&&payload.sub);return payload;
}
// Credentials go directly from process memory to Windows DPAPI; no plaintext file.
function dpapi(action,value){
  assert.equal(process.platform,'win32','Windows DPAPI is required.');
  const code=action==='protect'?'$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))':'$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.Security;'+code],{input:value,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}).trim();
}
async function protect(record){
  const encrypted=dpapi('protect',JSON.stringify(record)),tmp=credentialFile+'.'+randomUUID()+'.tmp';
  await writeFile(tmp,encrypted,{flag:'wx',mode:0o600});await rename(tmp,credentialFile);
}
export async function credentials(){return JSON.parse(dpapi('unprotect',await readFile(credentialFile,'utf8')));}
export async function signIn({port=0,onReady=()=>{}}={}){
  await mkdir(planHome,{recursive:true});
  let host;try{host=JSON.parse(await readFile(join(planHome,'host.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;host={hostId:'urn:uuid:'+randomUUID()};await atomicJson(join(planHome,'host.json'),host);}
  let saved;try{saved=await credentials();}catch(error){if(error.code!=='ENOENT')throw error;}
  const state=random(),nonce=random(),verifier=random(),launchSecret=random();let consumed=false,authorizationUrl,timer;
  const status={kind:'ottspeed.chatgpt-plan-auth',version:1,startedAt:now(),phase:'awaiting_user_sign_in',tokenStored:false,planScopeGranted:false};
  let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve;});
  const finish=async(phase,extra={})=>{Object.assign(status,{phase,...extra,updatedAt:now()});await atomicJson(join(planHome,'auth-status.json'),status);resolveDone(status);};
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&url.pathname===`/session/${launchSecret}`){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>OTTSpeed · ChatGPT 요금제 연결</title><style>body{font:18px system-ui;background:#18231f;color:#edf4ef;max-width:720px;margin:70px auto;padding:30px}a{display:inline-block;background:#edf4ef;color:#18231f;padding:15px 22px;border-radius:8px}p{line-height:1.8}</style><h1>ChatGPT 요금제로 번역 시험</h1><p>OTTSpeed가 공식 OpenAI 로그인으로 별도 동의를 요청합니다. 허용하면 실제 영어 자막 한 조각을 번역해 연결을 검사합니다. 현재 시청 탭은 변경하지 않습니다.</p><p>적격 요청은 ChatGPT 요금제 또는 연결된 크레딧을 사용하며 사용량 제한이 적용됩니다. 자격 증명은 이 PC에서 Windows DPAPI로 암호화 보관합니다.</p><a href="/authorize/${launchSecret}">Continue with ChatGPT</a><p>연결 상태: ${status.phase}</p><p><a href="https://chatgpt.com/settings/usage">ChatGPT 사용량 관리</a></p></html>`);return;}
    if(req.method==='GET'&&url.pathname===`/authorize/${launchSecret}`&&!consumed){res.writeHead(302,{Location:authorizationUrl.toString()});res.end();return;}
    if(req.method!=='GET'||url.pathname!=='/auth/callback'){res.writeHead(404);res.end('Not found');return;}
    if(consumed||url.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid or expired sign-in transaction.');return;}
    consumed=true;clearTimeout(timer);
    try{
      if(url.searchParams.has('error')){await finish('consent_declined');res.end('OTTSpeed: sign-in was not authorized. No inference was run.');return;}
      const clientId=url.searchParams.get('client_id')||saved?.client_id;
      assert(/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId||''),'issued_client_id_missing');if(saved)assert.equal(clientId,saved.client_id,'client_id_changed');
      const code=url.searchParams.get('code');assert(code,'authorization_code_missing');
      const response=await fetch('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:verifier,redirect_uri:status.redirectUri,resource}),signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('token_exchange_failed');const tokens=await response.json();
      const identity=await validateIdentity(tokens.id_token,{clientId,nonce});if(saved)assert.equal(identity.sub,saved.subject,'account_identity_changed');
      const scopes=String(tokens.scope||'').split(/\s+/).filter(Boolean);assert(typeof tokens.access_token==='string');assert(Number.isFinite(Number(tokens.expires_in))&&Number(tokens.expires_in)>0);
      await protect({client_id:clientId,host_id:host.hostId,subject:identity.sub,email:identity.email||null,id_token:tokens.id_token,access_token:tokens.access_token,refresh_token:tokens.refresh_token||null,scopes,expiresAt:Date.now()+Number(tokens.expires_in)*1000,savedAt:now()});
      await finish(scopes.includes('chatgpt.tokens.use.direct')?'authorized':'plan_usage_not_granted',{tokenStored:true,planScopeGranted:scopes.includes('chatgpt.tokens.use.direct')});
      res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(status.planScopeGranted?'OTTSpeed 연결 완료. 자막 번역 시험을 이어갑니다. 이 탭은 닫아도 됩니다.':'로그인은 완료됐지만 ChatGPT 요금제 사용 권한이 없어 번역을 실행하지 않았습니다.');
    }catch(error){await finish('authorization_not_verified',{errorCode:['issued_client_id_missing','client_id_changed','authorization_code_missing','token_exchange_failed','account_identity_changed','oidc_nonce_mismatch'].includes(error.message)?error.message:'token_or_identity_validation_failed'});res.writeHead(400);res.end('OTTSpeed could not verify authorization. No inference was run.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  status.redirectUri=`http://127.0.0.1:${server.address().port}/auth/callback`;
  authorizationUrl=buildAuthorization({hostId:host.hostId,redirectUri:status.redirectUri,state,nonce,verifier,clientId:saved?.client_id});
  const launchUrl=`http://127.0.0.1:${server.address().port}/session/${launchSecret}`;
  await atomicJson(join(planHome,'launch.json'),{launchUrl,startedAt:now()});await atomicJson(join(planHome,'auth-status.json'),status);
  timer=setTimeout(()=>finish('sign_in_timeout'),30*60*1000);await onReady({launchUrl});
  const result=await done;clearTimeout(timer);await new Promise(resolve=>server.close(resolve));return result;
}
export async function withCredentials(task){
  await mkdir(planHome,{recursive:true});const lockFile=join(planHome,'credential.lock'),lock=await open(lockFile,'wx');
  try{
    let record=await credentials();assert(record.scopes.includes('chatgpt.tokens.use.direct'),'plan_usage_not_granted');
    if(record.expiresAt<Date.now()+60000){
      assert(record.refresh_token,'reauthorization_required');
      const r=await fetch('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:record.client_id,refresh_token:record.refresh_token,resource}),signal:AbortSignal.timeout(30000)});
      assert(r.ok,'token_refresh_failed');const tokens=await r.json();assert(Number.isFinite(Number(tokens.expires_in))&&Number(tokens.expires_in)>0);
      record={...record,access_token:tokens.access_token,refresh_token:tokens.refresh_token||record.refresh_token,id_token:tokens.id_token||record.id_token,scopes:tokens.scope?tokens.scope.split(/\s+/):record.scopes,expiresAt:Date.now()+Number(tokens.expires_in)*1000};
      assert(record.access_token&&record.scopes.includes('chatgpt.tokens.use.direct'),'plan_usage_not_granted');await protect(record);
    }
    return await task(record.access_token);
  }finally{await lock.close();await unlink(lockFile);}
}
export async function consumeResponse(response,{onEvent=()=>{}}={}){
  if(!response.ok){
    const error=new Error(`responses_http_${response.status}`);
    try{const body=await response.json();error.apiError=body.error?{code:body.error.code,param:body.error.param,type:body.error.type,message:body.error.message}:{message:typeof body.detail==='string'?body.detail:'unstructured_error'};}catch{error.apiError={message:'unreadable_error_body'};}
    throw error;
  }
  // The authenticated plan route has returned a valid HTTP 200 stream without
  // Content-Type. Validate its actual SSE/JSON framing and terminal event.
  const contentType=response.headers.get('content-type');assert(!contentType||contentType.includes('text/event-stream'),'response_not_event_stream');
  const decoder=new TextDecoder();let buffer='',completed=null,output='';
  function event(block){const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return;const value=JSON.parse(data);onEvent(value);if(value.type==='response.output_text.delta')output+=value.delta;
    if(['response.failed','response.incomplete','error'].includes(value.type)){const error=new Error('response_not_completed');error.usage=value.response?.usage;error.responseId=value.response?.id;error.apiError=value.response?.error||value.error;throw error;}if(value.type==='response.completed'){assert.equal(value.response.status,'completed');completed=value.response;}}
  for await(const chunk of response.body){buffer=(buffer+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');let index;while((index=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,index));buffer=buffer.slice(index+2);}}
  buffer+=decoder.decode();if(buffer.trim())event(buffer);assert(completed,'response_completed_event_missing');
  return {text:output,responseId:completed.id,usage:completed.usage,status:completed.status,model:completed.model,reasoning:completed.reasoning};
}
