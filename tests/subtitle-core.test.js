'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../subtitles/core.js');

const cue = (id, startMs, endMs, text = 'A caption.') => ({ id, startMs, endMs, text });
const expectCode = (operation, code) => assert.throws(operation, error => error instanceof core.SubtitleError && error.code === code);
const source = { cues: [cue('en-1', 1000, 2000, 'We need a vote.'), cue('en-2', 1900, 3000, 'Not today.')] };
const media = core.mediaIdentity('https://www.netflix.com/watch/80123456?trackId=secret#t=1');

function responseFor(request) {
  return { ...request.outputTemplate, cues: request.slots.map((slot, index) => ({ id: slot.id, text: `${index + 1}번 번역입니다.` })) };
}

test('SRT preserves line breaks, strips recognized markup, decodes entities, and sorts stably', () => {
  const result = core.parse('\ufeff2\r\n00:00:02,000 --> 00:00:03,001\r\n<i>Second &amp; later.</i>\r\nOne more line.\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,500\r\nFirst.\r\n\r\n3\r\n00:00:02,000 --> 00:00:04,000\r\nThird.\r\n', 'episode.srt');
  assert.equal(result.format, 'srt');
  assert.deepEqual(result.cues.map(item => item.id), ['1', '2', '3']);
  assert.equal(result.cues[1].text, 'Second & later.\nOne more line.');
  assert.equal(result.cues[1].endMs, 3001);
  assert.equal(result.warnings.length, 1);
});

test('WebVTT supports metadata blocks, IDs, short timestamps, settings and markup', () => {
  const input = 'WEBVTT - synthetic fixture\nKind: captions\nLanguage: en\n\nNOTE source comment\nThis is not a caption.\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:region1\nwidth:40%\n\nopening\n00:01.010 --> 00:03.020 align:start line:90% position:50%,center\n<v Speaker><c.yellow>Hello <00:02.000><b>there</b>.</c></v>\n\n00:04.000 --> 00:05.000\n<lang en-US>Next</lang><br>line.\n';
  const result = core.parse(input, 'episode.vtt');
  assert.equal(result.format, 'vtt');
  assert.equal(result.cues.length, 2);
  assert.deepEqual(result.cues[0], cue('opening', 1010, 3020, 'Hello there.'));
  assert.equal(result.cues[1].text, 'Next\nline.');
  assert.deepEqual(result.warnings, []);
});

test('generated IDs cannot collide with explicit VTT IDs', () => {
  const result = core.parse('WEBVTT\n\n00:00.000 --> 00:01.000\nOne.\n\ncue-00001\n00:01.000 --> 00:02.000\nTwo.\n');
  assert.deepEqual(result.cues.map(item => item.id), ['cue-00001-1', 'cue-00001']);
});

test('malformed files fail instead of silently dropping blocks', () => {
  const invalid = [
    ['', 'EMPTY_TRACK'],
    ['A paragraph without timing.', 'MISSING_TIMING'],
    ['1\n00:01,000 --> 00:02,000\nBad.\n', 'INVALID_TIMING'],
    ['1\n00:60:00,000 --> 00:61:00,000\nBad.\n', 'INVALID_TIMING'],
    ['1\n00:00:01,00 --> 00:00:02,000\nBad.\n', 'INVALID_TIMING'],
    ['1\n-00:00:01,000 --> 00:00:02,000\nBad.\n', 'INVALID_TIMING'],
    ['1\n00:00:01,000 --> Infinity\nBad.\n', 'INVALID_TIMING'],
    ['1\n00:00:01,000 --> 00:00:01,000\nBad.\n', 'INVALID_TIMING'],
    ['1\n00:00:02,000 --> 00:00:01,000\nBad.\n', 'INVALID_TIMING'],
    ['1\n00:00:01,000 --> 00:00:02,000 garbage\nBad.\n', 'INVALID_TIMING'],
    ['1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n', 'INVALID_TEXT'],
    ['1\n00:00:01,000 --> 00:00:02,000\nOne.\n\n1\n00:00:02,000 --> 00:00:03,000\nTwo.', 'DUPLICATE_ID'],
    ['1\n00:00:01,000 --> 00:00:02,000\nOne.\n2\n00:00:02,000 --> 00:00:03,000\nTwo.', 'MISSING_SEPARATOR'],
    ['WEBVTT\n00:00.000 --> 00:01.000\nNo blank line.', 'INVALID_HEADER'],
    ['WEBVTT\n\n00:00,000 --> 00:01,000\nWrong separator.', 'INVALID_TIMING'],
    ['WEBVTT\n\nNOTE only a note.', 'EMPTY_TRACK']
  ];
  for (const [input, code] of invalid) expectCode(() => core.parse(input), code);
  expectCode(() => core.parse('00:00.000 --> 00:01.000\nNo header.', 'bad.vtt'), 'INVALID_HEADER');
  expectCode(() => core.parse(null), 'INVALID_INPUT');
});

