// Usage: node scripts/subtitle-response.mjs REQUEST OUTPUT_PREFIX RESPONSE
// or:    node scripts/subtitle-response.mjs REQUEST OUTPUT_PREFIX --chunks MANIFEST PART1 PART2 ...
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import core from '../subtitles/core.js';
import { verifySavedRequest, mergeResponses, sha256 } from './subtitle-preparation.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
try {
  const [requestPath, prefix, ...inputs] = process.argv.slice(2);
  assert.ok(requestPath && prefix && inputs.length, 'Usage: REQUEST OUTPUT_PREFIX RESPONSE | --chunks MANIFEST PART1 PART2 ...');
  const request = await json(requestPath);
  await verifySavedRequest(request);
  let response, track;
  if (inputs[0] === '--chunks') {
    assert.ok(inputs.length >= 3, 'A chunk manifest and all response files are required');
    const manifest = await json(inputs[1]);
    ({ response, track } = mergeResponses(request, manifest, await Promise.all(inputs.slice(2).map(json))));
  } else {
    assert.equal(inputs.length, 1, 'Provide one whole response or use --chunks');
    response = await json(inputs[0]);
    for (const cue of response.cues || []) assert.deepEqual(Object.keys(cue).sort(), ['id', 'text'], `${cue.id}: return id and text only`);
    track = core.validateTranslationResponse(response, request);
  }
  const files = {
    [`${prefix}.translation-response.json`]: JSON.stringify(response, null, 2) + '\n',
    [`${prefix}.ko.B.vtt`]: core.serializeVtt(track.cues),
    [`${prefix}.ko.B.srt`]: core.serializeSrt(track.cues),
    [`${prefix}.response-validation.json`]: JSON.stringify({ requestId: request.requestId, sourceHash: request.sourceHash,
      mediaKey: request.mediaKey, slots: track.cues.length, structureVerified: true,
      responseSha256: sha256(JSON.stringify(response)), translationMeaningVerified: false,
      netflixTimingVerified: false, timingCorrectionApplied: false, offsetMs: 0, scale: 1 }, null, 2) + '\n'
  };
  // Validate everything, including export, before writing any B. Never overwrite a prior B.
  for (const path of Object.keys(files)) {
    let exists = false; try { await access(path); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(!exists, `Output already exists: ${path}`);
  }
  await mkdir(dirname(prefix), { recursive: true });
  for (const [path, text] of Object.entries(files)) await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
  console.log(`PASS ${track.cues.length} slots; wrote B with original request times. Meaning and Netflix timing remain unverified.`);
} catch (error) {
  console.error(`${error.code || 'INVALID_EXCHANGE'}: ${error.message}`);
  process.exitCode = 1;
}
