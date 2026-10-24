// File preparation only: no network, translation, inferred dialogue times, or global event sorting.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import core from '../subtitles/core.js';

export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function parseSami(source, episodeId) {
  const clean = source.replace(/<!--[^]*?-->/g, '');
  const boundaries = [...clean.matchAll(/<sync\b/gi)];
  const tracks = {};
  for (let index = 0; index < boundaries.length; index++) {
    const raw = clean.slice(boundaries[index].index, boundaries[index + 1]?.index);
    const opening = /^<sync\b([^<>]*)>\s*<p\b([^<>]*)>/i.exec(raw);
    assert.ok(opening, `Malformed SYNC/P at ${index + 1}`);
    const time = /\bstart\s*=\s*["']?(-?\d+)(?=[\s"']|$)/i.exec(opening[1]);
    const cls = /\bclass\s*=\s*["']?([^\s>"']+)/i.exec(opening[2])?.[1].toUpperCase();
    assert.ok(time && ['KRCC', 'ENCC', 'EGCC'].includes(cls), `Invalid SYNC at ${index + 1}`);
    let payload = raw.slice(opening[0].length);
    assert.ok(!/<p\b/i.test(payload), 'Nested language paragraphs require review');
    payload = payload.replace(/<br\b[^<>]*>/gi, '\ue000').replace(/<\/?(?:font|i|b|u|p|body|sami)\b[^<>]*>/gi, '');
    // Escape remaining angle brackets before entity decoding: unknown markup is data.
    const text = core.plainText(payload.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .split('\ue000').map(line => line.replace(/\s+/gu, ' ').trim()).join('\n').trim();
    const events = tracks[cls] ||= [];
    events.push({ id: `${episodeId}-${cls}-${String(events.length + 1).padStart(5, '0')}`, source_sync_index: index + 1, start_ms: Number(time[1]), text });
  }
  return tracks;
}

export function recoverTrack(events, { detachedCardIds = [], mergeGroups = [] } = {}) {
  const changes = [], cards = [], mapping = [];
  const detached = new Set(detachedCardIds);
  assert.equal(detached.size, detachedCardIds.length);
  for (const id of detached) assert.ok(events.some(event => event.id === id), `Missing card ${id}`);
  const states = [];
  for (let index = 0; index < events.length; index++) {
    const event = structuredClone(events[index]);
    if (!detached.has(event.id)) { states.push({ ...event, sourceIds: [event.id] }); continue; }
    const previous = events[index - 1], next = events[index + 1];
    assert.ok(event.text && previous && !previous.text && next && next.start_ms > event.start_ms,
      `A detached card needs an adjacent clear and a known end: ${event.id}`);
    cards.push({ id: event.id, startMs: event.start_ms, endMs: next.start_ms, text: event.text });
    mapping.push({ outputId: event.id, sourceIds: [event.id], role: 'detached-nondialogue-card' });
    changes.push({ code: 'detach_nondialogue_card_from_state_sequence', eventId: event.id,
      sourceStartMs: event.start_ms, sourceEndEventId: next.id, endMs: next.start_ms,
      previousClearId: previous.id, previousClearMs: previous.start_ms,
      retainedOverlapMs: Math.max(0, previous.start_ms - event.start_ms), dialogueTimesChanged: false });
  }
  for (const ids of mergeGroups) {
    const index = states.findIndex(event => event.id === ids[0]);
    const group = states.slice(index, index + ids.length);
    assert.ok(index >= 0 && ids.length >= 2);
    assert.deepEqual(group.map(event => event.id), ids, 'Merge must name adjacent source events');
    assert.ok(group.every(event => event.text && event.start_ms === group[0].start_ms));
    const next = states[index + ids.length];
    assert.ok(next && next.start_ms > group[0].start_ms, 'A merge needs a known later boundary');
    const merged = { ...group[0], text: group.map(event => event.text).join('\n'), sourceIds: ids };
    states.splice(index, group.length, merged);
    changes.push({ code: 'same_time_texts_preserved_in_one_display', sourceIds: ids,
      outputId: merged.id, startMs: merged.start_ms, endMs: next.start_ms,
      order: 'source-file-order', timingReconstructed: false, videoReviewRequired: true });
  }
  const cues = [];
  for (let index = 0; index < states.length; index++) {
    const state = states[index], next = states[index + 1];
    assert.ok(Number.isSafeInteger(state.start_ms) && state.start_ms >= 0, `Invalid time ${state.id}`);
    if (next) assert.ok(next.start_ms > state.start_ms, `Unresolved reversal/equal time at ${next.id}`);
    if (!state.text) continue;
    assert.ok(next, `No end event for ${state.id}`);
    const text = state.text.replace(/\n[\t ]*\n+/g, '\n');
    if (text !== state.text) changes.push({ code: 'collapse_blank_display_lines', eventId: state.id });
    cues.push({ id: state.id, startMs: state.start_ms, endMs: next.start_ms, text });
    mapping.push({ outputId: state.id, sourceIds: state.sourceIds, role: 'original-state' });
  }
  // Insert only explicitly detached cards into an already validated sequence.
  for (const card of cards) {
    const index = cues.findIndex(cue => cue.startMs > card.startMs);
    cues.splice(index < 0 ? cues.length : index, 0, card);
  }
  const accounted = mapping.flatMap(entry => entry.sourceIds);
  assert.deepEqual([...accounted].sort(), events.filter(event => event.text).map(event => event.id).sort(),
    'Every nonempty source event must be represented exactly once');
  const vtt = core.serializeVtt(cues);
  assert.deepEqual(core.parse(vtt, 'recovered.vtt').cues, cues);
  return { cues, mapping, changes, sourceEvents: events.length, nonemptySourceEvents: accounted.length };
}

export function alignment(source, reference) {
  const map = (left, right) => left.map(cue => {
    const matches = right.filter(other => cue.startMs < other.endMs && other.startMs < cue.endMs);
    return { id: cue.id, startMs: cue.startMs, endMs: cue.endMs,
      overlappingIds: matches.map(other => other.id),
      relation: matches.length ? 'temporal-candidates-only' : 'no-temporal-counterpart',
      semanticVerified: false };
  });
  return { method: 'strict interval overlap; not numbering or semantic alignment',
    sourceToReference: map(source, reference), referenceToSource: map(reference, source) };
}

export function makeChunks(request, targetSize = 110) {
  assert.ok(Number.isInteger(targetSize) && targetSize > 0);
  const chunks = [];
  for (let start = 0; start < request.slots.length;) {
    let end = Math.min(start + targetSize, request.slots.length);
    if (end < request.slots.length) {
      const low = Math.max(start + 1, end - 20), high = Math.min(end + 20, request.slots.length - 1);
      let best = null;
      for (let at = low; at <= high; at++) {
        const previous = request.slots[at - 1], next = request.slots[at];
        // Prefer an observed silence after sentence-ending punctuation.
        const gap = next.startMs - previous.endMs;
        if (gap >= 400 && /[.!?…。？！]["'’”)]*$/.test(previous.text)) {
          const score = gap - Math.abs(at - end) * 50;
          if (!best || score > best.score) best = { at, score };
        }
      }
      if (best) end = best.at;
      // Never split cues sharing time or overlapping a previous owned cue.
      let maximumEnd = Math.max(...request.slots.slice(start, end).map(cue => cue.endMs));
      while (end < request.slots.length && request.slots[end].startMs < maximumEnd) {
        maximumEnd = Math.max(maximumEnd, request.slots[end++].endMs);
      }
    }
    const owned = request.slots.slice(start, end);
    const fromMs = Math.max(0, owned[0].startMs - 20000), toMs = Math.max(...owned.map(cue => cue.endMs)) + 20000;
    const ownedIds = new Set(owned.map(cue => cue.id));
    const context = {
      source: request.source.cues.filter(cue => cue.startMs < toMs && cue.endMs > fromMs),
      reference: (request.reference?.cues || []).filter(cue => cue.startMs < toMs && cue.endMs > fromMs),
      neighboringSlots: request.slots.slice(Math.max(0, start - 8), Math.min(request.slots.length, end + 8)).filter(cue => !ownedIds.has(cue.id))
    };
    chunks.push({ kind: 'ottspeed.translation-chunk', schemaVersion: 1,
      chunkId: `part-${String(chunks.length + 1).padStart(2, '0')}`,
      requestId: request.requestId, sourceHash: request.sourceHash, mediaKey: request.mediaKey,
      ownedSlotIds: [...ownedIds], ownedSlots: owned, readOnlyContext: context,
      boundary: end === request.slots.length ? 'end-of-track' :
        request.slots[end].startMs - request.slots[end - 1].endMs >= 400 ? 'observed-gap' : 'continuous-speech-use-readonly-context',
      outputTemplate: { ...request.outputTemplate, cues: owned.map(cue => ({ id: cue.id, text: '' })) } });
    start = end;
  }
  return chunks;
}

export async function verifySavedRequest(request) {
  assert.equal(request.kind, 'ottspeed.translation-request');
  assert.equal(request.schemaVersion, 1);
  const reconstructed = await core.makeTranslationRequest({ media: request.media, source: request.source,
    reference: request.reference, mode: request.mode, outputSlots: request.slots });
  assert.equal(reconstructed.mediaKey, request.mediaKey);
  assert.equal(reconstructed.sourceHash, request.sourceHash, 'Saved request hash no longer matches its source/reference/slots');
  assert.deepEqual(request.outputTemplate, { kind: 'ottspeed.translation-response', schemaVersion: 1,
    requestId: request.requestId, sourceHash: request.sourceHash, mediaKey: request.mediaKey,
    cues: request.slots.map(cue => ({ id: cue.id, text: '' })) });
}

export function mergeResponses(request, manifest, responses) {
  for (const field of ['requestId', 'sourceHash', 'mediaKey']) assert.equal(manifest[field], request[field], `Manifest ${field} mismatch`);
  assert.equal(manifest.kind, 'ottspeed.translation-chunk-manifest');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(responses.length, manifest.chunks.length, 'All chunk responses are required');
  const ids = manifest.chunks.flatMap(chunk => chunk.ownedSlotIds);
  assert.equal(new Set(ids).size, ids.length, 'Chunk ownership overlaps');
  assert.deepEqual(ids, request.slots.map(cue => cue.id), 'Chunk ownership must cover the exact saved slot sequence');
  const all = [];
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index], chunk = manifest.chunks[index];
    assert.deepEqual(Object.keys(response).sort(), ['kind', 'schemaVersion', 'requestId', 'sourceHash', 'mediaKey', 'cues'].sort(), `Unsupported fields in ${chunk.chunkId}`);
    assert.equal(response.kind, 'ottspeed.translation-response');
    assert.equal(response.schemaVersion, 1);
    for (const field of ['requestId', 'sourceHash', 'mediaKey']) assert.equal(response[field], request[field], `${chunk.chunkId} ${field} mismatch`);
    assert.ok(Array.isArray(response.cues), `Missing cues in ${chunk.chunkId}`);
    const actual = response.cues.map(cue => cue.id);
    const missing = chunk.ownedSlotIds.filter(id => !actual.includes(id));
    const extra = actual.filter(id => !chunk.ownedSlotIds.includes(id));
    assert.ok(!missing.length && !extra.length && new Set(actual).size === actual.length,
      `${chunk.chunkId}: missing=${missing.join(',')} extra=${extra.join(',')} duplicates=${actual.filter((id, at) => actual.indexOf(id) !== at).join(',')}`);
    for (const cue of response.cues) {
      assert.deepEqual(Object.keys(cue).sort(), ['id', 'text'], `${chunk.chunkId} ${cue.id}: return id and text only`);
      assert.ok(typeof cue.text === 'string' && cue.text.trim(), `${chunk.chunkId} ${cue.id}: empty translation`);
    }
    all.push(...response.cues);
  }
  const response = { ...request.outputTemplate, cues: all };
  // Partial results are never passed to the whole-request validator.
  const track = core.validateTranslationResponse(response, request);
  return { response, track };
}