test('size and cue count limits are enforced for UTF-8 and programmatic tracks', () => {
  expectCode(() => core.parse('한'.repeat(Math.floor(core.limits.maxBytes / 3) + 1)), 'TOO_LARGE');
  expectCode(() => core.createIndex(Array.from({ length: 20001 }, (_, i) => cue(String(i), i, i + 1))), 'TOO_MANY_CUES');
  expectCode(() => core.createIndex([cue('same', 0, 1), cue('same', 1, 2)]), 'DUPLICATE_ID');
  expectCode(() => core.createIndex([cue(' padded ', 0, 1)]), 'INVALID_ID');
  for (const start of [NaN, Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) expectCode(() => core.createIndex([cue('bad', start, start + 1000)]), 'INVALID_TIMING');
});

test('unknown and hostile markup remains literal; escaped caption tags stay literal', () => {
  const raw = '<i>Known</i> <font color="red">tag</font> <there was going to be a vote> &lt;b&gt;literal&lt;/b&gt; <script>globalThis.pwned=true</script> <img src=x onerror=alert(1)>';
  const text = core.plainText(raw);
  assert.equal(text, 'Known tag <there was going to be a vote> <b>literal</b> <script>globalThis.pwned=true</script> <img src=x onerror=alert(1)>');
  assert.equal(globalThis.pwned, undefined);
  assert.equal(core.plainText('&#x1F600; &#39; &#0; &unknown;'), "😀 ' � &unknown;");
});

test('VTT serialization preserves cue identity, time and literal text without markup execution', () => {
  const cues = [cue('alpha', 0, 1234, '<script>alert(1)</script> & <i>literal</i>\nSecond line.'), cue('beta', 1000, 2500, '한글 자막')];
  const vtt = core.serializeVtt(cues);
  assert.ok(vtt.includes('&lt;script&gt;'));
  assert.deepEqual(core.parse(vtt, 'roundtrip.vtt').cues, cues);
  const srt = core.parse(core.serializeSrt(cues), 'roundtrip.srt').cues;
  assert.deepEqual(srt.map(({ id, ...rest }) => rest), cues.map(({ id, ...rest }) => rest));
  assert.deepEqual(srt.map(item => item.id), ['1', '2']);
  assert.equal(core.parse(core.serializeVtt([cue('blank-line', 0, 1, 'One\n\nTwo')])).cues[0].text, 'One\nTwo');
});

test('VTT export rejects reserved IDs atomically without losing or renaming source cues', () => {
  for (const id of ['NOTE', 'NOTE explanation', 'NOTE\tmetadata', 'STYLE', 'REGION']) {
    const cues = [cue('valid', 0, 1000), cue(id, 1000, 2000, 'Keep this literal caption.')];
    const original = structuredClone(cues);
    expectCode(() => core.serializeVtt(cues), 'INVALID_ID');
    assert.deepEqual(cues, original);
    // SRT can still export the content using its sequential numeric IDs.
    assert.equal(core.parse(core.serializeSrt(cues)).cues[1].text, 'Keep this literal caption.');
  }
  for (const id of ['NOTEworthy', 'STYLE-1', 'REGION-1', 'note']) {
    const cues = [cue(id, 0, 1000)];
    assert.deepEqual(core.parse(core.serializeVtt(cues)).cues, cues);
  }
});

test('index handles overlapping cues, equal starts, gaps, boundaries and backwards seeks', () => {
  const a = cue('a', 1000, 10000);
  const b = cue('b', 3000, 4000);
  const c = cue('c', 3000, 5000);
  const d = cue('d', 7000, 8000);
  const input = [d, a, b, c];
  const index = core.createIndex(input);
  assert.deepEqual(input, [d, a, b, c]);
  assert.equal(core.activeCues(index, 1000)[0], a);
  const idsAt = time => core.activeCues(index, time).map(item => item.id);
  assert.deepEqual(idsAt(-1), []);
  assert.deepEqual(idsAt(0), []);
  assert.deepEqual(idsAt(3000), ['a', 'b', 'c']);
  assert.deepEqual(idsAt(4000), ['a', 'c']);
  assert.deepEqual(idsAt(6500), ['a']);
  assert.deepEqual(idsAt(7500), ['a', 'd']);
  assert.deepEqual(idsAt(10000), []);
  assert.deepEqual(idsAt(3500), ['a', 'b', 'c']);
  assert.deepEqual(core.activeCues(core.createIndex([]), 0), []);
});

test('sync uses media = subtitle * scale + offset with exclusive end bounds', () => {
  const index = core.createIndex([cue('one', 1000, 2000)]);
  assert.equal(core.activeCues(index, 2500, { offsetMs: 500, scale: 2 }).length, 1);
  assert.equal(core.activeCues(index, 4499, { offsetMs: 500, scale: 2 }).length, 1);
  assert.equal(core.activeCues(index, 4500, { offsetMs: 500, scale: 2 }).length, 0);
  assert.equal(core.activeCues(index, 500, { offsetMs: -500 }).length, 1);
  for (const scale of [0, -1, NaN, Infinity, '1']) expectCode(() => core.activeCues(index, 1000, { scale }), 'INVALID_SYNC');
  expectCode(() => core.activeCues(index, 1000, { offsetMs: Infinity }), 'INVALID_SYNC');
  expectCode(() => core.activeCues(index, NaN), 'INVALID_SYNC');
});

test('platform identities are canonical and remove tracking parameters and credentials', () => {
  assert.equal(media.key, 'netflix:80123456');
  assert.equal(media.url, 'https://www.netflix.com/watch/80123456');
  assert.equal(media.supportedPlatform, true);
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXc&token=secret', 'https://youtu.be/dQw4w9WgXc?t=12', 'https://m.youtube.com/shorts/dQw4w9WgXc#private', 'https://www.youtube.com/embed/dQw4w9WgXc']) {
    assert.deepEqual(core.mediaIdentity(url), { key: 'youtube:dQw4w9WgXc', platform: 'youtube', videoId: 'dQw4w9WgXc', url: 'https://www.youtube.com/watch?v=dQw4w9WgXc', supportedPlatform: true });
  }
  const generic = core.mediaIdentity('https://user:password@video.example/player?access_token=secret#private');
  assert.deepEqual(generic, { key: 'url:https://video.example/player', platform: 'generic', videoId: null, url: 'https://video.example/player', supportedPlatform: false });
  assert.equal(core.mediaIdentity('https://youtube.com.evil.test/watch?v=dQw4w9WgXc').supportedPlatform, false);
  assert.equal(core.mediaIdentity('https://www.netflix.com/browse?token=secret').supportedPlatform, false);
  assert.deepEqual(core.mediaIdentity('file:///Users/private-user/Videos/private-episode.html#secret'), { key: 'url:file:///', platform: 'generic', videoId: null, url: 'file:///', supportedPlatform: false });
  expectCode(() => core.mediaIdentity('javascript:alert(1)'), 'INVALID_MEDIA');
});

