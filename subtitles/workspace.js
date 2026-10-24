/* Local workspace; only explicit bridge jobs are shared with connected ChatGPT. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const core = OTTSubtitles;
  const library = OTTSubtitleLibrary;
  const tabParameter = new URLSearchParams(location.search).get('tabId');
  const tabId = tabParameter && /^\d+$/.test(tabParameter) ? Number(tabParameter) : null;
  const MAX_BYTES = 5 * 1024 * 1024;
  const readyTime = ms => `${String(Math.floor(ms / 60000)).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}`;
  let session = null;
  let latest = null;
  let busy = false;
  let refreshing = false;
  let refreshFinished = Promise.resolve();
  let pendingApplyKey = null;
  let netflixCapture = null;
  let bridgeToken = null;
  let bridgePolling = false;

  function emptySession(media) {
    return {
      mediaKey: media.key, media: { ...media }, tracks: { source: null, a: null, b: null },
      settings: { enabled: true, display: 'target', activeTarget: 'a', offsetMs: 0, scale: 1, fontSize: 28, bottomPercent: 10, hideNative: false },
      pendingRequest: null, revision: 0
    };
  }
  function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }

  async function ask(action, extra = {}, timeoutMs = 8000) {
    if (!Number.isSafeInteger(tabId)) throw new Error('영상을 연 탭에서 OTTSpeed 아이콘 → 자막·번역 작업실을 눌러주세요.');
    let timer;
    try {
      const result = await Promise.race([
        chrome.tabs.sendMessage(tabId, { action, ...extra }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('영상 탭이 응답하지 않습니다. 탭을 새로고침한 후 다시 연결하세요.')), timeoutMs); })
      ]);
      if (!result || result.error) throw new Error(result?.error || '영상에 연결하지 못했습니다.');
      return result;
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection|No tab with id/.test(error.message)) {
        throw new Error('영상 탭을 찾거나 연결하지 못했습니다. 확장을 새로 불러왔다면 영상 탭도 새로고침하세요.');
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  function renderAvailability() {
    const available = Boolean(latest?.hasVideo && session && latest.media?.key === session.mediaKey);
    for (const control of document.querySelectorAll('main input, main select, main button')) {
      if (['refresh', 'focus-video'].includes(control.id)) continue;
      control.disabled = busy || !available;
    }
    $('response-file').disabled = busy || !available || !session?.pendingRequest;
    $('native-capture').disabled = busy || !available || !$('native-track').value;
    $('export-request').disabled = busy || !available || !session?.tracks.source;
    $('export-vtt').disabled = $('export-srt').disabled = busy || !session?.tracks[session.settings.activeTarget];
    $('netflix-list').disabled = busy || !available || latest?.media?.platform !== 'netflix';
    $('netflix-capture').disabled = busy || !available || !$('netflix-track').value;
    $('netflix-export').disabled = busy || !netflixCapture || netflixCapture.mediaKey !== session?.mediaKey;
    $('bridge-connect').disabled = busy || !available;
    $('bridge-create').disabled = busy || !available || !bridgeToken || session?.tracks.source?.provenance !== 'netflix-manifest-resource';
    $('bridge-check').disabled = busy || !bridgeToken;
  }

  function renderSession() {
    if (!session) { renderAvailability(); return; }
    for (const key of ['source', 'a', 'b']) {
      const track = session.tracks[key];
      $(key + '-info').textContent = track ? `${track.name} · ${track.cues.length.toLocaleString()}개 자막${track.coverage === 'available-cues' ? ' · 현재 공개된 구간만' : ''}${track.partial ? ` · 번역 중 · ${readyTime(track.readyThroughMs)}까지 시청 가능` : ''}` : (key === 'source' ? '원문 파일을 선택하세요' : key === 'a' ? '기준으로 비교할 자막' : '번역 결과 또는 다른 자막');
    }
    const settings = session.settings;
    $('enabled').checked = settings.enabled;
    $('display').value = settings.display;
    $('active-target').value = settings.activeTarget;
    $('offset').value = settings.offsetMs / 1000;
    $('font-size').value = settings.fontSize;
    $('bottom').value = settings.bottomPercent;
    $('scale').value = Number((settings.scale * 100).toFixed(3));
    $('hide-native').checked = settings.hideNative;
    $('request-status').textContent = session.pendingRequest ? `대기 중: ${session.pendingRequest.requestId} · ${session.pendingRequest.slots.length.toLocaleString()}개 자막` : '아직 내보낸 요청이 없습니다.';
    renderTrackSync();
    renderAvailability();
  }

  function renderTrackSync() {
    const sync = session?.tracks[$('sync-track').value]?.sync;
    $('track-offset').value = (sync?.offsetMs || 0) / 1000;
    $('track-scale').value = Number(((sync?.scale || 1) * 100).toFixed(3));
  }

  function renderStatus() {
    const connected = Boolean(latest?.hasVideo);
    $('connection-dot').classList.toggle('connected', connected);
    $('video-heading').textContent = latest?.media ? `${latest.media.platform === 'netflix' ? 'Netflix' : latest.media.platform === 'youtube' ? 'YouTube' : '현재 영상'}${latest.media.videoId ? ` · ${latest.media.videoId}` : ''}${connected ? '' : ' · 비디오를 찾는 중'}` : '영상에 연결하지 못했습니다';
    $('media-detail').textContent = latest?.media?.url || '영상 페이지를 열고 확장 프로그램 아이콘에서 작업실을 다시 열어주세요.';
    const speed = Number(latest?.currentSpeed);
    if (Number.isFinite(speed) && document.activeElement !== $('speed')) {
      let option = [...$('speed').options].find(item => Number(item.value) === speed);
      if (!option) { option = document.createElement('option'); option.value = speed; option.textContent = `${speed}×`; $('speed').appendChild(option); }
      $('speed').value = String(speed);
    }
    const view = latest?.subtitles;
    const seconds = Math.floor(view?.currentTime || 0);
    $('playhead').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('preview-target').textContent = view?.targetText || (view?.settings?.display === 'source' ? '' : '현재 시점에 표시할 한글 자막이 없습니다.');
    $('preview-source').textContent = view?.sourceText || '';
    $('capability-warning').hidden = !view?.warning;
    $('capability-warning').textContent = view?.warning || '';
    renderAvailability();
  }

  async function refresh() {
    if (busy || refreshing) return;
    refreshing = true;
    let finish;
    refreshFinished = new Promise(resolve => { finish = resolve; });
    try {
      const current = await ask('subtitleState');
      latest = current;
      if (!current.media?.key) throw new Error('현재 영상의 식별자를 읽지 못했습니다.');
      if (session?.mediaKey !== current.media.key) {
        const previous = session?.mediaKey;
        const saved = await library.get(current.media.key);
        const verify = await ask('subtitleState');
        if (verify.media?.key !== current.media.key) { session = null; latest = verify; return; }
        session = saved || emptySession(current.media);
        netflixCapture = session.netflixCapture || null;
        $('netflix-track').replaceChildren(new Option('트랙을 확인하세요', ''));
        session.media = { ...current.media };
        renderSession();
        pendingApplyKey = session.mediaKey;
        latest = await ask('loadSubtitleSession', { session: displaySession(session) });
        pendingApplyKey = null;
        $('native-track').replaceChildren(new Option('트랙을 확인하세요', ''));
        renderSession();
        if (previous) notice(saved ? '영상이 바뀌어 이 영상에 저장한 자막을 불러왔습니다.' : '영상이 바뀌었습니다. 새 회차에 맞는 자막 파일을 선택하세요.');
        else if (saved) notice('이 영상에 저장한 자막과 표시 설정을 불러왔습니다.');
      } else if (pendingApplyKey === session.mediaKey) {
        latest = await ask('loadSubtitleSession', { session: displaySession(session) });
        pendingApplyKey = null;
        renderSession();
      }
      renderStatus();
    } catch (error) { latest = null; notice(error.message, true); renderStatus(); }
    finally { refreshing = false; finish(); renderAvailability(); }
  }

  function displaySession(value) { return { mediaKey: value.mediaKey, tracks: value.tracks, settings: value.settings }; }

  async function ensureCurrent(key) {
    const result = await ask('subtitleState');
    if (!result.hasVideo || result.media?.key !== key || session?.mediaKey !== key) {
      throw new Error('작업 중 영상이 바뀌었거나 비디오가 사라졌습니다. 현재 영상에 연결한 뒤 다시 시도하세요.');
    }
    return result;
  }

  async function saveAndApply(candidate) {
    await ensureCurrent(candidate.mediaKey);
    const committed = await library.put(candidate);
    // IndexedDB is now authoritative even if the tab closes during delivery.
    session = committed;
    pendingApplyKey = committed.mediaKey;
    renderSession();
    // The content script validates the media key again after the durable write.
    try { latest = await ask('loadSubtitleSession', { session: displaySession(committed) }); pendingApplyKey = null; }
    catch (error) { throw new Error(`자막과 설정은 저장했지만 영상 적용에 실패했습니다. ${error.message}`); }
    renderSession(); renderStatus();
  }

  async function run(task) {
    if (busy) { notice('앞선 작업을 처리하고 있습니다. 잠시 후 다시 시도하세요.', true); return; }
    const intendedMediaKey = session?.mediaKey;
    busy = true; renderAvailability();
    try {
      // File-picker events may arrive during a polling request. Do not drop them.
      await refreshFinished;
      if (!session) throw new Error('먼저 영상에 연결하세요.');
      if (intendedMediaKey && intendedMediaKey !== session.mediaKey) throw new Error('작업을 선택한 뒤 영상이 바뀌었습니다. 현재 영상에 맞는 파일을 다시 선택하세요.');
      await task(session.mediaKey);
    } catch (error) {
      if (error.name === 'ConflictError' && session) {
        try {
          const stored = await library.get(session.mediaKey);
          session = stored || emptySession(session.media); pendingApplyKey = session.mediaKey; renderSession();
        } catch { /* Keep the original conflict message; never overwrite unknown data. */ }
      }
      notice(error.name === 'QuotaExceededError' ? '브라우저 저장 공간이 부족합니다. 필요 없는 영상의 자막을 지운 후 다시 시도하세요.' : error.message, true);
    }
    finally { busy = false; renderAvailability(); void refresh(); }
  }

  async function readFile(file) {
    if (!file) throw new Error('파일을 선택하세요.');
    if (file.size > MAX_BYTES) throw new Error('파일은 5 MB 이하여야 합니다.');
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { return new TextDecoder('euc-kr', { fatal: true }).decode(buffer); }
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function safeName(name) { return String(name || 'subtitles').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 100) || 'subtitles'; }

  const bridgeHttp=OTTDeckBridgeHttp({timeoutMs:8000,offlineMessage:'로컬 번역 브리지에 연결하지 못했습니다. PC에서 브리지를 실행한 뒤 다시 연결하세요.'});
  async function bridgeAsk(path,body,pair=false) { return bridgeHttp(path,{body,token:pair?null:bridgeToken}); }
  function showBridgeJob(job) {
    const progress = job.readyCueCount ? `${readyTime(job.readyThroughMs)}까지 시청 가능 · ${job.readyCueCount.toLocaleString()}/${job.cueCount.toLocaleString()}개 번역` : '첫 분할 번역 대기';
    $('bridge-status').textContent = `${job.episode || job.mediaKey} · ${job.savedChunkCount}/${job.chunkCount}개 분할 저장 · ${job.status === 'complete' ? '전편 번역 확정' : progress} · 작업 ${job.jobId}`;
    $('bridge-prompt').textContent = `OTTSpeed 자막 번역 앱으로 작업 ${job.jobId} (${job.episode || job.mediaKey})을 한국어로 번역해줘. get_translation_job을 읽고 모든 read_subtitle_chunk로 전편 문맥을 먼저 확인해줘. 사전 맥락은 시즌 1과 S02E01~02까지만 사용해줘. chunk-001부터 앞에서부터 순서대로 번역하고, 각 분할이 완성되면 outputIds의 id·text만 save_translation_chunk에 바로 저장해줘. 사용자가 첫 분할부터 시청하므로 끝에 한꺼번에 저장하지 마. 모든 분할을 끝낸 뒤 finalize_translation으로 확정해줘. ID와 시각을 유지하고, 원문에 없는 설명·뒤에서 밝혀지는 사실을 앞에 추가하지 마. 파일로 반환하지 말고 MCP 도구로 저장해줘.`;
  }
  async function validateBridgeJob(detail) {
    const request = detail.request;
    if(detail.jobId !== request.requestId || request.mode !== 'translate' || request.reference !== null || detail.mediaKey !== request.mediaKey || detail.media.key !== request.mediaKey || detail.sourceTrack.capture?.mediaKey !== request.mediaKey || !detail.sourceTrack.capture?.fullEpisode) throw new Error('브리지 작업의 영상·원문 계약이 일치하지 않습니다.');
    const fresh = await core.makeTranslationRequest({media:detail.media,source:detail.sourceTrack,reference:null,mode:'translate'});
    if(fresh.sourceHash !== request.sourceHash || JSON.stringify(fresh.slots) !== JSON.stringify(request.slots)) throw new Error('브리지 원문 스냅샷이 변경됐습니다.');
  }
  async function adoptBridgeJob(detail) {
    await validateBridgeJob(detail);
    await ensureCurrent(detail.mediaKey);
    const candidate = structuredClone(session);
    candidate.tracks.source = structuredClone(detail.sourceTrack);
    candidate.tracks.source.sync = {offsetMs:0,scale:1};
    candidate.pendingRequest = detail.request; candidate.pendingTiming = {offsetMs:0,scale:1};
    candidate.bridge = {jobId:detail.jobId,sourceHash:detail.sourceHash,resourceSha256:detail.capture.resourceSha256};
    candidate.settings.offsetMs = 0; candidate.settings.scale = 1;
    await saveAndApply(candidate);
  }
  async function receiveBridgeResult(detail, isLatest) {
    await validateBridgeJob(detail);
    const original = await library.get(detail.mediaKey) || emptySession(detail.media);
    const partial = detail.status !== 'complete';
    if(original.bridgeResults?.[detail.jobId] && (partial || original.bridgeResults[detail.jobId].resultHash === detail.resultHash)) return;
    const previous = original.bridgeProgress?.[detail.jobId];
    if(partial && previous && previous.revision > detail.progress?.revision) return;
    if(partial && previous?.progressHash === detail.progressHash) return;
    if(partial && previous && previous.revision === detail.progress?.revision) throw new Error('같은 번역 진행 버전의 내용이 달라졌습니다.');
    const validated = partial ? core.validateTranslationProgress(detail.progress,detail.request) : core.validateTranslationResponse(detail.response,detail.request);
    if(partial && previous?.track.cues.length > validated.cues.length) throw new Error('이미 시청 가능한 번역 범위가 줄어들었습니다.');
    const {cues} = validated;
    const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(partial ? detail.progress : detail.response)));
    if(Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('') !== (partial ? detail.progressHash : detail.resultHash)) throw new Error('브리지 결과 해시가 일치하지 않습니다.');
    const track = {name:`Netflix_${detail.media.videoId}.ko.B${partial ? '.partial' : ''}.vtt`,language:'ko',format:'vtt',cues,requestId:detail.jobId,provenance:partial ? 'chatgpt-mcp-partial' : 'chatgpt-mcp',partial,
      totalCueCount:detail.request.slots.length,readyThroughMs:partial ? validated.readyThroughMs : detail.capture.endMs,timingVerified:false,sync:{offsetMs:0,scale:1}};
    const candidate = structuredClone(original);
    if(partial) {
      candidate.bridgeProgress ||= {};
      candidate.bridgeProgress[detail.jobId] = {progressHash:detail.progressHash,revision:detail.progress.revision,receivedAt:new Date().toISOString(),track};
    } else {
      candidate.bridgeResults ||= {};
      candidate.bridgeResults[detail.jobId] = {resultHash:detail.resultHash,receivedAt:new Date().toISOString(),track};
      if(candidate.bridgeProgress) delete candidate.bridgeProgress[detail.jobId];
    }
    const sameSource = !candidate.tracks.source || candidate.tracks.source.capture?.resourceSha256 === detail.capture.resourceSha256;
    const selected = isLatest && sameSource && !candidate.bridge?.suspended && (!candidate.bridge || candidate.bridge.jobId === detail.jobId);
    if(selected) {
      const continuing = candidate.tracks.b?.requestId === detail.jobId;
      candidate.tracks.source = structuredClone(detail.sourceTrack); candidate.tracks.source.sync = {offsetMs:0,scale:1};
      candidate.tracks.b = track; candidate.pendingRequest = detail.request;candidate.pendingTiming = {offsetMs:0,scale:1};
      candidate.bridge = {jobId:detail.jobId,sourceHash:detail.sourceHash,resourceSha256:detail.capture.resourceSha256};
      if(!continuing) Object.assign(candidate.settings,{enabled:true,activeTarget:'b',offsetMs:0,scale:1,hideNative:true,display:candidate.settings.display === 'bilingual' ? 'bilingual' : 'target'});
    }
    // Durable write belongs to the original episode even while a different video is playing.
    const committed = await library.put(candidate);
    if(session?.mediaKey === committed.mediaKey) {
      session = committed;renderSession();
      if(selected) {
        pendingApplyKey = committed.mediaKey;
        try {await ensureCurrent(committed.mediaKey);latest = await ask('loadSubtitleSession',{session:displaySession(committed)});pendingApplyKey=null;renderStatus();}
        catch {notice('번역은 원래 회차에 저장했습니다. 해당 회차로 돌아오면 B를 불러옵니다.');}
      }
    }
  }
  async function pollBridge(adopt = false) {
    const {jobs} = await bridgeAsk('/extension/jobs');
    const newest = new Map();for(const job of jobs) if(!newest.has(job.mediaKey)) newest.set(job.mediaKey,job.jobId);
    const current = jobs.find(j=>j.mediaKey === session?.mediaKey);
    if(current) {
      showBridgeJob(current);
      const matches = session.tracks.source?.capture?.resourceSha256 === current.capture.resourceSha256;
      if((adopt || matches) && (session.bridge?.jobId !== current.jobId || (adopt && session.bridge?.suspended))) await adoptBridgeJob(await bridgeAsk(`/extension/jobs/${current.jobId}`));
    } else {$('bridge-status').textContent='브리지에 연결했습니다. 현재 Netflix 원문으로 번역을 준비하세요.';}
    for(const job of jobs.filter(j=>j.status === 'complete' || j.progressHash)) {
      const saved = await library.get(job.mediaKey);
      if(saved?.bridgeResults?.[job.jobId] && (job.status !== 'complete' || saved.bridgeResults[job.jobId].resultHash === job.resultHash)) continue;
      if(job.status !== 'complete' && saved?.bridgeProgress?.[job.jobId]?.progressHash === job.progressHash) continue;
      await receiveBridgeResult(await bridgeAsk(`/extension/jobs/${job.jobId}`),newest.get(job.mediaKey) === job.jobId);
    }
  }
  $('bridge-connect').addEventListener('click',()=>void run(async()=> {
    $('bridge-status').textContent = '로컬 번역 브리지에 연결하는 중…';
    try {
      const runtime=await chrome.runtime.sendMessage({action:'ensureLocalRuntime'});
      if(!runtime?.ready)throw new Error(runtime?.error||'로컬 번역 연결을 시작하지 못했습니다.');
      const paired = await bridgeAsk('/extension/pair',{client:'OTTSpeed'},true);
      bridgeToken = paired.token;
      await chrome.storage.local.set({ottspeedBridge:{token:bridgeToken}});
      await pollBridge(true);
    } catch(error) {
      $('bridge-status').textContent = `브리지 연결 실패: ${error.message}`;
      throw error;
    }
  }));
  $('bridge-create').addEventListener('click',()=>void run(async mediaKey=> {
    await ensureCurrent(mediaKey);
    const job = await bridgeAsk('/extension/jobs',{media:session.media,source:session.tracks.source});
    await adoptBridgeJob(await bridgeAsk(`/extension/jobs/${job.jobId}`));
    showBridgeJob(job);await pollBridge();
    notice('Netflix 원문 번역 작업을 준비했습니다. 연결한 일반 ChatGPT에 위 요청문을 보내세요.');
  }));
  $('bridge-chatgpt').addEventListener('click',async()=> {
    try {
      if(!session?.bridge) throw new Error('먼저 현재 회차의 번역 작업을 준비하세요.');
      await navigator.clipboard.writeText($('bridge-prompt').textContent);
      await chrome.tabs.create({url:'https://chatgpt.com/'});
      notice('시작 요청을 복사했습니다. 일반 ChatGPT에서 OTTSpeed 자막 번역 앱을 선택하고 붙여넣어 한 번 보내세요. 이 작업실은 열어 두세요.');
    } catch(error) {notice(error.message,true);}
  });
  async function preparePopupTranslation(mediaKey) {
    if(session.media.platform !== 'netflix') throw new Error('Netflix 회차에서 번역을 시작하세요.');
    $('bridge-status').textContent='Netflix 영어 전편과 번역 작업을 준비하는 중…';
    const paired=await bridgeAsk('/extension/pair',{client:'OTTSpeed'},true);
    bridgeToken=paired.token;await chrome.storage.local.set({ottspeedBridge:{token:bridgeToken}});
    if(session.tracks.source?.provenance !== 'netflix-manifest-resource' || !session.tracks.source.capture?.fullEpisode) {
      const listing=await ask('listNetflixTracks',{mediaKey},28000);
      await ensureCurrent(mediaKey);
      const track=listing.tracks?.find(t=>t.rawTrackType==='closedcaptions') || listing.tracks?.[0];
      if(!track) throw new Error('Netflix 영어 트랙이 아직 없습니다. 영어 자막을 선택하고 이 영상 탭을 새로고침한 뒤 다시 번역을 시작하세요.');
      await acceptNetflixCapture(await ask('captureNetflixTrack',{mediaKey,trackId:track.id},28000),mediaKey);
    }
    await ensureCurrent(mediaKey);
    const job=await bridgeAsk('/extension/jobs',{media:session.media,source:session.tracks.source});
    await adoptBridgeJob(await bridgeAsk(`/extension/jobs/${job.jobId}`));
    showBridgeJob(job);await pollBridge();
    notice(job.status==='complete' ? '저장된 전편 번역을 불러왔습니다. 팝업에서 처음부터 B로 재생하세요.' : '번역 작업을 준비했습니다. ‘시작 요청 복사하고 ChatGPT 열기’를 눌러 한 번 요청하세요. 첫 구간이 도착하면 팝업에서 처음부터 재생할 수 있습니다.');
  }
  $('bridge-check').addEventListener('click',()=>void run(async()=> {
    try {await pollBridge();}
    catch(error) {$('bridge-status').textContent=`결과 확인 실패: ${error.message}`;throw error;}
  }));
  async function automaticBridgePoll() {
    // run() already waits for refreshFinished. Skipping while refreshing would
    // starve this 3-second timer behind the earlier 1-second refresh timer.
    if(!bridgeToken || busy || bridgePolling || !session) return;
    bridgePolling = true;
    try {await run(()=>pollBridge());}
    finally {bridgePolling = false;}
  }

  for (const key of ['source', 'a', 'b']) {
    $(key + '-file').addEventListener('change', event => {
      const file = event.target.files[0]; event.target.value = '';
      if (!file) return;
      void run(async mediaKey => {
        const parsed = core.parse(await readFile(file), file.name);
        await ensureCurrent(mediaKey);
        const candidate = structuredClone(session);
        candidate.tracks[key] = { name: file.name, language: key === 'source' ? 'en' : 'ko', format: parsed.format, cues: parsed.cues, timingVerified: false, sync: { offsetMs: 0, scale: 1 } };
        // File replacement invalidates the contract of any outstanding request.
        candidate.pendingRequest = null;
        if(key === 'b' && candidate.bridge) candidate.bridge.suspended = true;
        if (key !== 'source') candidate.settings.activeTarget = key;
        await saveAndApply(candidate);
        notice(`${file.name}: ${parsed.cues.length.toLocaleString()}개 자막을 불러왔습니다.${parsed.warnings.length ? ' ' + parsed.warnings.map(item => typeof item === 'string' ? item : item.message || JSON.stringify(item)).join(' ') : ''}`);
      });
    });
  }

  function settingsFromForm() {
    const number = (id, low, high) => {
      const raw = $(id).value.trim(); const value = Number(raw);
      if (!raw || !Number.isFinite(value) || value < low || value > high) throw new Error(`${$(id).closest('label')?.firstChild?.textContent?.trim() || id}: ${low}~${high} 사이의 숫자를 입력하세요.`);
      return value;
    };
    return {
      enabled: $('enabled').checked, display: $('display').value, activeTarget: $('active-target').value,
      offsetMs: Math.round(number('offset', -3600, 3600) * 1000), scale: number('scale', 50, 200) / 100,
      fontSize: number('font-size', 12, 72), bottomPercent: number('bottom', 0, 80), hideNative: $('hide-native').checked
    };
  }
  function changeSettings() {
    void run(async () => {
      const candidate = structuredClone(session); candidate.settings = settingsFromForm();
      await saveAndApply(candidate);
      notice('표시 설정을 저장했습니다. 시간 보정은 A·B·영문에 함께 적용됩니다.');
    });
  }
  for (const id of ['enabled', 'display', 'active-target', 'offset', 'scale', 'font-size', 'bottom', 'hide-native']) $(id).addEventListener('change', changeSettings);
  for (const [id, delta] of [['offset-minus', -0.25], ['offset-plus', 0.25], ['offset-reset', null]]) {
    $(id).addEventListener('click', () => { $('offset').value = delta === null ? 0 : Number((Number($('offset').value) + delta).toFixed(3)); changeSettings(); });
  }
  $('sync-track').addEventListener('change', renderTrackSync);
  $('save-track-sync').addEventListener('click', () => void run(async () => {
    const key = $('sync-track').value;
    if (!session.tracks[key]) throw new Error('보정할 트랙의 자막 파일을 먼저 불러오세요.');
    const offset = Number($('track-offset').value);
    const scale = Number($('track-scale').value) / 100;
    if (!$('track-offset').value.trim() || !Number.isFinite(offset) || offset < -3600 || offset > 3600 || !Number.isFinite(scale) || scale < 0.5 || scale > 2) throw new Error('트랙 보정은 −3600~3600초, 배율은 50~200%로 입력하세요.');
    const candidate = structuredClone(session);
    candidate.tracks[key].sync = { offsetMs: Math.round(offset * 1000), scale };
    await saveAndApply(candidate);
    notice(`${key === 'source' ? '영문 원문' : key.toUpperCase()}의 추가 시간 보정을 저장했습니다.`);
  }));
  $('speed').addEventListener('change', () => void run(async () => { latest = await ask('setSpeed', { speed: Number($('speed').value) }); renderStatus(); }));

  $('native-list').addEventListener('click', () => void run(async mediaKey => {
    const { tracks } = await ask('listNativeTracks'); await ensureCurrent(mediaKey);
    $('native-track').replaceChildren(new Option(tracks.length ? '영문 트랙을 선택하세요' : '공개된 자막 트랙이 없습니다', ''));
    for (const track of tracks) $('native-track').appendChild(new Option(`${track.label || track.language || '트랙'} · ${track.cueCount}개`, String(track.index)));
    notice(tracks.length ? '영문 트랙인지 확인한 후 가져오세요. 현재 공개된 구간만 포함될 수 있습니다.' : '이 플레이어가 HTML TextTrack 자막을 공개하지 않았습니다. 보유한 SRT/VTT 파일을 사용하세요.');
  }));
  $('native-track').addEventListener('change', renderAvailability);
  $('netflix-list').addEventListener('click', () => void run(async mediaKey => {
    const result = await ask('listNetflixTracks', { mediaKey }, 28000);
    await ensureCurrent(mediaKey);
    $('netflix-track').replaceChildren(new Option(result.tracks.length ? '영어 트랙을 선택하세요' : '영어 파일 트랙 없음', ''));
    for (const track of result.tracks) $('netflix-track').appendChild(new Option(`${track.label} · ${track.language} · ${track.profile} · ${track.id}`, track.id));
    if (result.tracks.length === 1) $('netflix-track').value = result.tracks[0].id;
    $('netflix-status').textContent = `${result.tracks.length}개 영어 트랙 · Netflix ${result.videoId} · 자막 파일 수집 전${result.tracks.length ? '' : ` · 수집기 ${JSON.stringify(result.diagnostic || {})}`}`;
    if (!result.tracks.length) {
      download(`OTTSpeed_Netflix_${result.videoId}.diagnostic.json`,JSON.stringify({kind:'ottspeed.netflix-diagnostic',videoId:result.videoId,diagnostic:result.diagnostic},null,2),'application/json;charset=utf-8');
      notice('영어 자막 파일을 아직 찾지 못했습니다. URL·토큰·대사 본문을 제외한 구조 진단 파일을 저장했습니다.',true);
    } else notice('현재 회차의 영어 파일 트랙을 확인했습니다. 수집 후 전편 여부와 파싱 수를 검사합니다.');
  }));
  $('netflix-track').addEventListener('change', renderAvailability);
  async function acceptNetflixCapture(result,mediaKey) {
    await ensureCurrent(mediaKey);
    if (result.track?.capture?.mediaKey !== mediaKey) throw new Error('다른 회차의 수집 결과입니다.');
    const candidate = structuredClone(session);
    // Preserve A/B; this source snapshot never inherits external subtitle correction.
    candidate.tracks.source = result.track;
    candidate.pendingRequest = null;
    candidate.settings.offsetMs = 0; candidate.settings.scale = 1;
    candidate.netflixCapture={kind:'ottspeed.netflix-capture',schemaVersion:1,mediaKey,media:session.media,track:result.track,rawText:result.rawText};
    await saveAndApply(candidate);
    netflixCapture = {kind:'ottspeed.netflix-capture',schemaVersion:1,mediaKey,media:session.media,track:result.track,rawText:result.rawText};
    const c = result.track.capture;
    $('netflix-status').textContent = `${c.coverage === 'complete' ? '전편 파일 확보' : '일부 / 전편 미확인'} · ${c.cueCount}개 · ${c.startMs}~${c.endMs}ms · 입력 ${c.audit.inputCount} / 수용 ${c.audit.acceptedCount} / 제외 ${c.audit.excludedCount}`;
    notice('Netflix 영어 원본과 수집 근거를 저장했습니다. 검사 기록을 내려받아 전편 여부를 독립 확인할 수 있습니다.');
  }
  $('netflix-capture').addEventListener('click', () => void run(async mediaKey => {
    await acceptNetflixCapture(await ask('captureNetflixTrack', {mediaKey, trackId:$('netflix-track').value}, 28000),mediaKey);
  }));
  $('netflix-export').addEventListener('click', () => {
    if(netflixCapture?.mediaKey !== session?.mediaKey) return;
    download(`OTTSpeed_Netflix_${session.media.videoId}.capture.json`,JSON.stringify(netflixCapture,null,2),'application/json;charset=utf-8');
  });
  $('native-capture').addEventListener('click', () => void run(async mediaKey => {
    if (!$('native-track').value) throw new Error('영문 트랙을 선택하세요.');
    const result = await ask('captureNativeTrack', { index: Number($('native-track').value), mediaKey });
    await ensureCurrent(mediaKey);
    if (result.mediaKey !== mediaKey) throw new Error('자막을 가져오는 동안 영상이 바뀌었습니다.');
    const candidate = structuredClone(session);
    candidate.tracks.source = result.track; candidate.pendingRequest = null;
    await saveAndApply(candidate);
    notice(`${result.track.cues.length.toLocaleString()}개 자막을 가져왔습니다. 전체 회차가 아닌 현재 공개된 구간일 수 있습니다.`);
  }));

  $('export-request').addEventListener('click', () => void run(async mediaKey => {
    if (!session.tracks.source) throw new Error('영문 원문을 먼저 불러오세요.');
    const mode = $('translation-mode').value;
    const reference = mode === 'edit' ? session.tracks[session.settings.activeTarget] : session.tracks.a;
    if (mode === 'edit' && !reference) throw new Error('교정할 한글 A 또는 B를 먼저 선택하세요.');
    const request = await core.makeTranslationRequest({ media: session.media, source: session.tracks.source, reference, mode });
    await ensureCurrent(mediaKey);
    const candidate = structuredClone(session); candidate.pendingRequest = request;
    const timingTrack = mode === 'edit' ? reference : session.tracks.source;
    candidate.pendingTiming = structuredClone(timingTrack.sync || { offsetMs: 0, scale: 1 });
    await saveAndApply(candidate);
    download(`OTTSpeed_${mode}_${safeName(session.tracks.source.name)}.request.json`, JSON.stringify(request, null, 2), 'application/json;charset=utf-8');
    notice('번역 요청 JSON을 저장했습니다. ChatGPT에 파일과 아래 안내를 전달한 뒤 응답 JSON을 가져오세요.');
  }));

  $('response-file').addEventListener('change', event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    void run(async mediaKey => {
      if (!session.pendingRequest) throw new Error('먼저 이 영상의 번역 요청을 내보내세요.');
      let response;
      try { response = JSON.parse(await readFile(file)); } catch { throw new Error('올바른 JSON 파일이 아닙니다. Markdown 코드 블록이 아닌 응답 JSON 파일을 가져오세요.'); }
      const { cues } = core.validateTranslationResponse(response, session.pendingRequest);
      await ensureCurrent(mediaKey);
      const candidate = structuredClone(session);
      candidate.tracks.b = { name: file.name.replace(/\.json$/i, '') + '.ko.vtt', language: 'ko', format: 'vtt', cues, timingVerified: false, requestId: session.pendingRequest.requestId, sync: structuredClone(session.pendingTiming || { offsetMs: 0, scale: 1 }) };
      candidate.settings.activeTarget = 'b';
      await saveAndApply(candidate);
      notice(`${cues.length.toLocaleString()}개 자막을 검증해 B에 적용했습니다. A와 전환하며 번역과 화면 타이밍을 확인하세요.`);
    });
  });

  for (const format of ['vtt', 'srt']) $('export-' + format).addEventListener('click', () => void run(async () => {
    const track = session.tracks[session.settings.activeTarget];
    if (!track) throw new Error('저장할 한글 자막을 선택하세요.');
    const text = format === 'vtt' ? core.serializeVtt(track.cues) : core.serializeSrt(track.cues);
    download(`${safeName(track.name)}.${format}`, text, format === 'vtt' ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8');
    notice('자막 파일을 저장했습니다. 파일의 타임코드는 원본 그대로이며, 화면의 시간 보정 설정은 포함하지 않습니다.');
  }));

  $('clear-session').addEventListener('click', () => void run(async mediaKey => {
    if (!confirm('이 영상에 저장한 A·B·영문 자막과 번역 요청을 지울까요? 원본 파일은 지워지지 않습니다.')) return;
    await ensureCurrent(mediaKey);
    const cleared = emptySession(session.media);
    await library.remove(mediaKey, session.revision || 0);
    session = cleared; pendingApplyKey = mediaKey; renderSession();
    latest = await ask('loadSubtitleSession', { session: displaySession(cleared) });
    pendingApplyKey = null;
    renderSession(); renderStatus(); notice('이 영상에 저장한 자막과 설정을 지웠습니다.');
  }));
  $('refresh').addEventListener('click', () => void refresh());
  $('focus-video').addEventListener('click', async () => {
    try { const tab = await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
    catch { notice('영상 탭이 닫혔습니다. 다시 영상을 열고 작업실을 실행하세요.', true); }
  });
  renderAvailability();
  void (async()=>{
    await refresh();
    if(chrome.storage?.local) try {const value=await chrome.storage.local.get('ottspeedBridge');bridgeToken=value.ottspeedBridge?.token || null;} catch {}
    renderAvailability();
    if(new URLSearchParams(location.search).get('action')==='translate') await run(preparePopupTranslation);
  })();
  setInterval(() => void refresh(), 1000);
  setInterval(()=>void automaticBridgePoll(),3000);
})();
