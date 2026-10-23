'use strict';
const $ = id => document.getElementById(id);
let currentTabId = null;

function render(result = {}) {
  const available = Boolean(result.hasVideo);
  $('main-content').hidden = !available;
  $('no-video').style.display = available ? 'none' : 'block';
  $('workspace-btn').disabled = !available;
  $('status').className = `status ${available ? 'active' : 'inactive'}`;
  document.querySelector('.status-text').textContent = available ? (result.isPlaying ? '재생 중' : '일시정지') : '비디오 없음';
  if (Number.isFinite(result.currentSpeed)) renderSpeed(result.currentSpeed);
}

function renderSpeed(speed) {
  $('speed-value').textContent = speed.toFixed(2).replace(/\.?0+$/, '');
  $('speed-slider').value = speed;
  for (const button of document.querySelectorAll('.preset-btn')) button.classList.toggle('active', Number(button.dataset.speed) === speed);
}

async function setSpeed(speed) {
  try {
    const result = await chrome.tabs.sendMessage(currentTabId, { action: 'setSpeed', speed });
    if (!result || result.error) throw new Error(result?.error || '영상 탭을 새로고침해 주세요.');
    render(result);
    $('error').textContent = '';
  } catch (error) { $('error').textContent = error.message; }
}

$('speed-slider').addEventListener('input', event => { renderSpeed(Number(event.target.value)); void setSpeed(Number(event.target.value)); });
for (const button of document.querySelectorAll('.preset-btn')) button.addEventListener('click', () => void setSpeed(Number(button.dataset.speed)));
$('reset-btn').addEventListener('click', () => void setSpeed(1));
$('workspace-btn').addEventListener('click', async () => {
  if (!Number.isInteger(currentTabId)) return;
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('subtitles/workspace.html')}?tabId=${currentTabId}` });
  window.close();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && sender.tab?.id === currentTabId && message?.action === 'videoStateChanged') render(message);
  return false;
});

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;
    const result = await chrome.tabs.sendMessage(currentTabId, { action: 'checkVideo' });
    if (result?.error) throw new Error(result.error);
    render(result);
  } catch { render(); }
})();
