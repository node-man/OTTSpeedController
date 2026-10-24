import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnvironment } from './dom.mjs';

const media = { key: 'netflix:synthetic-episode-one', platform: 'netflix', videoId: 'synthetic-episode-one' };
const sourceText = 'An original synthetic sentence.';
const targetText = '직접 작성한 합성 문장.';

function track(text, name = 'synthetic.srt') {
  return { name, format: 'srt', language: 'ko', cues: [
    { id: 'one', startMs: 1000, endMs: 2000, text },
    { id: 'two', startMs: 4000, endMs: 5000, text: `${text} 두 번째.` }
  ] };
}
function makeSession(overrides = {}) {
  return {
    mediaKey: media.key,
    tracks: { source: track(sourceText), a: track(targetText), b: null },
    settings: { enabled: true, display: 'bilingual', activeTarget: 'a', offsetMs: 0, scale: 1, hideNative: true, ...overrides }
  };
}
async function fixture() {
  const env = await makeEnvironment();
  const { document, context } = env;
  const player = document.createElement('div'); player.className = 'watch-video';
  const video = document.createElement('video');
  const native = document.createElement('div'); native.className = 'player-timedtext'; native.textContent = 'Native caption';
  native.style.setProperty('color', 'red');
  document.body.appendChild(player); player.append(video, native);
  const notifications = [];
  const controller = new context.OTTSubtitleController({ onChange: state => notifications.push(state) });
  controller.setMedia(media); controller.setVideo(video);
  const seek = time => { video.currentTime = time; video.dispatchEvent('seeked'); };
  const host = () => document.querySelector('[data-ottspeed-subtitle-overlay]');
  return { ...env, player, video, native, controller, notifications, seek, host };
}

test('paused seeks render source/target, overlaps, and exclusive end without changing speed', async () => {
  const f = await fixture();
  const session = makeSession();
  session.tracks.a.cues.push({ id: 'overlap', startMs: 1500, endMs: 1800, text: '겹치는 합성 자막.' });
  f.controller.loadSession(session);
  f.video.playbackRate = 1.75;
  f.seek(1.6);
  assert.equal(f.controller.getState().targetText, `${targetText}\n겹치는 합성 자막.`);
  assert.equal(f.controller.getState().sourceText, sourceText);
  f.seek(4.5);
  assert.equal(f.controller.getState().targetText, `${targetText} 두 번째.`);
  f.seek(1.2);
  assert.equal(f.controller.getState().targetText, targetText);
  f.seek(2);
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.host().style.getPropertyValue('display'), 'none');
  assert.equal(f.video.playbackRate, 1.75);
  f.controller.destroy();
});

test('official plan B renders at current playback time and exposes completed translation without seeking or changing rate',async()=>{
  const f=await fixture(),session=makeSession();session.tracks.a=null;session.tracks.b={...track('공식 연동 합성 번역.'),requestId:'plan-translation',provenance:'chatgpt-plan',partial:false,totalCueCount:2,readyThroughMs:5000};session.settings.activeTarget='b';
  f.video.currentTime=1.5;f.video.playbackRate=1.75;const paused=f.video.paused;f.controller.loadSession(session);
  const state=f.controller.getState();assert.equal(state.targetText,'공식 연동 합성 번역.');assert.equal(state.translation.requestId,'plan-translation');assert.equal(state.translation.partial,false);assert.equal(state.translation.readyCueCount,2);assert.equal(f.video.currentTime,1.5);assert.equal(f.video.playbackRate,1.75);assert.equal(f.video.paused,paused);f.controller.destroy();
});

test('offset and drift scale are applied once to the media clock', async () => {
  const f = await fixture();
  f.controller.loadSession(makeSession({ offsetMs: 1000, scale: 2 }));
  f.seek(4); // (4000 - 1000) / 2 = 1500 ms.
  assert.equal(f.controller.getState().targetText, targetText);
  f.video.playbackRate = 2;
  f.video.dispatchEvent('ratechange');
  assert.equal(f.controller.getState().targetText, targetText);
  f.seek(5); // End is exclusive: (5000 - 1000) / 2 = 2000 ms.
  assert.equal(f.controller.getState().currentText, '');
  f.controller.destroy();
});

