/* Readiness/explicit execution for fixed cached jobs. No browser or token output. */
import {resolve} from 'node:path';
import {WorkspaceAgentLauncher,loadWorkspaceAgentSettings} from './workspace-agent-launcher.mjs';
import {TranslationStore} from './translation-bridge-store.mjs';

const args=process.argv.slice(2);
if(args.some((arg,i)=>arg!=='--execute'&&arg!=='--job'&&args[i-1]!=='--job'))throw new Error('Use --job UUID and optional --execute, or no arguments for readiness.');
const directory=resolve(process.env.OTTSPEED_BRIDGE_DIR||'private-subtitles/bridge');
const launcher=new WorkspaceAgentLauncher(directory,await loadWorkspaceAgentSettings(directory));
const configuration=launcher.configuration();
const index=args.indexOf('--job');
if(args.includes('--execute')&&index<0)throw new Error('--execute requires an explicit fixed --job UUID.');
let execution=null;
if(index>=0) {
  const store=await new TranslationStore(directory).init(),job=await store.extensionJob(args[index+1]);
  if(args.includes('--execute'))execution=await launcher.start(job);
  else execution={mode:'preview',jobId:job.jobId,translationComplete:job.status==='complete',willLaunch:false};
}
console.log(JSON.stringify({configuration,execution,liveApiVerified:false,
  note:'Readiness is local configuration only. Agent tool access and real translation return require separate verification.'},null,2));
if(!configuration.ready)process.exitCode=2;
