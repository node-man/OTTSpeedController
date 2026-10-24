/* Prepare fixed cached episodes without Chrome. No acquisition or execution. */
import {resolve} from 'node:path';
import {TranslationStore} from './translation-bridge-store.mjs';
import {TranslationBatchStore} from './translation-batch-store.mjs';
import prompt from '../subtitles/translation-prompt.js';
const ids=process.argv.slice(2);
if(!ids.length||ids.some(id=>!/^[a-f0-9-]{36}$/i.test(id))){console.error('Usage: node scripts/prepare-translation-batch.mjs JOB_UUID [JOB_UUID ...]');process.exit(2);}
const store=await new TranslationStore(resolve(process.env.OTTSPEED_BRIDGE_DIR||'private-subtitles/bridge')).init();
const batches=await new TranslationBatchStore(store).init(),batch=await batches.create({jobIds:ids});
console.log(JSON.stringify({...batch,prompt:prompt.buildBatch(batch),externalExecutionStarted:false},null,2));
