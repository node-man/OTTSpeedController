/* OTTSpeed: playback controls and per-video subtitle sessions. */
(() => {
  'use strict';
  if (globalThis.__OTT_SPEED_CONTROLLER__) return;
  globalThis.__OTT_SPEED_CONTROLLER__ = true;

  const videos = new Map();
  const roots = new Map();
  function documentUUID() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const documentKey = documentUUID();
  let videoSequence = 0;
  let currentSpeed = 1;
  let activeVideo = null;
  let media = null;
  let generation = 0;
  let scanTimer = null;
  let indicatorTimer = null;
  let previousState = '';
  let stopped = false;
  const subtitles = new OTTSubtitleController();
  const validSpeed = value => typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4;

  const ready = chrome.storage.local.get('speed').then(({ speed }) => {
    if (validSpeed(speed)) currentSpeed = speed;
  }).catch(() => {}).then(() => { if (!stopped) scan(); });

  function safeSend(message) {
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch { return Promise.resolve(null); }
  }

  function state() {
    return {
      media: media ? { ...media } : null,
      hasVideo: Boolean(activeVideo?.isConnected),
      isPlaying: Boolean(activeVideo && !activeVideo.paused && !activeVideo.ended),
      currentSpeed: activeVideo?.playbackRate || currentSpeed,
      subtitles: subtitles.getState()
    };
  }

  function notifyState() {
    const value = state();
    const signature = JSON.stringify([value.hasVideo, value.isPlaying, value.currentSpeed, media?.key]);
    if (signature === previousState) return;
    previousState = signature;
    const small = { hasVideo: value.hasVideo, isPlaying: value.isPlaying, currentSpeed: value.currentSpeed };
    void safeSend({ action: 'updateVideoState', ...small });
    void safeSend({ action: 'videoStateChanged', ...small });
  }

  function identify(video) {
    const identity = OTTSubtitles.mediaIdentity(location.href);
    if (!identity.supportedPlatform) {
      const item = video && videos.get(video);
      // Generic sites have no reliable episode identifier. Bind to this document/video/source.
      identity.key += `:document:${documentKey}:video:${item?.id || 0}:source:${item?.sourceVersion || 0}`;
    }
    return identity;
  }

  function synchronizeMedia(nextVideo) {
    const nextMedia = identify(nextVideo);
    if (nextMedia.key !== media?.key) {
      media = nextMedia;
      const ownGeneration = ++generation;
      subtitles.setMedia(media); // Clear the previous episode before attaching a reused video.
      void safeSend({ action: 'getSubtitleSession', mediaKey: media.key }).then(result => {
        if (stopped || ownGeneration !== generation || !result?.session) return;
        try { subtitles.loadSession(result.session); } catch { /* Corrupt saved data is never displayed. */ }
      });
    }
    if (nextVideo !== activeVideo) {
      activeVideo = nextVideo;
      subtitles.setVideo(activeVideo);
    }
    notifyState();
  }

  function chooseVideo() {
    let chosen = null;
    let best = -1;
    for (const video of videos.keys()) {
      if (!video.isConnected) continue;
      const rect = video.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const visible = width * height;
      const style = getComputedStyle(video);
      if (!visible || style.display === 'none' || style.visibility === 'hidden') continue;
      const score = visible + (video === activeVideo ? visible * 0.05 : 0);
      if (score > best) { best = score; chosen = video; }
    }
    synchronizeMedia(chosen);
  }

  function updateSource(video) {
    const item = videos.get(video);
    if (!item) return;
    const source = video.currentSrc || video.getAttribute('src') || '';
    if (source !== item.source) { item.source = source; item.sourceVersion += 1; }
  }

  function attachVideo(video) {
    if (videos.has(video)) return;
    const handler = event => {
      if (event.type === 'loadedmetadata' || event.type === 'emptied') updateSource(video);
      if (event.type === 'loadedmetadata') applySpeed(video);
      if (event.type === 'ratechange' && video === activeVideo && validSpeed(video.playbackRate) && video.playbackRate !== currentSpeed) {
        currentSpeed = video.playbackRate;
        void chrome.storage.local.set({ speed: currentSpeed }).catch(() => {});
      }
      chooseVideo();
    };
    const events = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'ratechange'];
    videos.set(video, { id: ++videoSequence, sourceVersion: 0, source: '', handler, events });
    updateSource(video);
    for (const name of events) video.addEventListener(name, handler);
    applySpeed(video);
  }

  function applySpeed(video) {
    try { if (video.playbackRate !== currentSpeed) video.playbackRate = currentSpeed; } catch { /* Site may reject a rate. */ }
  }

  function scheduleScan() {
    if (stopped || scanTimer !== null) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 80);
  }

  function inspectRoot(root) {
    if (!roots.has(root)) {
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (mutation.removedNodes.length && activeVideo && !activeVideo.isConnected) { scheduleScan(); return; }
          for (const node of mutation.removedNodes) {
            if (node.nodeType === 1 && (node.tagName === 'VIDEO' || node.shadowRoot || node.querySelector?.('video'))) {
              scheduleScan(); return;
            }
          }
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && (node.tagName === 'VIDEO' || node.shadowRoot || node.querySelector?.('video'))) {
              scheduleScan(); return;
            }
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
      roots.set(root, observer);
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'VIDEO') attachVideo(element);
      // Do not inspect our own caption shadow root.
      if (element.shadowRoot && !element.id?.startsWith('ottspeed-')) inspectRoot(element.shadowRoot);
    }
  }

  function scan() {
    if (stopped) return;
    for (const [video, item] of videos) {
      if (!video.isConnected) {
        for (const name of item.events) video.removeEventListener(name, item.handler);
        videos.delete(video);
      } else updateSource(video);
    }
    for (const [root, observer] of roots) {
      if (root.host && !root.host.isConnected) { observer.disconnect(); roots.delete(root); }
    }
    inspectRoot(document);
    chooseVideo();
  }

  async function setSpeed(speed) {
    if (!validSpeed(speed)) throw new Error('재생 속도는 0.25~4 사이의 숫자여야 합니다.');
    currentSpeed = speed;
    for (const video of videos.keys()) applySpeed(video);
    await chrome.storage.local.set({ speed });
    notifyState();
    return { success: true, ...state() };
  }

  const indicator = document.createElement('div');
  indicator.id = 'ottspeed-speed-indicator';
  indicator.setAttribute('aria-live', 'polite');
  indicator.style.cssText = 'position:fixed;top:22px;right:22px;z-index:2147483647;padding:10px 16px;background:#142c28;color:#a4f3d4;border:1px solid #62cba6;border-radius:12px;font:600 20px system-ui;pointer-events:none;display:none';

  function showSpeed() {
    const fullscreen = document.fullscreenElement;
    if (fullscreen?.tagName === 'VIDEO') return;
    (fullscreen || document.body || document.documentElement).appendChild(indicator);
    indicator.textContent = `${currentSpeed.toFixed(2).replace(/\.?0+$/, '')}×`;
    indicator.style.display = 'block';
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => { indicator.style.display = 'none'; }, 1200);
  }

  function keyboard(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return;
    if (event.composedPath().some(node => node?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node?.tagName))) return;
    if (!activeVideo) return;
    const base = validSpeed(activeVideo.playbackRate) ? activeVideo.playbackRate : currentSpeed;
    let next;
    if (event.key === 'ArrowUp' || event.key === ']') next = Math.min(4, base + 0.25);
    else if (event.key === 'ArrowDown' || event.key === '[') next = Math.max(0.25, base - 0.25);
    else if (event.key === '0') next = 1;
    else return;
    event.preventDefault();
    void setSpeed(next).then(showSpeed).catch(() => {});
  }
  document.addEventListener('keydown', keyboard);

  const actions = new Set(['checkVideo', 'getSpeed', 'setSpeed', 'subtitleState', 'loadSubtitleSession', 'listNativeTracks', 'captureNativeTrack']);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !actions.has(message?.action)) return false;
    ready.then(async () => {
      chooseVideo();
      switch (message.action) {
        case 'checkVideo': case 'subtitleState': return state();
        case 'getSpeed': return { speed: state().currentSpeed };
        case 'setSpeed': return setSpeed(message.speed);
        case 'loadSubtitleSession': {
          if (message.session?.mediaKey !== media?.key) throw new Error('영상이 바뀌었습니다. 현재 영상의 자막을 다시 선택하세요.');
          subtitles.loadSession(message.session);
          generation += 1; // A successful user edit supersedes a pending automatic restore.
          return state();
        }
        case 'listNativeTracks': return { tracks: subtitles.readNativeTracks() };
        case 'captureNativeTrack': {
          if (message.mediaKey && message.mediaKey !== media?.key) throw new Error('자막을 가져오는 동안 영상이 바뀌었습니다.');
          return { track: subtitles.captureNativeTrack(message.index), mediaKey: media?.key };
        }
      }
    }).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  });

  // URL changes in an SPA do not necessarily produce a popstate event.
  const identityTimer = setInterval(() => { if (!stopped) chooseVideo(); }, 500);
  const discoveryTimer = setInterval(scan, 2500); // Also finds open shadow roots attached after insertion.
  addEventListener('resize', chooseVideo);
  addEventListener('popstate', chooseVideo);
  addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopped = true;
    clearInterval(identityTimer); clearInterval(discoveryTimer);
    clearTimeout(scanTimer); clearTimeout(indicatorTimer);
    document.removeEventListener('keydown', keyboard);
    removeEventListener('resize', chooseVideo); removeEventListener('popstate', chooseVideo);
    for (const observer of roots.values()) observer.disconnect();
    for (const [video, item] of videos) for (const name of item.events) video.removeEventListener(name, item.handler);
    videos.clear(); roots.clear(); subtitles.destroy(); indicator.remove();
  });
})();
