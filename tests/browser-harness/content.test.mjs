// Content integration tests use a deterministic DOM/Chrome API boundary, not a
// browser. tests/smoke.mjs separately exercises the unpacked extension in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeEnvironment } from './dom.mjs';

const script = await readFile(new URL('../../scripts/content.js', import.meta.url), 'utf8');
const cueTrack = text => ({ name: 'synthetic.srt', format: 'srt', language: 'ko', cues: [
  { id: 'synthetic', startMs: 1000, endMs: 2000, text }
] });
const sessionFor = (mediaKey, text) => ({
  mediaKey, tracks: { source: null, a: cueTrack(text), b: null },
  settings: { enabled: true, activeTarget: 'a', display: 'target', offsetMs: 0, scale: 1 }
});

async function makeContent({ url = 'https://www.netflix.com/watch/101', speed = 1.5, randomUUID = true, restore } = {}) {
  const env = await makeEnvironment();
  const { context, document } = env;
  const video = document.createElement('video'); video.setAttribute('src', 'synthetic:one');
  document.body.appendChild(video);
  const storage = { speed };
  const messages = [];
  const handlers = [];
  const timers = new Map();
  const intervals = new Map();
  const observers = [];
  let timerId = 0;
  context.location = { href: url };
  context.innerWidth = 1200; context.innerHeight = 800;
  context.getComputedStyle = element => ({
    display: element.style.getPropertyValue('display') || element.style.display || 'block',
    visibility: element.style.getPropertyValue('visibility') || 'visible'
  });
  context.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  context.clearTimeout = id => timers.delete(id);
  context.setInterval = (callback, delay) => { const id = ++timerId; intervals.set(id, { callback, delay }); return id; };
  context.clearInterval = id => intervals.delete(id);
  context.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.root = null; observers.push(this); }
    observe(root) { this.root = root; }
    disconnect() { this.root = null; }
  };
  if (!randomUUID) context.crypto = { getRandomValues: array => array.fill(17) };
  context.chrome = {
    storage: { local: { get: async () => ({ ...storage }), set: async values => Object.assign(storage, values) } },
    runtime: {
      id: 'synthetic-extension',
      onMessage: { addListener: listener => handlers.push(listener) },
      sendMessage: async message => {
        messages.push(message);
        if (message.action === 'getSubtitleSession') return restore ? restore(message.mediaKey) : { session: null };
        return null;
      }
    }
  };
  vm.runInContext(script, context, { filename: 'scripts/content.js' });
  const send = (message, sender = { id: context.chrome.runtime.id }) => new Promise(resolve => {
    let asynchronous = false;
    for (const handler of handlers) if (handler(message, sender, resolve) === true) asynchronous = true;
    if (!asynchronous) resolve({ unhandled: true });
  });
  const getState = () => send({ action: 'subtitleState' });
  const tick = async delay => {
    for (const interval of [...intervals.values()]) if (interval.delay === delay) interval.callback();
    await Promise.resolve();
  };
  const mutate = async (addedNodes = [], removedNodes = []) => {
    for (const observer of observers) if (observer.root === document) observer.callback([{ addedNodes, removedNodes }]);
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    await Promise.resolve();
  };
  const keyboard = (target = document.body, overrides = {}) => {
    const event = { type: 'keydown', key: 'ArrowUp', ctrlKey: true, composedPath: () => [target, document.body, document], ...overrides };
    document.dispatchEvent(event);
    return event;
  };
  const dispose = () => context.dispatchEvent({ type: 'pagehide', persisted: false });
  return { ...env, video, storage, messages, timers, intervals, observers, send, getState, tick, mutate, keyboard, dispose };
}

test('content preserves saved speed, applies valid updates, and rejects invalid rates', async () => {
  const f = await makeContent();
  const initial = await f.getState();
  assert.equal(initial.hasVideo, true);
  assert.equal(f.video.playbackRate, 1.5);
  const changed = await f.send({ action: 'setSpeed', speed: 2 });
  assert.equal(changed.currentSpeed, 2); assert.equal(f.video.playbackRate, 2); assert.equal(f.storage.speed, 2);
  for (const invalid of [0, 5, '2', NaN, Infinity]) {
    const response = await f.send({ action: 'setSpeed', speed: invalid });
    assert.ok(response.error); assert.equal(f.video.playbackRate, 2); assert.equal(f.storage.speed, 2);
  }
  assert.equal((await f.send({ action: 'setSpeed', speed: 1 }, { id: 'another-extension' })).unhandled, true);
  f.dispose();
});

test('editable and composing keyboard events keep speed unchanged while normal shortcuts work', async () => {
  const f = await makeContent(); await f.getState();
  const input = f.document.createElement('input'); f.document.body.appendChild(input);
  const editor = f.document.createElement('div'); editor.isContentEditable = true;
  f.document.body.appendChild(editor);
  assert.equal(f.keyboard(input).defaultPrevented, undefined);
  assert.equal(f.keyboard(editor).defaultPrevented, undefined);
  assert.equal(f.keyboard(f.document.body, { isComposing: true }).defaultPrevented, undefined);
  assert.equal(f.video.playbackRate, 1.5);
  const event = f.keyboard();
  assert.equal(event.defaultPrevented, true);
  await f.getState();
  assert.equal(f.video.playbackRate, 1.75); assert.equal(f.storage.speed, 1.75);
  f.dispose();
});

