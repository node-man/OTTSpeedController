/* Registration prepares immutable source jobs; it never submits translation. */
'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory;else root.OTTDeckMcpRegistration=factory;})(globalThis,function({core,catalog,validation,library,bridge,watch=async()=>{},now=()=>Date.now(),intervalMs=30000}){
  let pending=null,last=-Infinity;
  const watched=new Map(),clone=value=>structuredClone(value);
  async function fingerprint(session){return session.tracks?.source?catalog.sourceFingerprint(session.tracks.source):null;}
  async function persist(key,digest,registration){
    for(let attempt=0;attempt<3;attempt++){
      const session=await library.get(key);if(!session||await fingerprint(session)!==digest)return false;
      if(JSON.stringify(session.mcpRegistration)===JSON.stringify(registration))return true;
      session.mcpRegistration=clone(registration);
      try{await library.put(session);return true;}catch(error){if(error.name!=='ConflictError'||attempt===2)throw error;}
    }
  }
  function matches(job,request,source){return job.mediaKey===request.mediaKey&&job.sourceHash===request.sourceHash&&job.capture?.resourceSha256===source.capture.resourceSha256;}
  async function reconcile(){
    const sessions=(await library.list()).filter(s=>s.media?.platform==='netflix'&&s.tracks?.source?.provenance==='netflix-manifest-resource');
    if(!sessions.length)return {registered:0,failed:0};
    // An unavailable connection must not erase previously verified job bindings.
    const result=await bridge('/jobs');if(!Array.isArray(result.jobs))throw new Error('MCP 작업 목록을 확인하지 못했습니다.');
    const jobs=[...result.jobs];let registered=0,failed=0;
    for(const session of sessions){
      const digest=await fingerprint(session);let job;
      try{
        const source=clone(session.tracks.source);source.sync={offsetMs:0,scale:1};validation.track(source,session.media);
        const request=await core.makeTranslationRequest({media:session.media,source,reference:null,mode:'translate'});
        job=jobs.find(j=>matches(j,request,source));
        if(!job){
          // Recheck immediately before creating a job after any asynchronous work.
          const current=await library.get(session.mediaKey);if(!current||await fingerprint(current)!==digest)continue;
          const m=session.catalog,episode=m?.season&&m?.episode?`S${String(m.season).padStart(2,'0')}E${String(m.episode).padStart(2,'0')}`:undefined;
          job=await bridge('/jobs',{media:session.media,source,episode});jobs.push(job);
        }
        if(!matches(job,request,source)||typeof job.jobId!=='string'||job.cueCount!==source.cues.length||!Number.isSafeInteger(job.chunkCount)||job.chunkCount<1||!Number.isSafeInteger(job.savedChunkCount)||job.savedChunkCount<0||job.savedChunkCount>job.chunkCount||!['translating','complete'].includes(job.status))throw new Error('MCP 등록 응답과 현재 원문이 다릅니다.');
        const registration={jobId:job.jobId,mediaKey:job.mediaKey,sourceHash:job.sourceHash,sourceFingerprint:digest,resourceSha256:source.capture.resourceSha256,status:job.status,chunkCount:job.chunkCount,savedChunkCount:job.savedChunkCount,cueCount:job.cueCount,readyCueCount:job.readyCueCount||0,readyThroughMs:job.readyThroughMs||0};
        if(!await persist(session.mediaKey,digest,registration))continue;
        registered++;
        // Cold pending jobs need no polling. Receive externally saved results as
        // archived versions, leaving the viewer's selected A/B untouched.
        const revision=job.resultHash||job.progressHash;
        if((job.status==='complete'||job.savedChunkCount>0)&&revision&&watched.get(job.jobId)!==revision){
          try{await watch(job);watched.set(job.jobId,revision);}catch{ /* Retry delivery on the next reconciliation, without mislabelling registration. */ }
        }
      }catch{
        failed++;await persist(session.mediaKey,digest,{sourceFingerprint:digest,status:'failed'});
      }
    }
    return {registered,failed};
  }
  function sync({force=false}={}){
    if(pending)return pending;
    if(!force&&now()-last<intervalMs)return Promise.resolve(null);
    pending=reconcile().then(value=>{last=now();return value;}).finally(()=>{pending=null;});return pending;
  }
  return Object.freeze({sync});
});
