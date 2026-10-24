import {setTimeout as delay} from 'node:timers/promises';
export async function until(predicate,label='UI did not settle',timeoutMs=5000){
  const deadline=performance.now()+timeoutMs;
  do{if(await predicate())return;await delay(5);}while(performance.now()<deadline);
  throw new Error(label);
}
