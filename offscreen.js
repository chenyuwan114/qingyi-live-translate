let stream = null;
let recognition = null;
let audioContext = null;
let currentTab = null;
let running = false;
let lastInterim = '';
let lastInterimAt = 0;
function report(type, value, final = false) {
  if (currentTab !== null) chrome.runtime.sendMessage({type, tabId: currentTab, ...(type === 'AUDIO_TEXT' ? {text: value, final} : {error: value})}).catch(() => {});
}
async function stopAudio() {
  running = false;
  if (recognition) { recognition.onend = null; recognition.abort(); recognition = null; }
  if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
  if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
  currentTab = null;
  lastInterim = '';
  lastInterimAt = 0;
}
async function startAudio(tabId, streamId) {
  await stopAudio();
  currentTab = tabId;
  const Speech = self.SpeechRecognition || self.webkitSpeechRecognition;
  if (!Speech) throw new Error('当前 Chrome 不支持语音识别。');
  stream = await navigator.mediaDevices.getUserMedia({audio: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: streamId}}, video: false});
  audioContext = new AudioContext();
  audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
  recognition = new Speech();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = event => {
    const now = Date.now();
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text || (!result.isFinal && text === lastInterim)) continue;
      if (result.isFinal || now - lastInterimAt >= 450) {
        lastInterim = text;
        lastInterimAt = now;
        report('AUDIO_TEXT', text, result.isFinal);
      }
    }
  };
  recognition.onerror = event => report('AUDIO_STATUS', `语音识别：${event.error}`);
  recognition.onend = () => {
    if (running && stream?.active) setTimeout(() => {
      if (running) try { recognition.start(stream.getAudioTracks()[0]); } catch (e) { report('AUDIO_STATUS', e.message); }
    }, 200);
  };
  running = true;
  try { recognition.start(stream.getAudioTracks()[0]); }
  catch (error) { await stopAudio(); throw new Error(`此 Chrome 无法识别标签页音频：${error.message}`); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'offscreen') return;
  (message.type === 'STOP_AUDIO' ? stopAudio() : startAudio(message.tabId, message.streamId))
    .then(() => respond({ok: true}), error => respond({ok: false, error: error.message}));
  return true;
});
