/* OTTSpeed subtitle display. Runs in the extension's isolated content world. */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    display: 'target',
    activeTarget: 'a',
    offsetMs: 0,
    scale: 1,
    fontSize: 28,
    bottomPercent: 10,
    hideNative: false
  });
  const VIDEO_EVENTS = [
    'play', 'playing', 'pause', 'ended', 'timeupdate', 'seeking', 'seeked',
    'ratechange', 'loadedmetadata', 'loadeddata', 'durationchange', 'emptied'
  ];
  const NATIVE_SELECTORS = Object.freeze({
    netflix: '.player-timedtext',
    youtube: '.ytp-caption-window-container'
  });

  function finite(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function normalizeSettings(input = {}) {
    return {
      enabled: input.enabled !== false,
      display: ['target', 'bilingual', 'source'].includes(input.display) ? input.display : DEFAULTS.display,
      activeTarget: input.activeTarget === 'b' ? 'b' : 'a',
      offsetMs: Math.round(finite(input.offsetMs, DEFAULTS.offsetMs)),
      scale: clamp(finite(input.scale, DEFAULTS.scale), 0.1, 10),
      fontSize: clamp(finite(input.fontSize, DEFAULTS.fontSize), 12, 72),
      bottomPercent: clamp(finite(input.bottomPercent, DEFAULTS.bottomPercent), 0, 80),
      hideNative: input.hideNative === true
    };
  }

  function normalizeTrackSync(sync) {
    if (sync === undefined) return { offsetMs: 0, scale: 1 };
    if (sync === null || typeof sync !== 'object' || Array.isArray(sync)) {
      throw new Error('트랙별 시간 보정 형식이 올바르지 않습니다.');
    }
    const offsetMs = sync.offsetMs === undefined ? 0 : sync.offsetMs;
    const scale = sync.scale === undefined ? 1 : sync.scale;
    if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || Math.abs(offsetMs) > 3600000 ||
      typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 2) {
      throw new Error('트랙별 시간 보정은 −3600~3600초, 시간 배율은 50~200% 사이여야 합니다.');
    }
    return { offsetMs, scale };
  }

  function composedContains(container, element) {
    for (let current = element; current;) {
      if (current === container) return true;
      current = current.parentElement || current.getRootNode?.().host || null;
    }
    return false;
  }

  function cueText(cues) {
    // The same subtitle may be split into overlapping styled WebVTT regions.
    return [...new Set(cues.map(cue => cue.text).filter(Boolean))].join('\n');
  }

  class OTTSubtitleController {
    constructor({ onChange } = {}) {
      if (!root.OTTSubtitles) throw new Error('Subtitle core must load before the controller.');
      this._core = root.OTTSubtitles;
      this._document = root.document;
      this._onChange = typeof onChange === 'function' ? onChange : null;
      this._video = null;
      this._media = null;
      this._tracks = { source: null, a: null, b: null };
      this._indexes = { source: null, a: null, b: null };
      this._settings = { ...DEFAULTS };
      this._sessionKey = null;
      this._destroyed = false;
      this._frameId = null;
      this._frameKind = null;
      this._frameVideo = null;
      this._frameGeneration = 0;
      this._failedVideoFrames = false;
      this._waitingForMetadata = false;
      this._currentText = '';
      this._sourceText = '';
      this._targetText = '';
      this._warning = null;
      this._warningCode = null;
      this._fullscreenMode = 'none';
      this._lastStateSignature = '';
      this._nativeStyle = null;
      this._nativeScope = null;
      this._nativeAttribute = `data-ottspeed-native-${Math.random().toString(36).slice(2)}`;
      this._resizeObserver = null;

      this._handleVideoEvent = event => {
        if (event.type === 'emptied') this._waitingForMetadata = true;
        if (event.type === 'loadedmetadata' || event.type === 'loadeddata') this._waitingForMetadata = false;
        this._cancelFrame();
        this._render();
        this._scheduleFrame();
      };
      this._handleLayout = () => this._render();
      this._handleVisibility = () => {
        this._cancelFrame();
        this._render();
        this._scheduleFrame();
      };
      this._createOverlay();
      this._document.addEventListener('fullscreenchange', this._handleLayout);
      this._document.addEventListener('scroll', this._handleLayout, true);
      this._document.addEventListener('visibilitychange', this._handleVisibility);
      root.addEventListener('resize', this._handleLayout);
      root.visualViewport?.addEventListener('resize', this._handleLayout);
      root.visualViewport?.addEventListener('scroll', this._handleLayout);
    }

    setMedia(media) {
      this._assertAlive();
      if (media != null && (typeof media.key !== 'string' || !media.key)) {
        throw new Error('영상 식별자가 필요합니다.');
      }
      const next = media == null ? null : { ...media };
      if ((next?.key || null) !== (this._media?.key || null)) {
        // A reused SPA video element must never show the previous episode's cues.
        this._cancelFrame();
        this._sessionKey = null;
        this._tracks = { source: null, a: null, b: null };
        this._indexes = { source: null, a: null, b: null };
        this._clearDisplay();
      }
      this._media = next;
      this._render();
      this._scheduleFrame();
      return this.getState();
    }

    setVideo(video) {
      this._assertAlive();
      if (video != null && (video.tagName !== 'VIDEO' || typeof video.addEventListener !== 'function')) {
        throw new TypeError('A video element or null is required.');
      }
      if (video === this._video) {
        this._render();
        this._scheduleFrame();
        return this.getState();
      }
      this._cancelFrame();
      this._detachVideo();
      this._clearDisplay();
      this._video = video;
      this._failedVideoFrames = false;
      this._waitingForMetadata = false;
      if (video) {
        for (const event of VIDEO_EVENTS) video.addEventListener(event, this._handleVideoEvent);
        if (typeof root.ResizeObserver === 'function') {
          this._resizeObserver = new root.ResizeObserver(this._handleLayout);
          this._resizeObserver.observe(video);
        }
      }
      this._render();
      this._scheduleFrame();
      return this.getState();
    }

    loadSession(session) {
      this._assertAlive();
      if (session == null) {
        this._cancelFrame();
        this._sessionKey = null;
        this._tracks = { source: null, a: null, b: null };
        this._indexes = { source: null, a: null, b: null };
        this._render();
        return this.getState();
      }
      if (!this._media?.key || session.mediaKey !== this._media.key) {
        throw new Error('다른 영상의 자막입니다. 현재 영상에 맞는 자막을 불러오세요.');
      }
      // Build indexes first: malformed or mismatched input must not replace a valid session.
      const tracks = { source: null, a: null, b: null };
      const indexes = { source: null, a: null, b: null };
      for (const key of Object.keys(tracks)) {
        const track = session.tracks?.[key];
        if (track == null) continue;
        if (!Array.isArray(track.cues)) throw new Error(`${key}: 자막 목록이 올바르지 않습니다.`);
        tracks[key] = { ...track, sync: normalizeTrackSync(track.sync), cues: track.cues.map(cue => ({ ...cue })) };
        indexes[key] = this._core.createIndex(tracks[key].cues);
      }
      const settings = normalizeSettings(session.settings);
      this._cancelFrame();
      this._tracks = tracks;
      this._indexes = indexes;
      this._settings = settings;
      this._sessionKey = session.mediaKey;
      this._render();
      this._scheduleFrame();
      return this.getState();
    }

    getState() {
      const hasVideo = Boolean(this._video && this._video.isConnected !== false);
      return {
        enabled: this._settings.enabled,
        hasVideo,
        mediaKey: this._media?.key || null,
        sessionMediaKey: this._sessionKey,
        currentTime: hasVideo ? finite(this._video.currentTime, 0) : 0,
        paused: !hasVideo || Boolean(this._video.paused),
        playbackRate: hasVideo ? finite(this._video.playbackRate, 1) : 1,
        currentText: this._currentText,
        sourceText: this._sourceText,
        targetText: this._targetText,
        settings: { ...this._settings },
        trackCounts: Object.fromEntries(Object.entries(this._tracks).map(([key, track]) => [key, track?.cues.length || 0])),
        nativeCaptionsHidden: Boolean(this._nativeStyle?.isConnected),
        warning: this._warning,
        warningCode: this._warningCode,
        capabilities: {
          nativeTrackCapture: Boolean(hasVideo && !this._waitingForMetadata && this._video.textTracks),
          nativeTrackCoverage: 'available-cues',
          containerFullscreen: true,
          videoFullscreen: false,
          fullscreenMode: this._fullscreenMode,
          frameCallback: Boolean(this._video?.requestVideoFrameCallback && !this._failedVideoFrames)
        },
        destroyed: this._destroyed
      };
    }

    readNativeTracks() {
      this._assertAlive();
      if (!this._video || this._video.isConnected === false || this._waitingForMetadata) return [];
      const tracks = this._video?.textTracks;
      if (!tracks) return [];
      return Array.from(tracks, (track, index) => {
        let cueCount = null;
        try { cueCount = track.cues == null ? null : track.cues.length; } catch (_) { /* inaccessible */ }
        return {
          index,
          label: track.label || `Track ${index + 1}`,
          language: track.language || '',
          kind: track.kind || '',
          mode: track.mode,
          cueCount,
          accessible: cueCount !== null,
          coverage: 'available-cues'
        };
      });
    }

    captureNativeTrack(index) {
      this._assertAlive();
      if (!Number.isInteger(index) || index < 0) throw new Error('자막 트랙을 선택하세요.');
      if (!this._video || this._video.isConnected === false || this._waitingForMetadata) {
        throw new Error('영상의 자막이 아직 준비되지 않았습니다. 영상을 불러온 뒤 다시 확인하세요.');
      }
      const track = this._video?.textTracks?.[index];
      if (!track) throw new Error('선택한 자막 트랙을 찾을 수 없습니다.');
      let available;
      try { available = track.cues; } catch (_) { throw new Error('브라우저에서 이 자막 트랙에 접근할 수 없습니다.'); }
      if (available == null || available.length === 0) {
        throw new Error('현재 접근 가능한 자막이 없습니다. 플레이어에서 원문 자막을 켠 뒤 다시 확인하세요.');
      }
      const cues = [];
      for (let i = 0; i < available.length; i += 1) {
        const cue = available[i];
        const startMs = Math.round(cue.startTime * 1000);
        const endMs = Math.round(cue.endTime * 1000);
        const text = typeof cue.text === 'string'
          ? (this._core.plainText ? this._core.plainText(cue.text) : cue.text).trim() : '';
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || !text) continue;
        cues.push({ id: `native-${index}-${i + 1}`, startMs, endMs, text });
      }
      if (cues.length === 0) throw new Error('현재 트랙에서 읽을 수 있는 텍스트 자막을 찾지 못했습니다.');
      this._core.createIndex(cues);
      return {
        name: track.label || `Native track ${index + 1}`,
        language: track.language || '',
        format: 'vtt',
        cues,
        coverage: 'available-cues',
        timingVerified: false
      };
    }

    destroy() {
      if (this._destroyed) return;
      this._cancelFrame();
      this._detachVideo();
      this._video = null;
      this._clearDisplay();
      this._document.removeEventListener('fullscreenchange', this._handleLayout);
      this._document.removeEventListener('scroll', this._handleLayout, true);
      this._document.removeEventListener('visibilitychange', this._handleVisibility);
      root.removeEventListener('resize', this._handleLayout);
      root.visualViewport?.removeEventListener('resize', this._handleLayout);
      root.visualViewport?.removeEventListener('scroll', this._handleLayout);
      this._host.remove();
      this._sessionKey = null;
      this._media = null;
      this._tracks = { source: null, a: null, b: null };
      this._indexes = { source: null, a: null, b: null };
      this._settings.enabled = false;
      this._warning = null;
      this._warningCode = null;
      this._fullscreenMode = 'none';
      this._destroyed = true;
      this._notify();
      this._onChange = null;
    }

    _assertAlive() {
      if (this._destroyed) throw new Error('Subtitle controller has been destroyed.');
    }

    _createOverlay() {
      const host = this._document.createElement('div');
      host.id = 'ottspeed-subtitle-overlay';
      host.setAttribute('data-ottspeed-subtitle-overlay', '');
      host.setAttribute('aria-hidden', 'true');
      // Important inline properties protect the host from broad site CSS selectors.
      const hostStyles = {
        all: 'initial', position: 'fixed', display: 'none', margin: '0', padding: '0',
        border: '0', overflow: 'hidden', 'pointer-events': 'none',
        'z-index': '2147483646', 'box-sizing': 'border-box', 'color-scheme': 'normal'
      };
      for (const [property, value] of Object.entries(hostStyles)) host.style.setProperty(property, value, 'important');
      const shadow = host.attachShadow({ mode: 'open' });
      const style = this._document.createElement('style');
      style.textContent = `
        :host { pointer-events: none !important; }
        .lines { position: absolute; left: 4%; right: 4%; display: flex; flex-direction: column;
          align-items: center; gap: 0.2em; margin: 0; padding: 0; text-align: center; }
        .line { max-width: 100%; box-sizing: border-box; margin: 0; padding: 0.16em 0.36em;
          border-radius: 0.14em; background: rgba(0, 0, 0, 0.76); color: #fff;
          font-family: Arial, 'Noto Sans KR', sans-serif; font-weight: 600; line-height: 1.35;
          white-space: pre-wrap; overflow-wrap: anywhere; text-shadow: 0 1px 2px #000;
          unicode-bidi: plaintext; }
        .line[hidden] { display: none; }
        .source.secondary { font-size: 0.8em; color: #e8e8e8; font-weight: 400; }
      `;
      const lines = this._document.createElement('div');
      lines.className = 'lines';
      const target = this._document.createElement('div');
      target.className = 'line target';
      target.setAttribute('data-subtitle-line', 'target');
      const source = this._document.createElement('div');
      source.className = 'line source';
      source.setAttribute('data-subtitle-line', 'source');
      target.hidden = true;
      source.hidden = true;
      lines.append(target, source);
      shadow.append(style, lines);
      this._host = host;
      this._lines = lines;
      this._targetLine = target;
      this._sourceLine = source;
    }

    _detachVideo() {
      if (this._video) {
        for (const event of VIDEO_EVENTS) this._video.removeEventListener(event, this._handleVideoEvent);
      }
      this._resizeObserver?.disconnect();
      this._resizeObserver = null;
    }

    _clearDisplay() {
      this._currentText = '';
      this._sourceText = '';
      this._targetText = '';
      this._targetLine.textContent = '';
      this._sourceLine.textContent = '';
      this._targetLine.hidden = true;
      this._sourceLine.hidden = true;
      this._host.style.setProperty('display', 'none', 'important');
      this._setNativeHidden(false);
    }

    _layout() {
      this._warning = null;
      this._warningCode = null;
      let fullscreen = this._document.fullscreenElement;
      while (fullscreen?.shadowRoot?.fullscreenElement) fullscreen = fullscreen.shadowRoot.fullscreenElement;
      this._fullscreenMode = fullscreen ? 'container' : 'none';
      if (fullscreen?.tagName === 'VIDEO') {
        this._fullscreenMode = 'video';
        this._warningCode = 'VIDEO_FULLSCREEN_UNSUPPORTED';
        this._warning = '영상 요소만 전체화면인 모드에서는 외부 자막을 표시할 수 없습니다. 플레이어 전체화면 또는 일반 화면을 사용하세요.';
        return false;
      }
      if (fullscreen && this._video && !composedContains(fullscreen, this._video)) {
        this._fullscreenMode = 'unrelated';
        this._warningCode = 'VIDEO_OUTSIDE_FULLSCREEN';
        this._warning = '선택한 영상이 현재 전체화면 영역 밖에 있습니다.';
        return false;
      }
      const parent = fullscreen || this._document.documentElement;
      if (parent && this._host.parentNode !== parent) parent.appendChild(this._host);
      const video = this._video;
      if (!video || video.isConnected === false || !parent) return false;
      const rect = video.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      for (const [property, value] of Object.entries({
        left: rect.left, top: rect.top, width: rect.width, height: rect.height
      })) this._host.style.setProperty(property, `${value}px`, 'important');
      this._lines.style.bottom = `${this._settings.bottomPercent}%`;
      // Keep captions usable in a small embedded player without changing the saved size.
      this._lines.style.fontSize = `${Math.max(12, Math.min(this._settings.fontSize, rect.width / 16))}px`;
      return true;
    }

    _render(mediaTime) {
      if (this._destroyed) return;
      const visible = this._layout();
      const enabled = this._settings.enabled && this._sessionKey && this._sessionKey === this._media?.key;
      if (!visible || !enabled || this._waitingForMetadata || this._document.hidden) {
        this._clearDisplay();
        this._notify();
        return;
      }
      const milliseconds = finite(mediaTime, finite(this._video.currentTime, 0)) * 1000;
      const activeText = key => {
        if (!this._indexes[key]) return '';
        const sync = this._tracks[key].sync;
        return cueText(this._core.activeCues(this._indexes[key], milliseconds, {
          offsetMs: this._settings.offsetMs + sync.offsetMs,
          scale: this._settings.scale * sync.scale
        }));
      };
      const source = this._settings.display !== 'target' ? activeText('source') : '';
      const target = this._settings.display !== 'source' ? activeText(this._settings.activeTarget) : '';
      this._sourceText = source;
      this._targetText = target;
      this._currentText = [target, source].filter(Boolean).join('\n');
      if (this._sourceLine.textContent !== source) this._sourceLine.textContent = source;
      if (this._targetLine.textContent !== target) this._targetLine.textContent = target;
      this._sourceLine.hidden = !source;
      this._targetLine.hidden = !target;
      this._sourceLine.className = `line source${this._settings.display === 'bilingual' && target ? ' secondary' : ''}`;
      this._host.style.setProperty('display', this._currentText ? 'block' : 'none', 'important');
      this._setNativeHidden(Boolean(this._currentText && this._settings.hideNative));
      this._notify();
    }

    _scheduleFrame() {
      const video = this._video;
      if (this._destroyed || this._frameId !== null || !video || video.isConnected === false ||
        video.paused || video.ended || this._document.hidden || !this._settings.enabled ||
        this._waitingForMetadata || !this._sessionKey || this._sessionKey !== this._media?.key ||
        !Object.values(this._tracks).some(track => track?.cues.length)) return;
      const generation = this._frameGeneration;
      const callback = (_, metadata) => {
        if (generation !== this._frameGeneration || video !== this._video || this._destroyed) return;
        this._frameId = null;
        this._frameKind = null;
        this._frameVideo = null;
        this._render(metadata?.mediaTime);
        this._scheduleFrame();
      };
      if (!this._failedVideoFrames && typeof video.requestVideoFrameCallback === 'function') {
        try {
          this._frameKind = 'video';
          this._frameVideo = video;
          this._frameId = video.requestVideoFrameCallback(callback);
          return;
        } catch (_) { this._failedVideoFrames = true; }
      }
      this._frameKind = 'animation';
      this._frameVideo = video;
      this._frameId = root.requestAnimationFrame(callback);
    }

    _cancelFrame() {
      this._frameGeneration += 1;
      if (this._frameId !== null) {
        try {
          if (this._frameKind === 'video') this._frameVideo?.cancelVideoFrameCallback?.(this._frameId);
          else root.cancelAnimationFrame(this._frameId);
        } catch (_) { /* generation guard also invalidates an uncancellable callback */ }
      }
      this._frameId = null;
      this._frameKind = null;
      this._frameVideo = null;
    }

    _setNativeHidden(hidden) {
      const selector = NATIVE_SELECTORS[this._media?.platform];
      if (!hidden || !selector || !this._video) {
        this._nativeStyle?.remove();
        this._nativeScope?.removeAttribute(this._nativeAttribute);
        this._nativeStyle = null;
        this._nativeScope = null;
        return;
      }
      // Scope the owned stylesheet to the selected player, preserving all page inline styles.
      let scope = this._video.closest?.('.html5-video-player, .watch-video, .nf-player-container');
      if (!scope) {
        scope = this._video.parentElement;
        for (let ancestor = scope; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.querySelector(selector)) { scope = ancestor; break; }
        }
      }
      if (!scope) return;
      if (scope === this._nativeScope && this._nativeStyle?.isConnected) return;
      this._setNativeHidden(false);
      const style = this._document.createElement('style');
      style.setAttribute('data-ottspeed-native-caption-style', '');
      style.textContent = `[${this._nativeAttribute}] ${selector} { visibility: hidden !important; opacity: 0 !important; }`;
      scope.setAttribute(this._nativeAttribute, '');
      // Attach in the video's tree so a custom player's shadow root is also supported.
      const tree = scope.getRootNode();
      const styleParent = tree === this._document ? (this._document.head || this._document.documentElement) : tree;
      styleParent.appendChild(style);
      this._nativeScope = scope;
      this._nativeStyle = style;
    }

    _notify() {
      if (!this._onChange) return;
      const state = this.getState();
      // Poll getState() for playback time; notifications are for changes, not every frame.
      const { currentTime, ...stable } = state;
      const signature = JSON.stringify(stable);
      if (signature === this._lastStateSignature) return;
      this._lastStateSignature = signature;
      try { this._onChange(state); } catch (_) { /* observers must not interrupt playback */ }
    }
  }

  root.OTTSubtitleController = OTTSubtitleController;
})(globalThis);