test('an explicit subtitle load supersedes a late automatic restore', async () => {
  let release;
  const restored = new Promise(resolve => { release = resolve; });
  const f = await makeContent({ restore: () => restored });
  const initial = await f.getState();
  f.video.currentTime = 1.5;
  const result = await f.send({ action: 'loadSubtitleSession', session: sessionFor(initial.media.key, '사용자가 선택한 합성 자막.') });
  assert.equal(result.subtitles.targetText, '사용자가 선택한 합성 자막.');
  release({ session: sessionFor(initial.media.key, '뒤늦게 도착한 이전 자막.') });
  await Promise.resolve(); await Promise.resolve();
  assert.equal((await f.getState()).subtitles.targetText, '사용자가 선택한 합성 자막.');
  f.dispose();
});

test('SPA identity change clears a reused video and rejects prior-episode sessions', async () => {
  const f = await makeContent(); const initial = await f.getState(); f.video.currentTime = 1.5;
  await f.send({ action: 'loadSubtitleSession', session: sessionFor(initial.media.key, '첫 회차 합성 자막.') });
  f.context.location.href = 'https://www.netflix.com/watch/202'; await f.tick(500);
  const next = await f.getState();
  assert.notEqual(next.media.key, initial.media.key); assert.equal(next.subtitles.currentText, '');
  const old = await f.send({ action: 'loadSubtitleSession', session: sessionFor(initial.media.key, '이전 회차.') });
  assert.ok(old.error); assert.equal((await f.getState()).subtitles.currentText, '');
  f.dispose();
});

test('detached videos lose their listeners and replacement videos inherit speed', async () => {
  const f = await makeContent(); await f.getState();
  await f.send({ action: 'setSpeed', speed: 2.25 });
  f.video.remove();
  await f.mutate([], [f.video]);
  assert.equal((await f.getState()).hasVideo, false); assert.equal(f.video.listenerCount(), 0);
  const replacement = f.document.createElement('video'); f.document.body.appendChild(replacement);
  await f.mutate([replacement]);
  assert.equal((await f.getState()).hasVideo, true); assert.equal(replacement.playbackRate, 2.25);
  f.dispose(); assert.equal(replacement.listenerCount(), 0); assert.equal(f.intervals.size, 0);
});

test('own subtitle shadow root is excluded from video discovery observers', async () => {
  const f = await makeContent(); await f.getState();
  const host = f.document.querySelector('[data-ottspeed-subtitle-overlay]');
  assert.ok(host?.shadowRoot);
  assert.equal(f.observers.some(observer => observer.root === host.shadowRoot), false);
  f.dispose();
});

test('native player rate changes are saved and inherited by a later video', async () => {
  const f = await makeContent(); await f.getState();
  f.video.playbackRate = 1.25; f.video.dispatchEvent('ratechange');
  assert.equal((await f.getState()).currentSpeed, 1.25); assert.equal(f.storage.speed, 1.25);
  f.video.remove(); await f.mutate([], [f.video]);
  const replacement = f.document.createElement('video'); f.document.body.appendChild(replacement);
  await f.mutate([replacement]);
  assert.equal(replacement.playbackRate, 1.25);
  f.dispose();
});

test('a malformed direct session does not cancel an already pending valid restore', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await makeContent({ restore: () => pending }); const initial = await f.getState();
  f.video.currentTime = 1.5;
  const invalid = sessionFor(initial.media.key, '잘못된 합성 자막.');
  invalid.tracks.a.cues[0].endMs = 0;
  assert.ok((await f.send({ action: 'loadSubtitleSession', session: invalid })).error);
  release({ session: sessionFor(initial.media.key, '복원되는 합성 자막.') });
  await Promise.resolve(); await Promise.resolve();
  assert.equal((await f.getState()).subtitles.targetText, '복원되는 합성 자막.');
  f.dispose();
});

test('HTTP without crypto.randomUUID still initializes speed control', async () => {
  const f = await makeContent({ url: 'http://example.test/episode', randomUUID: false });
  const state = await f.getState();
  assert.equal(state.hasVideo, true); assert.equal(f.video.playbackRate, 1.5);
  assert.ok(!(await f.send({ action: 'setSpeed', speed: 2 })).error);
  assert.equal(f.video.playbackRate, 2);
  f.dispose();
});

test('file video pages preserve speed control with an unsupported subtitle identity', async () => {
  const f = await makeContent({ url: 'file:///synthetic/episode.html' });
  const state = await f.getState();
  assert.equal(state.hasVideo, true); assert.equal(f.video.playbackRate, 1.5);
  assert.equal(state.media.supportedPlatform, false);
  assert.ok(!(await f.send({ action: 'setSpeed', speed: 2 })).error);
  assert.equal(f.video.playbackRate, 2);
  f.dispose();
});
