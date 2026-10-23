// Workspace behavior at deterministic DOM, tab-message, and persistence boundaries.
// Real IndexedDB transactions, browser download UX, and streaming sites need Chromium.
// Every subtitle below is an original synthetic fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeEnvironment } from './dom.mjs';

const script = await readFile(new URL('../../subtitles/workspace.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../subtitles/workspace.html', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
let revisionSequence = 0;
const media = id => ({ key: `netflix:${id}`, platform: 'netflix', videoId: String(id), url: `https://www.netflix.com/watch/${id}` });
const track = (name, text, language = 'ko') => ({ name, language, format: 'srt', cues: [
  { id: `${language}-1`, startMs: 1000, endMs: 2500, text }
], sync: { offsetMs: 0, scale: 1 }, timingVerified: false });
const sessionFor = (id = 101) => ({
  mediaKey: media(id).key, media: media(id),
  tracks: { source: track('original-en.srt', 'An original synthetic sentence.', 'en'), a: track('original-a.srt', '기준 합성 자막.'), b: null },
  settings: { enabled: true, display: 'target', activeTarget: 'a', offsetMs: 0, scale: 1, fontSize: 28, bottomPercent: 10, hideNative: false },
  pendingRequest: null
});
const srt = text => `1\n00:00:01,000 --> 00:00:02,500\n${text}\n`;
function file(name, text, read) {
  const buffer = new TextEncoder().encode(text).buffer;
  return { name, size: buffer.byteLength, arrayBuffer: read || (async () => buffer) };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await turn();
  }
  throw new Error(`Workspace boundary did not settle: ${label}`);
}

async function workspace({ saved = sessionFor(), store = new Map(), stateMedia = media(101), initialFailApply = 0, waitUntilReady = true } = {}) {
  const env = await makeEnvironment();
  const { context, document } = env;
  const elements = new Map();
  const downloads = [];
  const blobs = new Map();
  const timers = new Map();
  const intervals = new Map();
  const writes = [];
  const calls = [];
  const control = { failApply: initialFailApply, beforeState: null, beforePut: null };
  let timerId = 0;
  if (saved && !store.has(saved.mediaKey)) store.set(saved.mediaKey, clone(saved));
  const current = { media: clone(stateMedia), hasVideo: true, currentSpeed: 1, subtitles: {} };

  const create = document.createElement.bind(document);
  document.createElement = tagName => {
    const node = create(tagName);
    let value = '';
    Object.defineProperty(node, 'value', { get: () => value, set: next => { value = String(next); }, configurable: true });
    Object.defineProperty(node, 'options', { get: () => node.children.filter(child => child.tagName === 'OPTION') });
    node.disabled = false; node.checked = false; node.files = [];
    node.classList = {
      toggle(name, enabled) {
        const names = new Set(node.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        node.className = [...names].join(' ');
        return Boolean(enabled);
      },
      contains: name => node.className.split(/\s+/).includes(name)
    };
    node.replaceChildren = (...children) => {
      for (const child of [...node.children]) child.remove();
      node._text = ''; node.append(...children);
      if (node.tagName === 'SELECT') node.value = children[0]?.value || '';
    };
    node.click = () => {
      if (node.tagName === 'A' && node.download) downloads.push({ name: node.download, blob: blobs.get(node.href) });
      if (!node.disabled) node.dispatchEvent({ type: 'click' });
    };
    return node;
  };
  const main = document.createElement('main'); document.body.appendChild(main);
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const node = document.createElement(match[1]); node.id = match[3];
    const attributes = match[2];
    for (const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], attribute[2]);
    node.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] || '';
    node.checked = /(?:^|\s)checked(?:\s|$)/.test(attributes);
    elements.set(node.id, node); main.appendChild(node);
  }
  for (const select of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const node = elements.get(select[1]); let selected;
    for (const option of select[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const item = document.createElement('option');
      item.value = /\bvalue="([^"]*)"/.exec(option[1])?.[1] || '';
      item.textContent = option[2]; node.appendChild(item);
      if (/\bselected\b/.test(option[1])) selected = item.value;
    }
    node.value = selected ?? node.options[0]?.value ?? '';
  }
  document.getElementById = id => elements.get(id) || null;
  document.activeElement = null;
  const queryAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => selector === 'main input, main select, main button'
    ? [...elements.values()].filter(node => ['INPUT', 'SELECT', 'BUTTON'].includes(node.tagName)) : queryAll(selector);
  context.Option = function Option(text, value) {
    const node = document.createElement('option'); node.textContent = text; node.value = value; return node;
  };
  context.structuredClone = clone;
  context.Blob = Blob;
  context.URL = class TestURL extends URL {
    static createObjectURL(blob) { const url = `blob:synthetic-${blobs.size}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { blobs.delete(url); }
  };
  context.location = { search: '?tabId=5' };
  context.confirm = () => true;
  context.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  context.clearTimeout = id => timers.delete(id);
  context.setInterval = callback => { const id = ++timerId; intervals.set(id, callback); return id; };
  context.OTTSubtitleLibrary = {
    get: async key => clone(store.get(key)),
    put: async candidate => {
      if (control.beforePut) await control.beforePut(candidate);
      if ((candidate.revision ?? 0) !== (store.get(candidate.mediaKey)?.revision ?? 0)) {
        const error = new Error('Synthetic revision conflict.'); error.name = 'ConflictError'; throw error;
      }
      const committed = { ...clone(candidate), revision: `synthetic-version-${++revisionSequence}`, updatedAt: '2026-10-23T00:00:00.000Z' };
      writes.push(clone(committed)); store.set(candidate.mediaKey, clone(committed));
      return committed;
    },
    remove: async (key, revision) => {
      if ((revision ?? 0) !== (store.get(key)?.revision ?? 0)) {
        const error = new Error('Synthetic revision conflict.'); error.name = 'ConflictError'; throw error;
      }
      return store.delete(key);
    }
  };
  context.chrome = {
    tabs: {
      async sendMessage(tabId, message) {
        assert.equal(tabId, 5); calls.push(clone(message));
        if (message.action === 'subtitleState') {
          if (control.beforeState) await control.beforeState();
          return clone(current);
        }
        if (message.action === 'loadSubtitleSession') {
          if (control.failApply > 0) { control.failApply -= 1; throw new Error('Synthetic tab delivery failed.'); }
          if (message.session.mediaKey !== current.media.key) return { error: '영상이 바뀌었습니다.' };
          current.subtitles = { settings: clone(message.session.settings), currentTime: 1.5 };
          return clone(current);
        }
        if (message.action === 'setSpeed') { current.currentSpeed = message.speed; return clone(current); }
        if (message.action === 'listNativeTracks') return { tracks: [] };
        throw new Error(`Unexpected synthetic action: ${message.action}`);
      },
      update: async () => ({ windowId: 7 })
    },
    windows: { update: async () => ({}) }
  };
  vm.runInContext(script, context, { filename: 'subtitles/workspace.js' });
  const $ = id => elements.get(id);
  if (waitUntilReady) await until(() => !$('source-file').disabled, 'initial saved-session restore');
  const choose = (id, selectedFile) => { $(id).files = [selectedFile]; $(id).dispatchEvent({ type: 'change' }); };
  const change = (id, value) => { $(id).value = value; $(id).dispatchEvent({ type: 'change' }); };
  const click = id => $(id).click();
  const idle = () => until(() => !$('source-file').disabled, 'user action completion');
  return { ...env, $, control, current, store, writes, calls, downloads, choose, change, click, idle };
}

test('saved sessions restore source/A/B/settings without rewriting persistence', async () => {
  const saved = sessionFor(); saved.tracks.b = track('saved-b.srt', '저장한 합성 번역.');
  saved.settings.activeTarget = 'b'; saved.settings.offsetMs = 1250;
  const f = await workspace({ saved });
  assert.match(f.$('a-info').textContent, /original-a\.srt/);
  assert.match(f.$('b-info').textContent, /saved-b\.srt/);
  assert.equal(f.$('active-target').value, 'b'); assert.equal(f.$('offset').value, '1.25');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.calls.find(call => call.action === 'loadSubtitleSession').session.tracks, saved.tracks);
});

test('retrying initial session delivery also restores the saved controls and track labels', async () => {
  const saved = sessionFor(); saved.tracks.b = track('restored-b.srt', '복원할 합성 번역.');
  saved.settings.activeTarget = 'b'; saved.settings.offsetMs = 1250;
  const f = await workspace({ saved, initialFailApply: 1, waitUntilReady: false });
  await until(() => f.$('notice').textContent.includes('Synthetic tab delivery failed'), 'initial restore delivery failure');
  f.click('refresh'); await f.idle();
  assert.match(f.$('b-info').textContent, /restored-b\.srt/);
  assert.equal(f.$('active-target').value, 'b'); assert.equal(f.$('offset').value, '1.25');
  f.change('display', 'bilingual');
  await until(() => f.writes.length === 1, 'settings after reconnection'); await f.idle();
  assert.equal(f.store.get(saved.mediaKey).settings.offsetMs, 1250);
  assert.equal(f.store.get(saved.mediaKey).settings.activeTarget, 'b');
});

test('manual request/response JSON roundtrip preserves A and reference timing', async () => {
  const saved = sessionFor(); saved.tracks.a.sync = { offsetMs: 2000, scale: 1.03 };
  const f = await workspace({ saved });
  f.click('export-request');
  await until(() => f.downloads.length === 1, 'request download'); await f.idle();
  const request = JSON.parse(await f.downloads[0].blob.text());
  assert.equal(request.mode, 'edit'); assert.equal(request.slots[0].id, saved.tracks.a.cues[0].id);
  const response = clone(request.outputTemplate);
  response.cues = response.cues.map(cue => ({ ...cue, text: '검토한 합성 번역.' }));
  f.choose('response-file', file('synthetic-response.json', JSON.stringify(response)));
  await until(() => f.store.get(saved.mediaKey)?.tracks.b?.cues[0].text === '검토한 합성 번역.', 'response saved to B');
  await f.idle();
  const stored = f.store.get(saved.mediaKey);
  assert.deepEqual(stored.tracks.a, saved.tracks.a);
  assert.equal(stored.tracks.b.cues[0].startMs, saved.tracks.a.cues[0].startMs);
  assert.equal(stored.tracks.b.cues[0].endMs, saved.tracks.a.cues[0].endMs);
  assert.deepEqual(stored.tracks.b.sync, saved.tracks.a.sync);
  assert.equal(stored.settings.activeTarget, 'b');
});

test('a response from another request cannot overwrite existing A or B', async () => {
  const saved = sessionFor(); saved.tracks.b = track('protected-b.srt', '유지해야 할 합성 번역.');
  const f = await workspace({ saved }); f.click('export-request');
  await until(() => f.downloads.length === 1, 'request download'); await f.idle();
  const request = JSON.parse(await f.downloads[0].blob.text());
  const response = { ...request.outputTemplate, requestId: 'another-request', cues: [{ id: request.slots[0].id, text: '잘못된 합성 응답.' }] };
  const before = clone(f.store.get(saved.mediaKey)); const count = f.writes.length;
  f.choose('response-file', file('wrong-response.json', JSON.stringify(response))); await f.idle();
  assert.equal(f.writes.length, count); assert.deepEqual(f.store.get(saved.mediaKey), before);
  assert.equal(f.$('notice').classList.contains('error'), true);
});

test('switching episode during file reading saves neither old nor new episode data', async () => {
  const saved = sessionFor(); const f = await workspace({ saved });
  let release; let reading = false;
  const content = srt('다른 회차에 적용되면 안 되는 합성 자막.');
  const delayed = file('delayed.srt', content, () => { reading = true; return new Promise(resolve => { release = resolve; }); });
  f.choose('a-file', delayed);
  await until(() => reading, 'file read started');
  f.current.media = media(202);
  release(new TextEncoder().encode(content).buffer);
  await until(() => f.$('video-heading').textContent.includes('202'), 'new episode connected'); await f.idle();
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.store.get(saved.mediaKey), saved);
  assert.equal(f.store.has(media(202).key), false);
});

test('a file-picker result arriving during polling is processed after refresh', async () => {
  const f = await workspace(); let release; let waiting = false;
  f.control.beforeState = () => {
    f.control.beforeState = null; waiting = true;
    return new Promise(resolve => { release = resolve; });
  };
  f.click('refresh'); await until(() => waiting, 'poll is awaiting tab');
  f.choose('a-file', file('queued-a.srt', srt('조회 뒤 적용할 합성 자막.')));
  assert.equal(f.writes.length, 0); release();
  await until(() => f.store.get(media(101).key)?.tracks.a.name === 'queued-a.srt', 'queued import saved'); await f.idle();
  assert.equal(f.store.get(media(101).key).tracks.a.cues[0].text, '조회 뒤 적용할 합성 자막.');
});

test('a durable import survives tab-delivery failure and the next settings edit', async () => {
  const f = await workspace(); f.control.failApply = 1;
  f.choose('a-file', file('durable-a.srt', srt('저장에 성공한 합성 자막.')));
  await until(() => f.$('notice').textContent.includes('저장했지만'), 'saved-but-not-applied error'); await f.idle();
  assert.equal(f.store.get(media(101).key).tracks.a.name, 'durable-a.srt');
  assert.match(f.$('a-info').textContent, /durable-a\.srt/);
  f.change('display', 'bilingual');
  await until(() => f.writes.length === 2, 'next settings write'); await f.idle();
  assert.equal(f.store.get(media(101).key).tracks.a.name, 'durable-a.srt');
  assert.equal(f.store.get(media(101).key).tracks.a.cues[0].text, '저장에 성공한 합성 자막.');
});

test('a stale second workspace cannot overwrite A and can retry after conflict reload', async () => {
  const store = new Map();
  const first = await workspace({ store }); const second = await workspace({ store });
  first.choose('a-file', file('newest-a.srt', srt('다른 작업실이 저장한 새 합성 자막.')));
  await until(() => store.get(media(101).key)?.tracks.a.name === 'newest-a.srt', 'first workspace commit'); await first.idle();
  const firstRevision = store.get(media(101).key).revision;
  second.change('display', 'bilingual');
  await until(() => second.$('a-info').textContent.includes('newest-a.srt'), 'conflict reload'); await second.idle();
  assert.equal(second.writes.length, 0);
  assert.equal(store.get(media(101).key).revision, firstRevision);
  assert.equal(store.get(media(101).key).tracks.a.cues[0].text, '다른 작업실이 저장한 새 합성 자막.');
  second.change('display', 'bilingual');
  await until(() => second.writes.length === 1, 'explicit retry using new revision'); await second.idle();
  assert.notEqual(store.get(media(101).key).revision, firstRevision);
  assert.equal(store.get(media(101).key).tracks.a.name, 'newest-a.srt');
  assert.equal(store.get(media(101).key).settings.display, 'bilingual');
});

test('delete and recreate cannot make an old workspace revision valid again', async () => {
  const store = new Map(); const first = await workspace({ store });
  first.choose('a-file', file('before-clear.srt', srt('삭제 전 합성 자막.')));
  await until(() => store.get(media(101).key)?.tracks.a.name === 'before-clear.srt', 'first revision'); await first.idle();
  const oldRevision = store.get(media(101).key).revision;
  const stale = await workspace({ store });
  first.click('clear-session');
  await until(() => !store.has(media(101).key), 'session deletion'); await first.idle();
  first.choose('a-file', file('after-clear.srt', srt('삭제 후 새로 저장한 합성 자막.')));
  await until(() => store.get(media(101).key)?.tracks.a.name === 'after-clear.srt', 'recreated session'); await first.idle();
  const freshRevision = store.get(media(101).key).revision;
  assert.notEqual(freshRevision, oldRevision);
  stale.change('display', 'bilingual');
  await until(() => stale.$('a-info').textContent.includes('after-clear.srt'), 'stale revision conflict'); await stale.idle();
  assert.equal(stale.writes.length, 0);
  assert.equal(store.get(media(101).key).revision, freshRevision);
  assert.equal(store.get(media(101).key).tracks.a.cues[0].text, '삭제 후 새로 저장한 합성 자막.');
  assert.equal(store.get(media(101).key).tracks.source, null);
});

test('saved translation can be exported after its video tab closes', async () => {
  const saved = sessionFor(); saved.tracks.b = track('offline-b.srt', '영상 탭이 닫혀도 보관할 합성 번역.');
  saved.settings.activeTarget = 'b';
  const f = await workspace({ saved });
  f.control.beforeState = () => { throw new Error('No tab with id: 5'); };
  f.click('refresh');
  await until(() => f.$('source-file').disabled && f.$('notice').classList.contains('error'), 'closed video tab');
  assert.equal(f.$('export-vtt').disabled, false);
  f.click('export-vtt'); await until(() => f.downloads.length === 1, 'offline translation download');
  const exported = await f.downloads[0].blob.text();
  assert.equal(f.context.OTTSubtitles.parse(exported, 'offline.vtt').cues[0].text, saved.tracks.b.cues[0].text);
  assert.equal(f.writes.length, 0);
});