test('generic runtime keys stay bound to their URL, document, video and source generation', async () => {
  const identity = core.mediaIdentity('https://video.example/player?token=secret');
  const suffix = ':document:9d2bea96-facb-4c99-9e6c-7c9d864ec41f:video:2:source:3';
  const runtimeMedia = { ...identity, key: identity.key + suffix };
  const request = await core.makeTranslationRequest({ media: runtimeMedia, source });
  assert.equal(request.mediaKey, runtimeMedia.key);
  assert.equal(request.media.key, runtimeMedia.key);
  assert.equal(request.outputTemplate.mediaKey, runtimeMedia.key);
  assert.equal(core.validateTranslationResponse(responseFor(request), request).cues.length, 2);
  const nextSource = await core.makeTranslationRequest({ media: { ...runtimeMedia, key: runtimeMedia.key.replace(':source:3', ':source:4') }, source });
  assert.notEqual(request.sourceHash, nextSource.sourceHash);
  for (const badKey of [
    'url:https://other.example/player' + suffix,
    identity.key + ':document:not-a-uuid:video:2:source:3',
    identity.key + suffix.replace(':video:2', ':video:-2'),
    identity.key + suffix.replace(':source:3', ':source:9007199254740992'),
    identity.key + suffix + ':extra:secret'
  ]) {
    await assert.rejects(() => core.makeTranslationRequest({ media: { ...identity, key: badKey }, source }), { code: 'INVALID_MEDIA' });
  }
  await assert.rejects(() => core.makeTranslationRequest({ media: { ...media, key: media.key + suffix }, source }), { code: 'INVALID_MEDIA' });
  const local = core.mediaIdentity('file:///Users/private-user/episode.html');
  local.key += suffix;
  const localRequest = await core.makeTranslationRequest({ media: local, source });
  assert.equal(localRequest.mediaKey, local.key);
  assert.equal(localRequest.media.url, 'file:///');
  assert.equal(JSON.stringify(localRequest).includes('private-user'), false);
});

