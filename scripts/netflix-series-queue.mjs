import assert from 'node:assert/strict';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export function validateInventory(inventory){
  assert.equal(inventory.kind,'ottspeed.netflix-series-inventory');assert.equal(inventory.version,1);
  assert(/^\d+$/.test(inventory.seriesId));assert(inventory.seasons.length>0);
  const ids=new Set(),keys=new Set();
  for(const season of inventory.seasons){
    assert(Number.isSafeInteger(season.season)&&season.season>0);assert(season.episodes.length===season.expectedCount&&season.expectedCount>0);
    for(const [i,e] of season.episodes.entries()){
      assert.equal(e.season,season.season);assert.equal(e.episode,i+1);assert(e.title.trim());assert(/^\d+$/.test(e.videoId));
      assert(!ids.has(e.videoId)&&!keys.has(`${e.season}:${e.episode}`),'Duplicate episode.');ids.add(e.videoId);keys.add(`${e.season}:${e.episode}`);
    }
  }
  assert.equal(new Set(inventory.seasons.map(s=>s.season)).size,inventory.seasons.length);
  return inventory;
}
export const episodeKey=e=>`S${String(e.season).padStart(2,'0')}E${String(e.episode).padStart(2,'0')}`;
export function createQueue(inventory){
  validateInventory(inventory);
  return {kind:'ottspeed.netflix-series-queue',version:1,seriesId:inventory.seriesId,series:inventory.series,createdAt:new Date().toISOString(),status:'queued',entries:inventory.seasons.flatMap(s=>s.episodes).map(e=>({...e,key:episodeKey(e),status:'queued',attempts:[],artifact:null}))};
}
export function validateQueue(queue,inventory){
  const expected=createQueue(inventory);assert.equal(queue.kind,expected.kind);assert.equal(queue.version,1);assert.equal(queue.seriesId,expected.seriesId);assert.equal(queue.entries.length,expected.entries.length);
  queue.entries.forEach((e,i)=>{for(const field of ['key','season','episode','videoId','title'])assert.equal(e[field],expected.entries[i][field],'Queue inventory changed.');assert(['queued','collecting','verified','failed'].includes(e.status));});
  return queue;
}
export function queueSummary(queue){
  const verified=queue.entries.filter(e=>e.status==='verified');
  return {series:queue.series,status:queue.status,total:queue.entries.length,verified:verified.length,failed:queue.entries.filter(e=>e.status==='failed').length,pending:queue.entries.filter(e=>e.status==='queued'||e.status==='collecting').length,cueCount:verified.reduce((n,e)=>n+e.artifact.cueCount,0),lastEpisode:queue.entries.at(-1)?.key,lastEpisodeVerified:queue.entries.at(-1)?.status==='verified',updatedAt:queue.updatedAt};
}
export async function atomicJson(path,value){
  const tmp=`${path}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(tmp,path);
}
export async function saveQueue(home,queue){
  await mkdir(home,{recursive:true});queue.updatedAt=new Date().toISOString();
  await atomicJson(join(home,'queue.json'),queue);await atomicJson(join(home,'summary.json'),queueSummary(queue));
}
export async function readJson(path){return JSON.parse(await readFile(path,'utf8'));}
