/**
 * Local Chromium integration smoke test, using only original synthetic captions.
 *
 * Run: node tests/smoke.mjs
 * Optional: OTTSPEED_CHROMIUM_PATH=/path/to/chrome node tests/smoke.mjs
 *
 * Requires an already installed Playwright package and Chromium executable.
 * This script never downloads a browser or accesses an existing browser profile.
 * Exit 2 means the required browser is unavailable; that is NOT a passing test.
 * Netflix/YouTube account sessions and real streaming playback are not covered.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let playwright;
try {
  const searchPaths = [root, process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean);
  playwright = require(require.resolve('playwright', { paths: searchPaths }));
} catch (_) {
  console.error('BLOCKED: Playwright is not installed. No browser tests were executed.');
  process.exit(2);
}
const executablePath = process.env.OTTSPEED_CHROMIUM_PATH || playwright.chromium.executablePath();
if (!existsSync(executablePath)) {
  console.error(`BLOCKED: Chromium is unavailable at ${executablePath}. No browser tests were executed.`);
  process.exit(2);
}

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.content_scripts.find(entry=>entry.matches.includes('<all_urls>')).js, [
  'subtitles/core.js', 'subtitles/controller.js', 'scripts/content.js'
]);

// A video element can play this silent audio-only WAV. It supplies a real media
// clock and seek events without an external media asset or encoding dependency.
function makeSilentWav(seconds = 30) {
  const samples = seconds * 8000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>OTTDeck synthetic fixture</title><style>
body { margin: 20px; background: #eee; } #player { width: 640px; height: 360px; position: relative; }
video { width: 640px; height: 360px; background: #223; } #player:fullscreen { width: 100vw; height: 100vh; }
#player:fullscreen video { width: 100%; height: 100%; } input,button,[contenteditable] { margin: 8px; }
</style></head><body>
<div id="player"><video id="video" src="/synthetic.wav" muted preload="auto" playsinline></video></div>
<input id="typing" aria-label="Editable text"><div id="editing" contenteditable="true">Editable text</div>
<button id="container-fullscreen">Container fullscreen</button><button id="video-fullscreen">Video fullscreen</button>
<script>
document.querySelector('#container-fullscreen').onclick = () => document.querySelector('#player').requestFullscreen();
document.querySelector('#video-fullscreen').onclick = () => document.querySelector('video').requestFullscreen();
window.__captionXss = false;
</script></body></html>`;
const silentWav = makeSilentWav();
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/synthetic.wav') {
    const headers = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' };
    let start = 0;
    let end = silentWav.length - 1;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { ...headers, 'content-range': `bytes */${silentWav.length}` }); response.end(); return;
      }
      start = match[1] ? Number(match[1]) : Math.max(0, silentWav.length - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= silentWav.length) {
        response.writeHead(416, { ...headers, 'content-range': `bytes */${silentWav.length}` }); response.end(); return;
      }
      headers['content-range'] = `bytes ${start}-${end}/${silentWav.length}`;
    }
    headers['content-length'] = end - start + 1;
    response.writeHead(range ? 206 : 200, headers);
    response.end(request.method === 'HEAD' ? undefined : silentWav.subarray(start, end + 1));
    return;
  }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  // Only this synthetic page is served. No project or user files are exposed.
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'ottspeed-smoke-'));
const diagnostics = join(root, 'test-results');
let context;
let tracing = false;
let passed = 0;
let currentCheck = 'browser startup';
const errors = [];
const capturedPages = [];

async function eventually(getValue, predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await getValue();
      if (predicate(last)) return last;
    } catch (error) { last = { error: error.message }; }
    await new Promise(accept => setTimeout(accept, 35));
  }
  throw new Error(`${label}: timed out; last value ${JSON.stringify(last)}`);
}
async function check(name, action) {
  currentCheck = name;
  await action();
  passed += 1;
  console.log(`PASS ${name}`);
}

try {
  context = await playwright.chromium.launchPersistentContext(profile, {
    executablePath,
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1000, height: 800 },
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`
    ]
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(15000);
  context.on('page', openedPage => {
    capturedPages.push(openedPage);
    openedPage.on('pageerror', error => errors.push(error.message));
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  tracing = true;
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  // tabs.create returns a tab ID without the optional "tabs" permission. Querying
  // every tab's URL would require permissions this extension does not request.
  const opened = context.waitForEvent('page');
  const tabId = await worker.evaluate(async url => (await chrome.tabs.create({ url })).id, `${origin}/episode-one`);
  const page = await opened;
  await page.waitForURL(`${origin}/episode-one`);
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video.readyState >= 2 && video.seekable.length > 0 && video.seekable.end(video.seekable.length - 1) >= 5;
  });
  assert.ok(Number.isInteger(tabId), 'synthetic fixture has an extension-visible tab');
  const send = message => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
  const state = () => send({ action: 'subtitleState' });
  const lines = () => page.evaluate(() => {
    const host = document.querySelector('[data-ottspeed-subtitle-overlay]');
    return {
      target: host?.shadowRoot?.querySelector('[data-subtitle-line="target"]')?.textContent || '',
      source: host?.shadowRoot?.querySelector('[data-subtitle-line="source"]')?.textContent || '',
      visible: Boolean(host && getComputedStyle(host).display !== 'none'),
      unsafeElements: host?.shadowRoot?.querySelectorAll('img,script,iframe,svg').length || 0,
      xss: window.__captionXss
    };
  });
  const seek = async seconds => {
    await page.evaluate(seconds => { const video = document.querySelector('video'); video.pause(); video.currentTime = seconds; }, seconds);
    await page.waitForFunction(seconds => Math.abs(document.querySelector('video').currentTime - seconds) < 0.02, seconds);
  };
  const first = await eventually(state, value => Boolean(value?.hasVideo && value.media?.key), 'video detection');
  const source = {
    name: 'synthetic-source.srt', language: 'en', format: 'srt', cues: [
      { id: 's1', startMs: 1000, endMs: 2000, text: 'An original synthetic line.' },
      { id: 's2', startMs: 4000, endMs: 5000, text: 'Another synthetic line.' }
    ]
  };
  const target = {
    name: 'synthetic-target.srt', language: 'ko', format: 'srt', cues: [
      { id: 't1', startMs: 1000, endMs: 2000, text: '직접 작성한 합성 자막.' },
      { id: 't2', startMs: 4000, endMs: 5000, text: '<img src=x onerror="window.__captionXss=true"> & 문자 그대로' }
    ]
  };
  const session = {
    mediaKey: first.media.key,
    tracks: { source, a: target, b: null },
    settings: { enabled: true, display: 'bilingual', activeTarget: 'a', offsetMs: 0, scale: 1, fontSize: 28, bottomPercent: 10, hideNative: false }
  };

  await check('paused seek updates both subtitle lines', async () => {
    const result = await send({ action: 'loadSubtitleSession', session });
    assert.ok(!result?.error, JSON.stringify(result));
    await seek(1.5);
    const shown = await eventually(lines, value => value.target === target.cues[0].text, 'first target cue');
    assert.equal(shown.source, source.cues[0].text);
    assert.equal(shown.visible, true);
  });
  await check('forward/backward seeking and literal caption markup', async () => {
    await seek(4.5);
    const shown = await eventually(lines, value => value.target === target.cues[1].text, 'second target cue');
    assert.equal(shown.unsafeElements, 0);
    assert.equal(shown.xss, false);
    await seek(1.5);
    await eventually(lines, value => value.target === target.cues[0].text, 'backward seek');
  });
  await check('cue end is exclusive and gaps clear the overlay', async () => {
    await seek(2);
    await eventually(lines, value => value.target === '' && value.source === '' && !value.visible, 'empty subtitle gap');
  });
  await check('speed changes retain media-time subtitle alignment', async () => {
    const result = await send({ action: 'setSpeed', speed: 1.75 });
    assert.ok(!result?.error, JSON.stringify(result));
    assert.equal(await page.$eval('video', video => video.playbackRate), 1.75);
    await seek(1.5);
    await eventually(lines, value => value.target === target.cues[0].text, 'media clock at 1.75x');
  });
  await check('speed shortcuts preserve text editing', async () => {
    await page.locator('#typing').focus();
    await page.keyboard.press('Control+ArrowUp');
    assert.equal(await page.$eval('video', video => video.playbackRate), 1.75);
    await page.locator('#editing').focus();
    await page.keyboard.press('Control+ArrowUp');
    assert.equal(await page.$eval('video', video => video.playbackRate), 1.75);
    await page.$eval('#editing', element => element.blur());
    await page.keyboard.press('Control+ArrowUp');
    await eventually(() => page.$eval('video', video => video.playbackRate), value => value === 2, 'speed shortcut');
  });
  await check('wrong media session is rejected without replacing the displayed session', async () => {
    const result = await send({ action: 'loadSubtitleSession', session: { ...session, mediaKey: 'other-media' } });
    assert.ok(result?.error || result?.ok === false, 'mismatched session must return an error');
    assert.equal((await lines()).target, target.cues[0].text);
    await mkdir(diagnostics, { recursive: true });
    await page.screenshot({ path: join(diagnostics, 'subtitle-overlay.png') });
  });
  await check('container fullscreen keeps the overlay in the fullscreen subtree', async () => {
    await page.locator('#container-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'player');
    await eventually(() => page.evaluate(() => {
      const host = document.querySelector('[data-ottspeed-subtitle-overlay]');
      return Boolean(document.fullscreenElement?.contains(host) && getComputedStyle(host).display !== 'none');
    }), Boolean, 'fullscreen overlay');
    await page.evaluate(() => document.exitFullscreen());
  });
  await check('video-only fullscreen hides unsupported custom overlay and reports it', async () => {
    await page.locator('#video-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.tagName === 'VIDEO');
    await eventually(lines, value => !value.visible, 'video fullscreen overlay hidden');
    const status = await state();
    const subtitleStatus = status.session || status.subtitles || status.state || status;
    assert.equal(subtitleStatus.warningCode, 'VIDEO_FULLSCREEN_UNSUPPORTED');
    await page.evaluate(() => document.exitFullscreen());
  });
  await check('native capture exposes only available cues and preserves track mode', async () => {
    await page.evaluate(() => {
      const track = document.querySelector('video').addTextTrack('subtitles', 'Synthetic English', 'en');
      track.mode = 'hidden';
      track.addCue(new VTTCue(0, 1, 'A synthetic native cue.'));
    });
    const response = await send({ action: 'captureNativeTrack', index: 0 });
    const captured = response.track || response;
    assert.equal(captured.coverage, 'available-cues');
    assert.equal(captured.cues.length, 1);
    assert.equal(await page.$eval('video', video => video.textTracks[0].mode), 'hidden');
  });
  let workspace;
  const workspaceUrl = `chrome-extension://${extensionId}/subtitles/workspace.html?tabId=${tabId}`;
  const storedSession = tab => tab.evaluate(key => OTTSubtitleLibrary.get(key), session.mediaKey);
  await check('workspace imports files, exchanges a translation JSON, and restores IndexedDB after reload', async () => {
    workspace = await context.newPage();
    await workspace.goto(workspaceUrl);
    await workspace.waitForFunction(() => !document.querySelector('#source-file').disabled);
    const sourceSrt = '1\n00:00:01,000 --> 00:00:02,000\nAn original synthetic sentence.\n\n2\n00:00:04,000 --> 00:00:05,000\nA second synthetic sentence.\n';
    const targetSrt = '1\n00:00:01,000 --> 00:00:02,000\n직접 작성한 합성 자막.\n\n2\n00:00:04,000 --> 00:00:05,000\n두 번째 합성 자막.\n';
    await workspace.locator('#source-file').setInputFiles({ name: 'synthetic-en.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(sourceSrt) });
    await eventually(() => storedSession(workspace), value => value?.tracks.source?.cues.length === 2, 'source committed to IndexedDB');
    await workspace.waitForFunction(() => !document.querySelector('#a-file').disabled);
    await workspace.locator('#a-file').setInputFiles({ name: 'synthetic-ko.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(targetSrt) });
    await eventually(() => storedSession(workspace), value => value?.tracks.a?.cues.length === 2, 'A committed to IndexedDB');
    await workspace.waitForFunction(() => !document.querySelector('#export-request').disabled);
    const exported = workspace.waitForEvent('download');
    await workspace.locator('#export-request').click();
    const download = await exported;
    const request = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(request.kind, 'ottspeed.translation-request');
    assert.equal(request.mediaKey, session.mediaKey);
    assert.equal(request.mode, 'edit');
    assert.equal(request.slots.length, 2);
    const response = { ...request.outputTemplate, cues: request.slots.map((cue, index) => ({ id: cue.id, text: `검증용 합성 번역 ${index + 1}.` })) };
    await workspace.waitForFunction(() => !document.querySelector('#response-file').disabled);
    await workspace.locator('#response-file').setInputFiles({ name: 'synthetic-response.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(response)) });
    await eventually(() => storedSession(workspace), value => value?.tracks.b?.cues[0]?.text === '검증용 합성 번역 1.', 'B translation committed to IndexedDB');
    await workspace.reload();
    await eventually(() => workspace.locator('#a-info').textContent(), value => value.includes('synthetic-ko.srt'), 'A file label restored');
    await eventually(() => workspace.locator('#b-info').textContent(), value => value.includes('synthetic-response.ko.vtt'), 'B file label restored');
    assert.equal((await storedSession(workspace)).tracks.source.cues.length, 2);
    await workspace.screenshot({ path: join(diagnostics, 'workspace.png'), fullPage: true });
  });
  await check('two workspaces reject a stale IndexedDB write and keep the newer setting', async () => {
    const second = await context.newPage();
    try {
      await second.goto(workspaceUrl);
      await second.waitForFunction(() => !document.querySelector('#offset').disabled);
      await workspace.locator('#offset').fill('0.25');
      await workspace.locator('#offset').press('Tab');
      const committed = await eventually(() => storedSession(workspace), value => value?.settings.offsetMs === 250, 'new timing committed');
      await second.locator('#offset').fill('0.5');
      await second.locator('#offset').press('Tab');
      await eventually(() => second.locator('#notice').textContent(), value => value.includes('다른 작업실'), 'stale workspace conflict');
      const retained = await storedSession(second);
      assert.equal(retained.settings.offsetMs, 250);
      assert.equal(retained.revision, committed.revision);
      assert.equal(await second.locator('#offset').inputValue(), '0.25');
    } finally { await second.close(); }
    await workspace.close();
    await page.bringToFront();
  });
  await check('SPA episode change clears captions before attaching the next session', async () => {
    await page.evaluate(() => history.pushState({}, '', '/episode-two'));
    await eventually(state, value => value.media?.key && value.media.key !== session.mediaKey, 'SPA media identity');
    await eventually(lines, value => !value.visible && !value.target && !value.source, 'old episode captions cleared');
  });
  await check('detached videos clear state; new videos retain speed without old subtitles', async () => {
    await page.$eval('video', video => video.remove());
    await eventually(state, value => value.hasVideo === false, 'detached video state');
    await eventually(lines, value => !value.visible, 'detached video overlay');
    await page.evaluate(() => {
      const video = document.createElement('video');
      video.id = 'replacement'; video.src = '/synthetic.wav'; video.muted = true;
      document.querySelector('#player').appendChild(video);
    });
    await eventually(state, value => value.hasVideo === true, 'replacement video detection');
    assert.equal(await page.$eval('video', video => video.playbackRate), 2);
    assert.equal((await lines()).target, '');
  });
  assert.deepEqual(errors, [], 'page has no uncaught JavaScript errors');
  console.log(`PASS ${passed} local Chromium integration checks. Streaming site validation remains separate.`);
} catch (error) {
  console.error(`FAIL during "${currentCheck}" after ${passed} checks: ${error.stack || error}`);
  process.exitCode = 1;
  await mkdir(diagnostics, { recursive: true });
  const pages = [];
  for (const [index, inspected] of capturedPages.entries()) {
    if (inspected.isClosed()) continue;
    const detail = await inspected.evaluate(() => ({
      url: location.href,
      notice: document.querySelector('#notice')?.textContent,
      fullscreen: document.fullscreenElement?.tagName,
      video: [...document.querySelectorAll('video')].map(video => ({
        readyState: video.readyState, currentTime: video.currentTime, paused: video.paused,
        playbackRate: video.playbackRate, error: video.error?.message, duration: video.duration,
        currentSrc: video.currentSrc, networkState: video.networkState,
        seekable: Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]),
        buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)])
      }))
    })).catch(() => ({ url: inspected.url() }));
    pages.push(detail);
    await inspected.screenshot({ path: join(diagnostics, `failure-page-${index}.png`), fullPage: true }).catch(() => {});
  }
  console.error('Browser failure diagnostics:', JSON.stringify({ check: currentCheck, pageErrors: errors, pages }));
  await writeFile(join(diagnostics, 'failure.json'), JSON.stringify({ check: currentCheck, passed, error: error.stack || String(error), pageErrors: errors, pages }, null, 2));
} finally {
  if (context && tracing) await context.tracing.stop(process.exitCode ? { path: join(diagnostics, 'trace.zip') } : {}).catch(() => {});
  await context?.close();
  await new Promise(accept => server.close(accept));
  await rm(profile, { recursive: true, force: true });
}