test('translation roundtrip binds its snapshot and restores trusted slot timings', async () => {
  const request = await core.makeTranslationRequest({ media, source });
  assert.match(request.requestId, /^[\da-f-]{36}$/);
  assert.match(request.sourceHash, /^[\da-f]{64}$/);
  assert.equal(request.kind, 'ottspeed.translation-request');
  assert.equal(request.source.language, 'en');
  assert.equal(request.reference, null);
  assert.equal(request.media.url.includes('secret'), false);
  assert.ok(request.instructions.some(instruction => instruction.includes('부정')));
  const response = responseFor(request);
  response.cues.reverse();
  const result = core.validateTranslationResponse(response, request);
  assert.deepEqual(result.cues, [cue('en-1', 1000, 2000, '1번 번역입니다.'), cue('en-2', 1900, 3000, '2번 번역입니다.')]);
  assert.notEqual(request.source.cues[0], source.cues[0]);
  assert.notEqual(request.slots[0], request.source.cues[0]);
  const repeated = await core.makeTranslationRequest({ media, source });
  assert.equal(repeated.sourceHash, request.sourceHash);
  assert.notEqual(repeated.requestId, request.requestId);
  expectCode(() => core.validateTranslationResponse(response, repeated), 'STALE_RESPONSE');
});