test('partial B keeps fixed times, falls back to English beyond readiness, and clears pending on final delivery',async()=>{
  const f=await fixture(),session=makeSession({display:'target',activeTarget:'b'});
  session.tracks.b={...track('합성 첫 번역.'),cues:[{id:'one',startMs:1000,endMs:2000,text:'합성 첫 번역.'}],
    requestId:'synthetic-job',provenance:'chatgpt-mcp-partial',partial:true,totalCueCount:2,readyThroughMs:4000};
  f.controller.loadSession(session);f.seek(1.5);
  assert.equal(f.controller.getState().targetText,'합성 첫 번역.');assert.equal(f.controller.getState().translation.readyCueCount,1);
  f.seek(4.5);assert.equal(f.controller.getState().targetText,'');assert.equal(f.controller.getState().sourceText,`${sourceText} 두 번째.`);
  assert.equal(f.controller.getState().warningCode,'TRANSLATION_PENDING');
  session.tracks.b={...track('합성 완성 번역.'),requestId:'synthetic-job',provenance:'chatgpt-mcp',partial:false,totalCueCount:2,readyThroughMs:5000};
  f.controller.loadSession(session);
  assert.equal(f.controller.getState().targetText,'합성 완성 번역. 두 번째.');assert.equal(f.controller.getState().warningCode,null);
  assert.equal(f.controller.getState().sourceText,'');f.controller.destroy();
});

test('per-track timing aligns an existing Korean track without shifting the English source', async () => {
  const f = await fixture();
  const session = makeSession();
  session.tracks.a.sync = { offsetMs: 2000, scale: 1 };
  session.tracks.b = { ...track('다른 타이밍의 합성 B.'), sync: { offsetMs: -500, scale: 1 } };
  f.controller.loadSession(session); f.seek(1.5);
  assert.equal(f.controller.getState().sourceText, sourceText);
  assert.equal(f.controller.getState().targetText, '');
  f.seek(3.5);
  assert.equal(f.controller.getState().sourceText, '');
  assert.equal(f.controller.getState().targetText, targetText);
  session.settings.activeTarget = 'b';
  f.controller.loadSession(session); f.seek(1.2);
  assert.equal(f.controller.getState().sourceText, sourceText);
  assert.equal(f.controller.getState().targetText, '다른 타이밍의 합성 B.');
  f.controller.destroy();
});

test('global and per-track timing add offsets and multiply scales', async () => {
  const f = await fixture();
  const session = makeSession({ offsetMs: 1000, scale: 2 });
  session.tracks.a.sync = { offsetMs: 500, scale: 1.5 };
  f.controller.loadSession(session);
  f.seek(4.7); // source: (4700 - 1000) / 2; A: (4700 - 1500) / 3.
  assert.equal(f.controller.getState().sourceText, sourceText);
  assert.equal(f.controller.getState().targetText, targetText);
  f.seek(6);
  assert.equal(f.controller.getState().sourceText, '');
  assert.equal(f.controller.getState().targetText, targetText);
  f.seek(7.5); // Target end remains exclusive after both timing corrections.
  assert.equal(f.controller.getState().targetText, '');
  f.controller.destroy();
});

test('invalid per-track timing fails atomically and loaded timing is a snapshot', async () => {
  const f = await fixture();
  const session = makeSession(); session.tracks.a.sync = { offsetMs: 2000, scale: 1 };
  f.controller.loadSession(session); f.seek(3.5);
  session.tracks.a.sync.offsetMs = 0;
  f.video.dispatchEvent('timeupdate');
  assert.equal(f.controller.getState().targetText, targetText);
  for (const sync of [null, [], { offsetMs: '2000' }, { offsetMs: Infinity }, { offsetMs: 3600001 }, { scale: 0 }, { scale: 2.01 }, { scale: NaN }]) {
    const invalid = makeSession(); invalid.tracks.a.sync = sync;
    assert.throws(() => f.controller.loadSession(invalid));
    assert.equal(f.controller.getState().targetText, targetText);
  }
  f.controller.destroy();
});

