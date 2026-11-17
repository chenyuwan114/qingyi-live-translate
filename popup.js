const status = document.getElementById('status');
async function command(type) {
  status.textContent = '正在处理…';
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('请在普通网页的视频标签页使用。');
    const result = await chrome.runtime.sendMessage({type, tabId: tab.id});
    if (!result?.ok) throw new Error(result?.error || '操作失败');
    status.textContent = type === 'STOP' ? '已停止' : '已启动，请查看页面右下角状态。';
  } catch (error) { status.textContent = error.message; }
}
document.getElementById('subtitle').onclick = () => command('START_SUBTITLE');
document.getElementById('online').onclick = () => command('START_SUBTITLE_ONLINE');
document.getElementById('audio').onclick = () => command('START_AUDIO');
document.getElementById('stop').onclick = () => command('STOP');
