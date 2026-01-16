// OTT Speed Controller - Background Service Worker
// 아이콘 상태 관리 및 탭 간 통신을 담당합니다.

// Track video state per tab
const tabStates = new Map();

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateVideoState') {
    const tabId = sender.tab?.id;
    if (tabId) {
      updateTabState(tabId, message.hasVideo, message.isPlaying);
    }
  }
  return true;
});

// Update icon based on video state
function updateTabState(tabId, hasVideo, isPlaying) {
  tabStates.set(tabId, { hasVideo, isPlaying });
  
  // Update icon for the tab
  const iconPath = (hasVideo && isPlaying) ? {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png'
  } : {
    16: 'icons/icon-16-inactive.png',
    32: 'icons/icon-32-inactive.png',
    48: 'icons/icon-48-inactive.png'
  };

  chrome.action.setIcon({ 
    path: iconPath,
    tabId 
  }).catch(() => {});

  // Update badge
  if (hasVideo) {
    const badgeText = isPlaying ? '▶' : '❚❚';
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ 
      color: isPlaying ? '#4ecca3' : '#666666',
      tabId 
    }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }

  // Update title
  let title = 'OTT Speed Controller';
  if (hasVideo) {
    title += isPlaying ? ' - 재생 중' : ' - 일시정지';
  } else {
    title += ' - 비디오 없음';
  }
  chrome.action.setTitle({ title, tabId }).catch(() => {});
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

// Reset icon when navigating to new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    // Reset to inactive icon while loading
    chrome.action.setIcon({
      path: {
        16: 'icons/icon-16-inactive.png',
        32: 'icons/icon-32-inactive.png',
        48: 'icons/icon-48-inactive.png'
      },
      tabId
    }).catch(() => {});
    
    tabStates.delete(tabId);
  }
});

// Handle installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default speed
    chrome.storage.local.set({ speed: 1 });
    
    console.log('OTT Speed Controller installed!');
  }
});

// When active tab changes, check video state
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const state = tabStates.get(activeInfo.tabId);
  if (state) {
    updateTabState(activeInfo.tabId, state.hasVideo, state.isPlaying);
  }
});
