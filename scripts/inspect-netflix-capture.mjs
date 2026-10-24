/* Independent asset/count/identity audit of an actual extension capture.
 * Does not translate, align external subtitles, or infer coverage from end time. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import core from '../subtitles/core.js';
import netflix from '../subtitles/netflix.js';

const [input, output, expectedId] = process.argv.slice(2);
if (!input || !output || !/^\d+$/.test(expectedId || '')) {
  console.error('Usage: node scripts/inspect-netflix-capture.mjs CAPTURE_JSON NEW_OUTPUT_DIRECTORY EXPECTED_NETFLIX_VIDEO_ID');
  process.exit(2);
}
const bytes = await readFile(input);
assert(bytes.length < 12*1024*1024, 'Capture exceeds audit limit');
const value = JSON.parse(bytes);
assert.equal(value.kind, 'ottspeed.netflix-capture'); assert.equal(value.schemaVersion, 1);
const c = value.track?.capture;
assert.equal(value.mediaKey, `netflix:${expectedId}`);
assert.equal(value.media?.key, value.mediaKey); assert.equal(value.media?.videoId, expectedId);
assert.equal(c.videoId, expectedId); assert.equal(c.mediaKey, value.mediaKey);
assert(/^en(?:-|$)/i.test(value.track.language)); assert.equal(c.track.language, value.track.language);
assert.equal(value.track.sync.offsetMs, 0); assert.equal(value.track.sync.scale, 1);
assert.equal(value.track.provenance, 'netflix-manifest-resource');
const hash = b => createHash('sha256').update(b).digest('hex');
let rawBytes = Buffer.from(value.rawText, 'utf8'), bomReconstructed = false;
if (hash(rawBytes) !== c.resourceSha256) {
  // TextDecoder strips an optional UTF-8 BOM. Verify the original byte hash,
  // rather than trusting a changed hash or silently normalizing the source.
  rawBytes = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), rawBytes]);
  bomReconstructed = true;
}
assert.equal(hash(rawBytes), c.resourceSha256, 'Original downloaded resource byte hash differs');
assert.equal(rawBytes.length, c.resourceBytes);
const parsed = netflix.parseAsset(value.rawText, core, DOMParser);
assert.deepEqual(parsed.cues, value.track.cues, 'Independent source reparse differs');
assert.deepEqual(parsed.audit, c.audit, 'Independent accounting differs');
assert.equal(c.cueCount, parsed.cues.length);
assert.equal(c.startMs, Math.min(...parsed.cues.map(x=>x.startMs)));
assert.equal(c.endMs, Math.max(...parsed.cues.map(x=>x.endMs)));
const fullResource = /^(webvtt-lssdh-ios8|dfxp-ls-sdh)$/.test(c.track.profile) && !c.track.segmented &&
  parsed.audit.documentComplete && parsed.audit.allTimedEntriesAccountedFor;
assert.equal(c.fullEpisode, fullResource);
assert.equal(c.coverage, fullResource ? 'complete' : 'partial');
const vtt = core.serializeVtt(parsed.cues);
assert.deepEqual(core.parse(vtt,'source.vtt').cues, parsed.cues);
const audit = { episode: expectedId === '70262107' ? 'S02E03' : null, videoId: expectedId, mediaKey:value.mediaKey,
  capturedAt:c.capturedAt, inspectedAt:new Date().toISOString(),track:c.track,
  coverage:fullResource?'complete-resource':'partial',fullEpisodeResourceAcquired:fullResource,
  basis:c.basis, independentByteHashVerified:true, independentReparseMatches:true,
  inputCount:parsed.audit.inputCount,acceptedCount:parsed.audit.acceptedCount,excludedCount:parsed.audit.excludedCount,
  excluded:parsed.audit.excluded,warnings:parsed.audit.warnings,
  startMs:c.startMs,endMs:c.endMs,bomReconstructed,
  resourceBytes:rawBytes.length,resourceSha256:c.resourceSha256,captureJsonSha256:hash(bytes),
  externalSubtitleInputUsed:false,lastTimestampAloneUsedForCoverage:false,
  limitation:'Full-resource determination uses the current playback manifest single-file text profile plus complete-body parsing/accounting. It is not an audio transcription audit, a subtitle-language quality guarantee, or a claim that every spoken word is captioned.'};
const dir = resolve(output);
await mkdir(dir,{recursive:false});
await writeFile(join(dir,'capture.original.json'),bytes,{flag:'wx'});
await writeFile(join(dir,`netflix.original.${parsed.format==='vtt'?'vtt':'ttml'}`),rawBytes,{flag:'wx'});
await writeFile(join(dir,'netflix.en.vtt'),vtt,{flag:'wx'});
await writeFile(join(dir,'capture-audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...audit,outputDirectory:dir},null,2));
