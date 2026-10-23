import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeEnvironment } from './dom.mjs';

const popupScript = await readFile(new URL('../../popup/popup.js', import.meta.url), 'utf8');
const backgroundScript = await readFile(new URL('../../scripts/background.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = [];
  return { listeners, addListener: listener => listeners.push(listener), emit: (...args) => Promise.all(listeners.map(listener => listener(...args))) };
}

async function popup({ activeTab = { id: 7 }, state = { hasVideo: true, isPlaying: true, currentSpeed: 1.5 } } = {}) {
  const env = await makeEnvironment(); const { document, context } = env;
  for (const id of ['main-content', 'no-video', 'workspace-btn', 'status', 'speed-value', 'speed-slider', 'error', 'reset-btn']) {
    const element = document.createElement('div'); element.id = id; document.body.appendChild(element);
  }
  const status = document.createElement('span'); status.className = 'status-text'; document.body.appendChild(status);
  const preset = document.createElement('button'); preset.className = 'preset-btn'; preset.dataset = { speed: '1.5' }; document.body.appendChild(preset);
  const messages = []; const created = [];
  const onMessage = event();
  context.window = { close() {} };
  context.chrome = {
    tabs: {
      query: async () => activeTab ? [activeTab] : [],
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        if (!Number.isInteger(tabId)) throw new Error('No tab with id');
        return state;
      },
      create: async options => created.push(options)
    },
    runtime: { id: 'synthetic-extension', onMessage, getURL: path => `chrome-extension://synthetic/${path}` }
  };
  vm.runInContext(popupScript, context, { filename: 'popup/popup.js' });
  await settle();
  return { ...env, status, preset, messages, created, onMessage };
}

test('popup ignores other tabs and extensions while accepting its selected video tab', async () => {
  const f = await popup();
  assert.equal(f.document.getElementById('speed-value').textContent, '1.5');
  assert.equal(f.status.textContent, '재생 중');
  const message = { action: 'videoStateChanged', hasVideo: false, isPlaying: false, currentSpeed: 3 };
  await f.onMessage.emit(message, { id: 'synthetic-extension', tab: { id: 8 } });
  await f.onMessage.emit(message, { id: 'other-extension', tab: { id: 7 } });
  assert.equal(f.document.getElementById('speed-value').textContent, '1.5');
  assert.equal(f.status.textContent, '재생 중');
  await f.onMessage.emit(message, { id: 'synthetic-extension', tab: { id: 7 } });
  assert.equal(f.status.textContent, '비디오 없음');
  assert.equal(f.document.getElementById('workspace-btn').disabled, true);
});

test('popup workspace links bind to the selected tab and missing tabs disable controls', async () => {
  const f = await popup();
  f.document.getElementById('workspace-btn').dispatchEvent('click'); await settle();
  assert.equal(f.created[0].url, 'chrome-extension://synthetic/subtitles/workspace.html?tabId=7');
  const missing = await popup({ activeTab: null });
  assert.equal(missing.document.getElementById('main-content').hidden, true);
  assert.equal(missing.document.getElementById('workspace-btn').disabled, true);
});

function background({ storedSession = null, liveState = { hasVideo: true, isPlaying: true } } = {}) {
  const actionCalls = []; const queried = []; const stored = {}; const libraryKeys = [];
  const chrome = {
    runtime: { id: 'synthetic-extension', onMessage: event(), onInstalled: event() },
    action: Object.fromEntries(['setIcon', 'setBadgeText', 'setTitle'].map(name => [name, async value => actionCalls.push({ name, value })])),
    tabs: {
      onRemoved: event(), onUpdated: event(), onActivated: event(),
      sendMessage: async (tabId, message) => { queried.push({ tabId, message }); return liveState; }
    },
    storage: { local: { set: async value => Object.assign(stored, value) } }
  };
  const context = vm.createContext({
    chrome, importScripts() {},
    OTTSubtitleLibrary: { get: async key => { libraryKeys.push(key); return storedSession; } }
  });
  vm.runInContext(backgroundScript, context, { filename: 'scripts/background.js' });
  const send = (message, sender = { id: chrome.runtime.id, tab: { id: 0 } }) => new Promise(resolve => {
    const handled = chrome.runtime.onMessage.listeners.map(listener => listener(message, sender, resolve)).some(result => result === true);
    if (!handled) resolve({ unhandled: true });
  });
  return { chrome, actionCalls, queried, stored, libraryKeys, send };
}

test('a fresh MV3 worker recovers active-tab icon state from the live content script', async () => {
  const f = background();
  await f.chrome.tabs.onActivated.emit({ tabId: 0 });
  assert.equal(f.queried.length, 1); assert.equal(f.queried[0].message.action, 'checkVideo');
  const icon = f.actionCalls.find(call => call.name === 'setIcon');
  assert.equal(icon.value.tabId, 0); assert.equal(icon.value.path['16'], 'icons/icon-16.png');
  assert.equal(f.actionCalls.find(call => call.name === 'setTitle').value.title, 'OTTSpeed · 재생 중');
});

test('worker loads durable display data and rejects messages from unrelated senders', async () => {
  const session = {
    mediaKey: 'netflix:synthetic', tracks: { source: null, a: null, b: null }, settings: { enabled: true },
    pendingRequest: { requestId: 'not-needed-in-content-script' }
  };
  const f = background({ storedSession: session });
  const response = await f.send({ action: 'getSubtitleSession', mediaKey: session.mediaKey });
  assert.equal(response.session.mediaKey, session.mediaKey);
  assert.equal(response.session.pendingRequest, undefined);
  assert.equal(f.libraryKeys.length, 1);
  await f.send({ action: 'getSubtitleSession', mediaKey: session.mediaKey }, { id: 'other-extension', tab: { id: 0 } });
  await f.send({ action: 'getSubtitleSession', mediaKey: session.mediaKey }, { id: 'synthetic-extension' });
  assert.equal(f.libraryKeys.length, 1);
});

test('extension updates preserve speed preferences while initial installation sets the default', async () => {
  const f = background(); f.stored.speed = 1.75;
  await f.chrome.runtime.onInstalled.emit({ reason: 'update' });
  assert.equal(f.stored.speed, 1.75);
  await f.chrome.runtime.onInstalled.emit({ reason: 'install' });
  assert.equal(f.stored.speed, 1);
});
