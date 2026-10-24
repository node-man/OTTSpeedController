import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../subtitles/runtime-client.js',import.meta.url),'utf8');
const ready={kind:'ottspeed.local-runtime',version:1,ok:true,state:'ready',bridgeReady:true,tunnelReady:true,supervisorReady:true};
function fixture(value=ready,{error=null,defer=false}={}) {
  const calls=[],callbacks=[];
  const chrome={runtime:{lastError:null,sendNativeMessage:(host,message,callback)=>{
    calls.push({host,message});
    if(defer)callbacks.push(callback);
    else {chrome.runtime.lastError=error;callback(value);chrome.runtime.lastError=null;}
  }}};
  const context=vm.createContext({});vm.runInContext(script,context);
  return {client:context.OTTLocalRuntime({chrome}),calls,callbacks};
}
test('native requests have fixed start/status commands, with no caption or token payload',async()=>{
  const f=fixture();assert.equal((await f.client.ensure()).ready,true);
  await f.client.status();
  assert.deepEqual(structuredClone(f.calls),[
    {host:'com.ottspeed.runtime',message:{action:'ensure'}},
    {host:'com.ottspeed.runtime',message:{action:'status'}}
  ]);
});
test('simultaneous startup requests share one native operation and may retry later',async()=>{
  const f=fixture(ready,{defer:true});const a=f.client.ensure(),b=f.client.ensure();
  assert.equal(a,b);assert.equal(f.calls.length,1);
  f.callbacks.shift()(ready);await a;
  const next=f.client.ensure();assert.equal(f.calls.length,2);f.callbacks.shift()(ready);await next;
});
test('bridge-only readiness, malformed replies and missing hosts never report tunnel ready',async()=>{
  assert.equal((await fixture({...ready,tunnelReady:false}).client.ensure()).ready,false);
  for(const value of [null,{ready:true},{...ready,version:2}])assert.equal((await fixture(value).client.ensure()).errorCode,'invalid_response');
  assert.equal((await fixture(null,{error:{message:'Specified native messaging host not found.'}}).client.ensure()).errorCode,'native_host_missing');
  assert.equal((await fixture(null,{error:{message:'Access to the specified native messaging host is forbidden.'}}).client.ensure()).errorCode,'native_host_unavailable');
  assert.equal((await fixture({...ready,ok:false,errorCode:'start_failed'}).client.ensure()).errorCode,'start_failed');
});
