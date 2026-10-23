/* OTTSpeed MV3 worker. Durable subtitle data lives in IndexedDB, not this Map. */
importScripts('../subtitles/library.js');
const tabStates = new Map();

function updateTabState(tabId, hasVideo, isPlaying) {
  tabStates.set(tabId, { hasVideo, isPlaying });
  const suffix = hasVideo && isPlaying ? '' : '-inactive';
  chrome.action.setIcon({ tabId, path: Object.fromEntries([16, 32, 48].map(size => [size, `icons/icon-${size}${suffix}.png`])) }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: `OTTSpeed · ${hasVideo ? (isPlaying ? '재생 중' : '일시정지') : '비디오 없음'}` }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) return false;
  if (message?.action === 'updateVideoState') {
    updateTabState(sender.tab.id, Boolean(message.hasVideo), Boolean(message.isPlaying));
    return false;
  }
  if (message?.action === 'getSubtitleSession' && typeof message.mediaKey === 'string' && message.mediaKey.length < 2048) {
    OTTSubtitleLibrary.get(message.mediaKey).then(session => sendResponse({
      session: session ? { mediaKey: session.mediaKey, tracks: session.tracks, settings: session.settings } : null
    })).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener(tabId => tabStates.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') { updateTabState(tabId, false, false); tabStates.delete(tabId); }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const cached = tabStates.get(tabId);
  if (cached) { updateTabState(tabId, cached.hasVideo, cached.isPlaying); return; }
  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'checkVideo' });
    if (result) updateTabState(tabId, result.hasVideo, result.isPlaying);
  } catch { /* Restricted pages and tabs without a content script. */ }
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void chrome.storage.local.set({ speed: 1 });
});