test('caption markup stays literal text and never creates DOM nodes', async () => {
  const f = await fixture();
  const unsafe = '<img src=x onerror="alert(1)"><script>throw 1</script> & literal';
  const session = makeSession(); session.tracks.a = track(unsafe);
  f.controller.loadSession(session); f.seek(1.5);
  const shadow = f.host().shadowRoot;
  assert.equal(shadow.querySelector('[data-subtitle-line="target"]').textContent, unsafe);
  assert.equal(shadow.querySelectorAll('img').length, 0);
  assert.equal(shadow.querySelectorAll('script').length, 0);
  f.controller.destroy();
});

test('legacy Netflix source class closers are hidden without mutating the saved snapshot or target', async () => {
  const f = await fixture();
  const session = makeSession();
  const legacy = 'Synthetic source.</c.mono_sans></c.white> & literal <i>text</i>';
  session.tracks.source = { ...track(legacy), capture: { format: 'vtt' } };
  session.tracks.a = track('Literal target </c.white>');
  const snapshot = JSON.stringify(session);
  f.controller.loadSession(session); f.seek(1.5);
  assert.equal(f.controller.getState().sourceText, 'Synthetic source. & literal <i>text</i>');
  assert.equal(f.controller.getState().targetText, 'Literal target </c.white>');
  assert.equal(JSON.stringify(session), snapshot);
  f.controller.destroy();
});

test('native caption style is scoped and restored across gaps, disabling, and detach', async () => {
  const f = await fixture();
  f.controller.loadSession(makeSession()); f.seek(1.5);
  assert.equal(f.controller.getState().nativeCaptionsHidden, true);
  assert.equal(f.document.querySelectorAll('[data-ottspeed-native-caption-style]').length, 1);
  assert.equal(f.native.style.getPropertyValue('color'), 'red');
  f.seek(3);
  assert.equal(f.controller.getState().nativeCaptionsHidden, false);
  assert.equal(f.document.querySelectorAll('[data-ottspeed-native-caption-style]').length, 0);
  f.seek(1.5);
  f.controller.loadSession(makeSession({ enabled: false }));
  assert.equal(f.controller.getState().nativeCaptionsHidden, false);
  f.controller.loadSession(makeSession());
  f.controller.setVideo(null);
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.controller.getState().nativeCaptionsHidden, false);
  assert.equal(f.video.listenerCount(), 0);
  assert.equal(f.native.textContent, 'Native caption');
  f.controller.destroy();
});

test('fullscreen uses the player subtree and exposes video-only fullscreen limitation', async () => {
  const f = await fixture(); f.controller.loadSession(makeSession()); f.seek(1.5);
  f.document.fullscreenElement = f.player; f.document.dispatchEvent('fullscreenchange');
  assert.equal(f.host().parentNode, f.player);
  assert.equal(f.controller.getState().capabilities.fullscreenMode, 'container');
  f.document.fullscreenElement = f.video; f.document.dispatchEvent('fullscreenchange');
  assert.equal(f.controller.getState().warningCode, 'VIDEO_FULLSCREEN_UNSUPPORTED');
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.controller.getState().nativeCaptionsHidden, false);
  f.document.fullscreenElement = null; f.document.dispatchEvent('fullscreenchange');
  assert.equal(f.host().parentNode, f.document.documentElement);
  assert.equal(f.controller.getState().targetText, targetText);
  f.controller.destroy();
});

test('wrong media session fails atomically and SPA identity clears prior captions', async () => {
  const f = await fixture(); f.controller.loadSession(makeSession()); f.seek(1.5);
  assert.throws(() => f.controller.loadSession({ ...makeSession(), mediaKey: 'netflix:wrong' }));
  assert.equal(f.controller.getState().targetText, targetText);
  f.controller.setMedia({ ...media, key: 'netflix:synthetic-episode-two' });
  const state = f.controller.getState();
  assert.equal(state.currentText, '');
  assert.equal(state.sessionMediaKey, null);
  assert.equal(state.trackCounts.a, 0);
  assert.equal(state.nativeCaptionsHidden, false);
  assert.throws(() => f.controller.loadSession(makeSession()));
  f.controller.destroy();
});