test('edit mode uses Korean slots and hashes source and reference IDs, timings and text', async () => {
  const reference = { cues: [cue('ko-1', 900, 3050, '기존 번역입니다.')] };
  const request = await core.makeTranslationRequest({ media, source, reference, mode: 'edit' });
  assert.equal(request.slots.length, 1);
  assert.deepEqual(request.slots, reference.cues);
  assert.equal(request.reference.language, 'ko');
  const response = responseFor(request);
  response.cues[0].startMs = 900;
  response.cues[0].endMs = 3050;
  assert.deepEqual(core.validateTranslationResponse(response, request).cues, [cue('ko-1', 900, 3050, '1번 번역입니다.')]);
  for (const field of ['id', 'startMs', 'endMs', 'text']) {
    const changed = structuredClone(reference);
    changed.cues[0][field] = typeof changed.cues[0][field] === 'number' ? changed.cues[0][field] + 1 : changed.cues[0][field] + 'x';
    const other = await core.makeTranslationRequest({ media, source, reference: changed, mode: 'edit' });
    assert.notEqual(other.sourceHash, request.sourceHash, `reference ${field} must affect the hash`);
  }
  const changedSource = structuredClone(source);
  changedSource.cues[0].text += ' Changed.';
  assert.notEqual((await core.makeTranslationRequest({ media, source: changedSource, reference, mode: 'edit' })).sourceHash, request.sourceHash);
  await assert.rejects(() => core.makeTranslationRequest({ media, source, mode: 'edit' }), { code: 'MISSING_REFERENCE' });
  await assert.rejects(() => core.makeTranslationRequest({ media, source, mode: 'invalid' }), { code: 'INVALID_MODE' });
});

test('response rejects stale metadata, invalid fields, changed timings and incomplete translations', async () => {
  const request = await core.makeTranslationRequest({ media, source });
  for (const field of ['requestId', 'sourceHash', 'mediaKey']) {
    const response = responseFor(request);
    response[field] = 'stale';
    expectCode(() => core.validateTranslationResponse(response, request), 'STALE_RESPONSE');
  }
  const cases = [
    [response => { response.cues.pop(); }, 'MISSING_ID'],
    [response => { response.cues.push({ ...response.cues[0] }); }, 'DUPLICATE_ID'],
    [response => { response.cues[0].id = 'unknown'; }, 'UNKNOWN_ID'],
    [response => { response.cues[0].id = 1; }, 'INVALID_ID'],
    [response => { response.cues[0].text = ' \n '; }, 'INVALID_TEXT'],
    [response => { response.cues[0].text = 123; }, 'INVALID_TEXT'],
    [response => { response.cues[0].text = 'NUL\u0000'; }, 'INVALID_TEXT'],
    [response => { response.cues[0].startMs = 999; }, 'CHANGED_TIMING'],
    [response => { response.cues[0].endMs = '2000'; }, 'CHANGED_TIMING'],
    [response => { response.cues[0].html = '<b>extra</b>'; }, 'INVALID_RESPONSE'],
    [response => { response.model = 'unnecessary'; }, 'INVALID_RESPONSE'],
    [response => { response.schemaVersion = 2; }, 'INVALID_RESPONSE']
  ];
  for (const [change, code] of cases) {
    const response = responseFor(request);
    change(response);
    expectCode(() => core.validateTranslationResponse(response, request), code);
  }
  expectCode(() => core.validateTranslationResponse(request.outputTemplate, request), 'INVALID_TEXT');
  const literal = responseFor(request);
  literal.cues[0].text = '<script>neverExecute()</script>';
  assert.equal(core.validateTranslationResponse(literal, request).cues[0].text, '<script>neverExecute()</script>');
});

test('browser global works without CommonJS, DOM or Node globals', async () => {
  const context = vm.createContext({ TextEncoder, URL, crypto: require('node:crypto').webcrypto });
  vm.runInContext(fs.readFileSync(require.resolve('../subtitles/core.js'), 'utf8'), context);
  const api = context.OTTSubtitles;
  assert.equal(typeof api.parse, 'function');
  assert.equal(api.parse('1\n00:00:00,000 --> 00:00:01,000\nBrowser.').cues[0].text, 'Browser.');
  const request = await api.makeTranslationRequest({ media: 'https://www.netflix.com/watch/123', source });
  assert.match(request.sourceHash, /^[\da-f]{64}$/);
});
