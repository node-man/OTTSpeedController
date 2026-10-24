// Only original synthetic fixtures; never copy private episode text here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import core from '../subtitles/core.js';
import { parseSami, recoverTrack, makeChunks, mergeResponses, verifySavedRequest } from '../scripts/subtitle-preparation.mjs';

const event = (id, start_ms, text) => ({ id, start_ms, text });
const cue = (id, startMs, endMs, text = 'Synthetic sentence.') => ({ id, startMs, endMs, text });
const media = 'file:///';

test('SAMI parser separates language states and preserves unknown literal markup', () => {
  const parsed = parseSami('<SAMI><!-- <SYNC Start=99> --><SYNC Start=10><P Class=KRCC>A<br>B &amp; C<SYNC Start=20><P Class=KRCC>&nbsp;<SYNC Start=10><P Class=ENCC><odd>Text</SAMI>', 'TEST');
  assert.deepEqual(parsed.KRCC.map(e => [e.start_ms, e.text]), [[10, 'A\nB & C'], [20, '']]);
  assert.equal(parsed.ENCC[0].text, '<odd>Text');
  assert.equal(parsed.ENCC[0].source_sync_index, 3);
  assert.throws(() => parseSami('<SYNC Start=oops><P Class=ENCC>Text', 'TEST'));
});

test('only an explicitly detached card can resolve a reversal; dialogue times remain unchanged', () => {
  const events = [event('speech', 100, 'Spoken text.'), event('clear', 500, ''), event('card', 450, 'Screen label'), event('end', 700, '')];
  assert.throws(() => recoverTrack(events), /Unresolved reversal/);
  const result = recoverTrack(events, { detachedCardIds: ['card'] });
  assert.deepEqual(result.cues, [cue('speech', 100, 500, 'Spoken text.'), cue('card', 450, 700, 'Screen label')]);
  assert.equal(result.changes[0].retainedOverlapMs, 50);
  assert.equal(events[1].start_ms, 500);
});

test('equal-time speech is held unless both texts are explicitly preserved together', () => {
  const events = [event('a', 100, 'Yes.'), event('b', 100, 'Second synthetic line.'), event('end', 700, '')];
  assert.throws(() => recoverTrack(events), /Unresolved reversal/);
  const result = recoverTrack(events, { mergeGroups: [['a', 'b']] });
  assert.equal(result.cues[0].text, 'Yes.\nSecond synthetic line.');
  assert.equal(result.cues[0].endMs, 700);
  assert.deepEqual(result.mapping[0].sourceIds, ['a', 'b']);
  assert.equal(result.nonemptySourceEvents, 2);
  assert.equal(result.changes[0].timingReconstructed, false);
});

test('explicit supplemental slots are hashed, kept in the template and bound on return', async () => {
  const source = { cues: [cue('en', 100, 500)] }, reference = { cues: [cue('ko-card', 600, 900, '합성 화면 표기')] };
  const request = await core.makeTranslationRequest({ media, source, reference, outputSlots: [...source.cues, ...reference.cues] });
  assert.deepEqual(request.slots.map(c => c.id), ['en', 'ko-card']);
  await verifySavedRequest(request);
  const changed = structuredClone(request); changed.slots[1].endMs++;
  await assert.rejects(() => verifySavedRequest(changed), /hash no longer matches/);
  const defaults = await core.makeTranslationRequest({ media, source, reference });
  assert.notEqual(defaults.sourceHash, request.sourceHash);
  assert.throws(() => core.validateTranslationResponse({ ...request.outputTemplate, cues: [{ id: 'en', text: '합성 결과' }] }, request), { code: 'MISSING_ID' });
});

test('chunks own every slot once and keep neighboring context out of the response', async () => {
  const source = { cues: Array.from({ length: 35 }, (_, i) => cue(`e-${i}`, i * 2000, i * 2000 + 1000)) };
  const request = await core.makeTranslationRequest({ media, source });
  const chunks = makeChunks(request, 10);
  assert.deepEqual(chunks.flatMap(c => c.ownedSlotIds), request.slots.map(c => c.id));
  for (const chunk of chunks) {
    assert.deepEqual(chunk.outputTemplate.cues.map(c => c.id), chunk.ownedSlotIds);
    assert.ok(chunk.readOnlyContext.neighboringSlots.every(c => !chunk.ownedSlotIds.includes(c.id)));
  }
  const manifest = { kind: 'ottspeed.translation-chunk-manifest', schemaVersion: 1,
    requestId: request.requestId, sourceHash: request.sourceHash, mediaKey: request.mediaKey, chunks };
  const responses = chunks.map(c => ({ ...c.outputTemplate, cues: c.ownedSlotIds.map(id => ({ id, text: '합성 검토 결과' })) }));
  const merged = mergeResponses(request, manifest, responses);
  assert.equal(merged.track.cues.length, 35);
  const broken = structuredClone(responses); broken[0].cues.pop();
  assert.throws(() => mergeResponses(request, manifest, broken), /missing=e-/);
  const extra = structuredClone(responses); extra[0].cues.push(extra[1].cues[0]);
  assert.throws(() => mergeResponses(request, manifest, extra), /extra=e-/);
  const wrong = structuredClone(responses); wrong[0].sourceHash = 'wrong';
  assert.throws(() => mergeResponses(request, manifest, wrong), /sourceHash mismatch/);
  const empty = structuredClone(responses); empty[0].cues[0].text = '';
  assert.throws(() => mergeResponses(request, manifest, empty), /empty translation/);
});

test('file CLI writes B only after whole validation and refuses stale data or overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ottspeed-exchange-'));
  try {
    const request = await core.makeTranslationRequest({ media, source: { cues: [cue('s', 100, 900)] } });
    const response = { ...request.outputTemplate, cues: [{ id: 's', text: '독립 합성 결과' }] };
    const requestFile = join(directory, 'request.json'), responseFile = join(directory, 'response.json');
    await writeFile(requestFile, JSON.stringify(request)); await writeFile(responseFile, JSON.stringify(response));
    const cli = fileURLToPath(new URL('../scripts/subtitle-response.mjs', import.meta.url));
    const run = prefix => spawnSync(process.execPath, [cli, requestFile, join(directory, prefix), responseFile], { encoding: 'utf8' });
    assert.equal(run('valid').status, 0);
    const before = await readFile(join(directory, 'valid.ko.B.vtt'), 'utf8');
    assert.deepEqual(core.parse(before, 'synthetic.vtt').cues, [cue('s', 100, 900, '독립 합성 결과')]);
    assert.equal(run('valid').status, 1);
    assert.equal(await readFile(join(directory, 'valid.ko.B.vtt'), 'utf8'), before);
    await writeFile(responseFile, JSON.stringify({ ...response, requestId: 'stale' }));
    assert.equal(run('rejected').status, 1);
    assert.ok(!(await readdir(directory)).some(name => name.startsWith('rejected')));
    await writeFile(responseFile, JSON.stringify(response));
    request.slots[0].endMs++;
    await writeFile(requestFile, JSON.stringify(request));
    assert.equal(run('tampered').status, 1);
    assert.ok(!(await readdir(directory)).some(name => name.startsWith('tampered')));
  } finally {
    const resolved = resolve(directory), parent = resolve(tmpdir());
    assert.ok(resolved.startsWith(parent + sep) && basename(resolved).startsWith('ottspeed-exchange-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
