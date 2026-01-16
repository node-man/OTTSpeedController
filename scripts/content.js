// OTT Speed Controller - Content Script
// 모든 웹사이트의 비디오 요소를 감지하고 재생속도를 제어합니다.

(function() {
  'use strict';

  let currentSpeed = 1;
  let videos = [];
  let observer = null;

  // Initialize
  init();

  async function init() {
    // Load saved speed
    const { speed = 1 } = await chrome.storage.local.get('speed');
    currentSpeed = speed;

    // Find initial videos
    findVideos();

    // Observe for dynamically added videos
    setupObserver();

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener(handleMessage);

    // Apply speed to existing videos
    applySpeedToAllVideos();
  }

  function findVideos() {
    videos = Array.from(document.querySelectorAll('video'));
    
    // Also check shadow DOMs (for some video players)
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        const shadowVideos = el.shadowRoot.querySelectorAll('video');
        videos = videos.concat(Array.from(shadowVideos));
      }
    });

    // Attach event listeners to each video
    videos.forEach(attachVideoListeners);

    // Notify background script about video presence
    notifyVideoState();
  }

  function attachVideoListeners(video) {
    // Remove existing listeners to avoid duplicates
    video.removeEventListener('play', onVideoPlay);
    video.removeEventListener('pause', onVideoPause);
    video.removeEventListener('ratechange', onRateChange);

    // Add listeners
    video.addEventListener('play', onVideoPlay);
    video.addEventListener('pause', onVideoPause);
    video.addEventListener('ratechange', onRateChange);

    // Apply current speed
    video.playbackRate = currentSpeed;
  }

  function setupObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      let videosAdded = false;

      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeName === 'VIDEO') {
            videosAdded = true;
          } else if (node.querySelector) {
            const newVideos = node.querySelectorAll('video');
            if (newVideos.length > 0) {
              videosAdded = true;
            }
          }
        });
      });

      if (videosAdded) {
        findVideos();
        applySpeedToAllVideos();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function applySpeedToAllVideos() {
    videos.forEach(video => {
      if (video.playbackRate !== currentSpeed) {
        video.playbackRate = currentSpeed;
      }
    });
  }

  function onVideoPlay(e) {
    notifyVideoState();
    showSpeedIndicator(e.target);
  }

  function onVideoPause(e) {
    notifyVideoState();
  }

  function onRateChange(e) {
    // If speed was changed externally (by the video player itself)
    // Update our stored speed
    if (e.target.playbackRate !== currentSpeed) {
      currentSpeed = e.target.playbackRate;
      chrome.storage.local.set({ speed: currentSpeed });
    }
  }

  function notifyVideoState() {
    const hasVideo = videos.length > 0;
    const isPlaying = videos.some(v => !v.paused);

    // Send to background script for icon update
    chrome.runtime.sendMessage({
      action: 'updateVideoState',
      hasVideo,
      isPlaying
    }).catch(() => {});

    // Also send to popup if it's open
    chrome.runtime.sendMessage({
      action: 'videoStateChanged',
      hasVideo,
      isPlaying
    }).catch(() => {});
  }

  function handleMessage(message, sender, sendResponse) {
    switch (message.action) {
      case 'checkVideo':
        findVideos();
        sendResponse({
          hasVideo: videos.length > 0,
          isPlaying: videos.some(v => !v.paused),
          currentSpeed
        });
        break;

      case 'setSpeed':
        currentSpeed = message.speed;
        applySpeedToAllVideos();
        showSpeedIndicator(videos[0]);
        sendResponse({ success: true });
        break;

      case 'getSpeed':
        sendResponse({ speed: currentSpeed });
        break;
    }
    return true; // Keep message channel open for async response
  }

  // Visual speed indicator overlay
  function showSpeedIndicator(video) {
    if (!video) return;

    // Remove existing indicator
    const existingIndicator = document.querySelector('.ott-speed-indicator');
    if (existingIndicator) {
      existingIndicator.remove();
    }

    // Create indicator
    const indicator = document.createElement('div');
    indicator.className = 'ott-speed-indicator';
    indicator.textContent = `${currentSpeed}x`;
    
    // Style
    Object.assign(indicator.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'rgba(0, 0, 0, 0.8)',
      color: '#4ecca3',
      padding: '16px 32px',
      borderRadius: '12px',
      fontSize: '32px',
      fontWeight: 'bold',
      fontFamily: 'system-ui, sans-serif',
      zIndex: '2147483647',
      pointerEvents: 'none',
      opacity: '1',
      transition: 'opacity 0.3s ease',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
      border: '2px solid rgba(78, 204, 163, 0.5)'
    });

    document.body.appendChild(indicator);

    // Fade out and remove
    setTimeout(() => {
      indicator.style.opacity = '0';
      setTimeout(() => indicator.remove(), 300);
    }, 800);
  }

  // Keyboard shortcuts (optional enhancement)
  document.addEventListener('keydown', (e) => {
    // Only when video is focused or playing
    if (videos.length === 0) return;
    
    // Ctrl/Cmd + Arrow keys for speed control
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      let newSpeed = currentSpeed;

      if (e.key === 'ArrowUp' || e.key === ']') {
        newSpeed = Math.min(4, currentSpeed + 0.25);
        e.preventDefault();
      } else if (e.key === 'ArrowDown' || e.key === '[') {
        newSpeed = Math.max(0.25, currentSpeed - 0.25);
        e.preventDefault();
      } else if (e.key === '0') {
        newSpeed = 1;
        e.preventDefault();
      }

      if (newSpeed !== currentSpeed) {
        currentSpeed = newSpeed;
        applySpeedToAllVideos();
        showSpeedIndicator(videos[0]);
        chrome.storage.local.set({ speed: currentSpeed });
      }
    }
  });

})();
