// DOM Elements
const speedValue = document.getElementById('speed-value');
const speedSlider = document.getElementById('speed-slider');
const presetButtons = document.querySelectorAll('.preset-btn');
const resetBtn = document.getElementById('reset-btn');
const statusEl = document.querySelector('.status');
const statusText = document.querySelector('.status-text');
const mainContent = document.getElementById('main-content');
const noVideoEl = document.getElementById('no-video');

// State
let currentTabId = null;
let hasVideo = false;

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  
  // Load saved speed
  const { speed = 1 } = await chrome.storage.local.get('speed');
  updateUI(speed);
  
  // Check for video on page
  checkForVideo();
  
  // Setup event listeners
  setupEventListeners();
}

function setupEventListeners() {
  // Slider change
  speedSlider.addEventListener('input', (e) => {
    const speed = parseFloat(e.target.value);
    updateUI(speed);
    setPlaybackSpeed(speed);
  });
  
  // Preset buttons
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.dataset.speed);
      updateUI(speed);
      setPlaybackSpeed(speed);
    });
  });
  
  // Reset button
  resetBtn.addEventListener('click', () => {
    updateUI(1);
    setPlaybackSpeed(1);
  });
}

async function checkForVideo() {
  try {
    const response = await chrome.tabs.sendMessage(currentTabId, { action: 'checkVideo' });
    hasVideo = response?.hasVideo || false;
    updateVideoStatus(hasVideo, response?.isPlaying);
  } catch (error) {
    // Content script not loaded or no video
    hasVideo = false;
    updateVideoStatus(false);
  }
}

function updateVideoStatus(hasVideo, isPlaying = false) {
  if (hasVideo) {
    mainContent.style.display = 'block';
    noVideoEl.style.display = 'none';
    statusEl.classList.remove('inactive');
    statusEl.classList.add('active');
    statusText.textContent = isPlaying ? '재생 중' : '일시정지';
  } else {
    mainContent.style.display = 'none';
    noVideoEl.style.display = 'block';
    statusEl.classList.remove('active');
    statusEl.classList.add('inactive');
    statusText.textContent = '비디오 없음';
  }
}

function updateUI(speed) {
  // Update display
  speedValue.textContent = speed.toFixed(2).replace(/\.?0+$/, '');
  
  // Update slider
  speedSlider.value = speed;
  
  // Update preset buttons
  presetButtons.forEach(btn => {
    const btnSpeed = parseFloat(btn.dataset.speed);
    btn.classList.toggle('active', btnSpeed === speed);
  });
  
  // Visual feedback for extreme speeds
  if (speed >= 2) {
    speedValue.style.color = '#ff6b6b';
  } else if (speed <= 0.5) {
    speedValue.style.color = '#4ecdc4';
  } else {
    speedValue.style.color = '#fff';
  }
}

async function setPlaybackSpeed(speed) {
  // Save to storage
  await chrome.storage.local.set({ speed });
  
  // Send to content script
  try {
    await chrome.tabs.sendMessage(currentTabId, { 
      action: 'setSpeed', 
      speed 
    });
  } catch (error) {
    console.log('Could not set speed:', error);
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'videoStateChanged') {
    updateVideoStatus(message.hasVideo, message.isPlaying);
  }
});
