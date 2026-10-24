/* Final archive audit, offline. Does not create translation jobs or display B. */
import assert from 'node:assert/strict';
import {readFile,realpath,writeFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {DOMParser} from '@xmldom/xmldom';
import core from '../subtitles/core.js';
import validation from '../subtitles/capture-validation.js';
import {root} from './netflix-headless-browser.mjs';
import {validateInventory,validateQueue,readJson,atomicJson} from './netflix-series-queue.mjs';

const home=join(root,'private-subtitles','series-capture','west-wing'),privateRoot=await realpath(join(root,'private-subtitles'));
const inventory=validateInventory(await readJson(join(home,'inventory.json'))),queue=validateQueue(await readJson(join(home,'queue.json')),inventory);
assert.equal(queue.status,'complete','Queue is not complete.');assert(queue.entries.every(e=>e.status==='verified'&&e.artifact),'Some episode is not verified.');
const episodes=[];
for(const entry of queue.entries){
  const captureFile=await realpath(entry.artifact.captureFile),rel=relative(privateRoot,captureFile);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Archive path escaped private storage.');
  const capture=JSON.parse(await readFile(captureFile,'utf8'));assert.equal(capture.mediaKey,`netflix:${entry.videoId}`);
  await validation.resource({track:capture.track,rawText:capture.rawText},capture.media,DOMParser);
  const audit=await readJson(entry.artifact.auditFile),c=capture.track.capture;
  assert(audit.fullEpisodeResourceAcquired&&audit.independentByteHashVerified&&audit.independentReparseMatches&&audit.excludedCount===0);
  assert.equal(audit.resourceSha256,c.resourceSha256);assert.equal(entry.artifact.resourceSha256,c.resourceSha256);assert.equal(audit.acceptedCount,capture.track.cues.length);assert.equal(entry.artifact.cueCount,capture.track.cues.length);
  assert.deepEqual(core.parse(await readFile(entry.artifact.vttFile,'utf8'),'source.vtt').cues,capture.track.cues);
  const request=await core.makeTranslationRequest({media:capture.media,source:capture.track,reference:null,mode:'translate'});
  episodes.push({key:entry.key,season:entry.season,episode:entry.episode,title:entry.title,videoId:entry.videoId,mediaKey:capture.mediaKey,cueCount:capture.track.cues.length,resourceSha256:c.resourceSha256,resourceBytes:c.resourceBytes,sourceHash:request.sourceHash,capturedAt:c.capturedAt,warnings:audit.warnings||[],captureFile,vttFile:entry.artifact.vttFile,auditFile:entry.artifact.auditFile});
}
const seasons=inventory.seasons.map(s=>{const es=episodes.filter(e=>e.season===s.season);assert.equal(es.length,s.expectedCount);return {season:s.season,expectedCount:s.expectedCount,verified:es.length,cueCount:es.reduce((n,e)=>n+e.cueCount,0),first:es[0].key,last:es.at(-1).key};});
const report={kind:'ottspeed.netflix-series-archive',version:1,series:inventory.series,seriesId:inventory.seriesId,status:'verified',verifiedAt:new Date().toISOString(),episodeCount:episodes.length,cueCount:episodes.reduce((n,e)=>n+e.cueCount,0),resourceBytes:episodes.reduce((n,e)=>n+e.resourceBytes,0),warningCount:episodes.reduce((n,e)=>n+e.warnings.length,0),firstEpisode:episodes[0].key,lastEpisode:episodes.at(-1).key,lastTitle:episodes.at(-1).title,seasons,episodes,translationCreated:false,viewingTabControlled:false,limitation:'Complete manifest text resources and independent parsing/hash accounting. Not an audio transcription, translation quality, or playback-sync audit.'};
await atomicJson(join(home,'archive-index.json'),report);
await writeFile(join(home,'COLLECTION-RESULT.md'),`# The West Wing Netflix 영어 자막 수집 결과\n\n검증 시각: ${report.verifiedAt}\n\n${report.firstEpisode}부터 **${report.lastEpisode} ${report.lastTitle}**까지 **${report.episodeCount}개 회차**, **${report.cueCount.toLocaleString('en-US')}개 cue**. 모든 회차를 원본 바이트 해시·manifest 영상 ID·독립 파싱·VTT 왕복으로 다시 검사했습니다.\n\n| 시즌 | 회차 | cue | 마지막 회차 |\n| --- | ---: | ---: | --- |\n${seasons.map(s=>`| ${s.season} | ${s.verified}/${s.expectedCount} | ${s.cueCount.toLocaleString('en-US')} | ${s.last} |`).join('\n')}\n\n파일·해시·회차별 경로는 같은 폴더의 archive-index.json에 보존했습니다. 원본과 기존 A/B·번역 작업은 보존했으며, 시청 탭에 제어 명령을 보내지 않았습니다. 전편 텍스트 파일 확보 결과이며 음성 대조·번역 품질·싱크 검증을 뜻하지 않습니다.\n`);
console.log(JSON.stringify({...report,episodes:undefined},null,2));