test('stale frame callbacks cannot restore a previous episode or detached video', async () => {
  const f = await fixture(); f.controller.loadSession(makeSession());
  f.video.paused = false; f.video.currentTime = 1.5; f.video.dispatchEvent('play');
  const staleId = [...f.video.frames.keys()][0];
  assert.ok(staleId);
  f.controller.setMedia({ ...media, key: 'netflix:synthetic-episode-two' });
  f.video.fireFrame(staleId, 1.5);
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.video.frames.size, 0);
  f.controller.setMedia(media); f.controller.loadSession(makeSession());
  const detachId = [...f.video.frames.keys()][0];
  f.controller.setVideo(null); f.video.fireFrame(detachId, 1.5);
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.video.frames.size, 0);
  assert.equal(f.video.listenerCount(), 0);
  f.controller.destroy();
  assert.equal(f.document.listenerCount(), 0);
  assert.equal(f.events.listenerCount(), 0);
});

test('native capture marks available-cue coverage and does not alter native track mode', async () => {
  const f = await fixture();
  f.video.textTracks = [{
    label: 'Synthetic English', language: 'en', kind: 'subtitles', mode: 'hidden',
    cues: [{ startTime: 0, endTime: 1, text: 'A synthetic native cue.' }, { startTime: 4, endTime: 3, text: 'Invalid time.' }]
  }];
  const listed = f.controller.readNativeTracks();
  assert.equal(listed[0].coverage, 'available-cues');
  assert.equal(listed[0].cueCount, 2);
  const captured = f.controller.captureNativeTrack(0);
  assert.equal(captured.coverage, 'available-cues');
  assert.equal(captured.timingVerified, false);
  assert.equal(captured.cues.length, 1);
  assert.equal(f.video.textTracks[0].mode, 'hidden');
  assert.throws(() => f.controller.captureNativeTrack(-1));
  assert.throws(() => f.controller.captureNativeTrack(1));
  f.video.textTracks[0].cues = null;
  assert.equal(f.controller.readNativeTracks()[0].accessible, false);
  assert.throws(() => f.controller.captureNativeTrack(0));
  f.controller.destroy();
});

test('page visibility clears native hiding and restores paused captions on return', async () => {
  const f = await fixture(); f.controller.loadSession(makeSession()); f.seek(1.5);
  f.document.hidden = true; f.document.dispatchEvent('visibilitychange');
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.controller.getState().nativeCaptionsHidden, false);
  f.document.hidden = false; f.document.dispatchEvent('visibilitychange');
  assert.equal(f.controller.getState().targetText, targetText);
  f.controller.destroy();
});

test('unconnected video immediately hides the overlay without mutating playback', async () => {
  const f = await fixture(); f.controller.loadSession(makeSession()); f.seek(1.5);
  f.video.playbackRate = 2; f.video.remove(); f.video.dispatchEvent('timeupdate');
  assert.equal(f.controller.getState().hasVideo, false);
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.controller.getState().nativeCaptionsHidden, false);
  assert.equal(f.video.playbackRate, 2);
  f.controller.destroy();
});

test('an emptied media source stays blank through layout/time events until new metadata', async () => {
  const f = await fixture(); f.controller.loadSession(makeSession()); f.seek(1.5);
  assert.equal(f.controller.getState().targetText, targetText);
  f.video.dispatchEvent('emptied');
  f.video.dispatchEvent('timeupdate'); f.context.dispatchEvent('resize');
  assert.equal(f.controller.getState().currentText, '');
  assert.equal(f.controller.getState().nativeCaptionsHidden, false);
  f.video.dispatchEvent('loadedmetadata');
  assert.equal(f.controller.getState().targetText, targetText);
  f.controller.destroy();
});
