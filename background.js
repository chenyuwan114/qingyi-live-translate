let activeTab = null;
let mode = null;

async function currentState() {
  const saved = (await chrome.storage.session.get('qingyi')).qingyi;
  return saved || {tabId: activeTab, mode};
}

async function ensureContent(tabId) {
  await chrome.scripting.executeScript({target: {tabId}, files: ['translation-engine.js', 'content.js']});
}
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]});
  if (!contexts.length) await chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: '识别当前标签页的英文声音'});
}
async function stop() {
  const state = await currentState();
  if (Number.isInteger(state.tabId)) {
    await chrome.tabs.sendMessage(state.tabId, {type: 'STOP'}).catch(() => {});
    await chrome.runtime.sendMessage({target: 'offscreen', type: 'STOP_AUDIO'}).catch(() => {});
  }
  activeTab = null;
  mode = null;
  await chrome.storage.session.remove('qingyi');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === 'offscreen' || message.target === 'page') return;
  if (message.type === 'GET_MODE') {
    currentState().then(state => respond({mode: sender.tab?.id === state.tabId ? state.mode : null}));
    return true;
  }
  if (message.type === 'FRAME_CAPTION') {
    if (mode === 'subtitle' && sender.tab?.id === activeTab && sender.frameId !== 0 && typeof message.text === 'string') {
      chrome.tabs.sendMessage(activeTab, {type: 'FRAME_CAPTION', text: message.text}, {frameId: 0}).catch(() => {});
    }
    return;
  }
  if (message.type === 'AUDIO_TEXT' || message.type === 'AUDIO_STATUS') {
    if (sender.id === chrome.runtime.id && mode === 'audio' && activeTab === message.tabId) {
      chrome.tabs.sendMessage(activeTab, {type: message.type, text: message.text, final: message.final, error: message.error}, {frameId: 0}).catch(() => {});
    }
    return;
  }
  if (!['START_SUBTITLE', 'START_AUDIO', 'STOP'].includes(message.type)) return;
  (async () => {
    if (message.type === 'STOP') { await stop(); return; }
    await stop();
    const tabId = message.tabId;
    await ensureContent(tabId);
    activeTab = tabId;
    mode = message.type === 'START_AUDIO' ? 'audio' : 'subtitle';
    await chrome.storage.session.set({qingyi: {tabId, mode}});
    await chrome.tabs.sendMessage(tabId, {type: 'START', mode});
    if (mode === 'audio') {
      await ensureOffscreen();
      const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tabId});
      const result = await chrome.runtime.sendMessage({target: 'offscreen', type: 'START_AUDIO', tabId, streamId});
      if (!result?.ok) throw new Error(result?.error || '声音识别启动失败');
    }
  })().then(() => respond({ok: true}), error => {
    const tabId = activeTab;
    if (tabId !== null) chrome.tabs.sendMessage(tabId, {type: 'AUDIO_STATUS', error: error.message}).catch(() => {});
    activeTab = null;
    mode = null;
    chrome.storage.session.remove('qingyi').catch(() => {});
    respond({ok: false, error: error.message});
  });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { if (tabId === activeTab) stop(); });
