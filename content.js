(() => {
  if (globalThis.__qingyiInstalled) return;
  globalThis.__qingyiInstalled = true;
  const isTop = window === window.top;
  let mode = null;
  let timer = null;
  let translator = null;
  function onTranslatorState(state) {
    status(state.message);
    $('prepare').style.display = state.phase === 'download-required' ? 'inline-block' : 'none';
    $('retry').style.display = state.phase === 'error' ? 'inline-block' : 'none';
    if (state.phase === 'download-required') $('zh').textContent = '等待英中语言包';
    if (state.phase === 'error') $('zh').textContent = '翻译暂不可用';
  }
  function makeTranslator() { return new globalThis.QingyiTranslator({onState: onTranslatorState}); }
  let lastSource = '';
  let sequence = 0;
  let queuedText = '';
  let translating = false;
  let captionRoots = [document];
  let rootsCheckedAt = 0;
  let timedCaptions = null;
  let timedCaptionVideo = null;

  const host = document.createElement('div');
  host.id = 'qingyi-root';
  host.setAttribute('popover', 'manual');
  host.style.cssText = 'position:fixed!important;left:auto!important;top:auto!important;right:20px!important;bottom:24px!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:2147483647!important;pointer-events:none!important';
  const root = host.attachShadow({mode: 'closed'});
  root.innerHTML = `<style>
    *{box-sizing:border-box} .box{display:flex;flex-direction:column;width:min(560px,calc(100vw - 40px));height:140px;min-width:min(280px,calc(100vw - 40px));min-height:96px;max-width:calc(100vw - 40px);max-height:calc(100vh - 48px);resize:both;overflow:auto;padding:13px 16px;border-radius:14px;background:rgba(9,18,34,.88);color:#fff;font:16px/1.45 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 8px 32px #0008;backdrop-filter:blur(8px);pointer-events:auto;cursor:move;user-select:none;touch-action:none}
    .head{flex:none;display:flex;justify-content:space-between;align-items:center;color:#91b7e8;font-size:11px;margin-bottom:6px;cursor:move}.close{border:0;background:transparent;color:#aab6c8;cursor:pointer;font-size:18px;line-height:1}.zh{flex:1;font-size:20px;font-weight:650;margin-top:4px;min-height:26px}.status{flex:none;color:#ffd398;font-size:12px;margin-top:4px}.prepare{flex:none;display:none;margin-top:8px;border:0;border-radius:7px;background:#3377db;color:white;padding:6px 10px;cursor:pointer}.retry{background:#6a4d23}
  </style><div class="box"><div class="head"><span id="label">轻译</span><button class="close" title="停止">×</button></div><div class="zh" id="zh">等待英文内容…</div><div class="status" id="status"></div><button class="prepare" id="prepare">下载英中语言包并开始</button><button class="prepare retry" id="retry">重试翻译</button></div>`;
  const $ = id => root.getElementById(id);
  const dragSurface = root.querySelector('.box');
  let drag = null;
  dragSurface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    // Leave the browser's native bottom-right resize grip available.
    if (event.clientX >= rect.right - 24 && event.clientY >= rect.bottom - 24) return;
    event.preventDefault();
    drag = {pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top};
    host.style.setProperty('left', `${rect.left}px`, 'important');
    host.style.setProperty('top', `${rect.top}px`, 'important');
    host.style.setProperty('right', 'auto', 'important');
    host.style.setProperty('bottom', 'auto', 'important');
    dragSurface.setPointerCapture(event.pointerId);
  });
  dragSurface.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = host.getBoundingClientRect();
    const left = Math.max(0, Math.min(window.innerWidth - rect.width, event.clientX - drag.offsetX));
    const top = Math.max(0, Math.min(window.innerHeight - rect.height, event.clientY - drag.offsetY));
    host.style.setProperty('left', `${left}px`, 'important');
    host.style.setProperty('top', `${top}px`, 'important');
  });
  const endDrag = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    if (dragSurface.hasPointerCapture(event.pointerId)) dragSurface.releasePointerCapture(event.pointerId);
  };
  dragSurface.addEventListener('pointerup', endDrag);
  dragSurface.addEventListener('pointercancel', endDrag);
  root.querySelector('.close').onclick = () => { chrome.runtime.sendMessage({type: 'STOP'}).catch(() => {}); stop(); };
  $('prepare').onclick = () => {
    $('prepare').style.display = 'none';
    translator.prepare(true).then(() => drainTranslations()).catch(() => {});
  };
  $('retry').onclick = () => {
    translator.reset();
    translating = false;
    $('retry').style.display = 'none';
    if (lastSource) queuedText = lastSource;
    drainTranslations();
  };
  function promoteOverlay() {
    if (!host.isConnected || typeof host.showPopover !== 'function') return;
    // Fullscreen video is placed in the browser's top layer above ordinary DOM
    // stacking contexts. Reopening the popover after fullscreenchange puts the
    // translation panel above the fullscreen player as well.
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  }
  document.addEventListener('fullscreenchange', () => {
    if (host.isConnected) requestAnimationFrame(promoteOverlay);
  });
  function mount() {
    if (!isTop) return;
    if (!host.isConnected) (document.body || document.documentElement).append(host);
    promoteOverlay();
  }
  function status(value) { $('status').textContent = value || ''; }
  function stop() { mode = null; if (timer) clearInterval(timer); timer = null; if (host.matches(':popover-open')) host.hidePopover(); host.remove(); lastSource = ''; queuedText = ''; sequence++; translator?.reset(); translator = null; }
  function normalize(text) {
    return (text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  function applyTerminology(source, translation) {
    // Chrome's built-in model is general-purpose. In this software/AI context,
    // “agent” means an autonomous AI entity, so normalize its common Chinese
    // renderings only when the English source actually contains that term.
    if (!/\bagents?\b/i.test(source)) return translation;
    return translation.replace(/人工智能代理|(?:AI\s*)?智能代理|编程代理人|编码代理|编程代理|代码代理|软件代理|代理程序|代理人|代理/g, '智能体');
  }
  function deepLearningCaption() {
    if (location.hostname !== 'learn.deeplearning.ai') return '';
    const video = document.querySelector('.lesson-video-player video') || document.querySelector('video');
    if (!video || !Number.isFinite(video.currentTime)) return '';
    if (!timedCaptions || timedCaptionVideo !== video.currentSrc) {
      timedCaptionVideo = video.currentSrc;
      timedCaptions = [];
      try {
        const pageData = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || '{}');
        const queries = pageData.props?.pageProps?.trpcState?.json?.queries || [];
        const data = queries.map(query => query.state?.data).find(item =>
          Array.isArray(item?.captions) && item.captions.some(cue =>
            typeof cue.startInSeconds === 'number' && typeof cue.text === 'string'));
        if (data) {
          let group = [];
          for (const cue of data.captions) {
            group.push(cue);
            if (/[.!?。！？]["']?$/.test(cue.text.trim()) || group.length >= 5) {
              timedCaptions.push({start: group[0].startInSeconds, end: group.at(-1).endInSeconds,
                text: group.map(part => part.text).join(' ')});
              group = [];
            }
          }
          if (group.length) timedCaptions.push({start: group[0].startInSeconds, end: group.at(-1).endInSeconds,
            text: group.map(part => part.text).join(' ')});
        }
      } catch (error) { status(`课程字幕读取失败：${error.message}`); }
    }
    const time = video.currentTime;
    const index = timedCaptions.findIndex(item => time >= item.start && time < item.end);
    const group = timedCaptions[index];
    return group?.text || '';
  }
  async function drainTranslations() {
    if (translating || !isTop) return;
    translating = true;
    const session = sequence;
    const engine = translator;
    try {
      while (queuedText && mode && session === sequence) {
        const text = queuedText;
        queuedText = '';
        try {
          const chinese = await engine.translate(text);
          if (mode && session === sequence) {
            $('zh').textContent = applyTerminology(text, chinese);
          }
        } catch (error) {
          if (error.code === 'DOWNLOAD_REQUIRED') { queuedText = lastSource; break; }
          if (error.code === 'RESET') break;
          break;
        }
      }
    } finally {
      translating = false;
      if (queuedText && mode && translator && !translator.failure && translator.instance) drainTranslations();
    }
  }
  function translate(raw, force = false) {
    const english = normalize(raw);
    if (!english || (!force && english === lastSource)) return;
    lastSource = english;
    queuedText = english;
    if ($('zh').textContent === '等待英文声音…' || $('zh').textContent === '等待英文字幕…') $('zh').textContent = '翻译中…';
    drainTranslations();
  }
  function captionText() {
    const courseCaption = deepLearningCaption();
    if (courseCaption) return courseCaption;
    const candidates = [];
    for (const video of document.querySelectorAll('video')) {
      for (const track of video.textTracks) {
        if (track.mode === 'disabled') continue;
        for (const cue of track.activeCues || []) {
          const lang = (track.language || '').toLowerCase();
          if (!lang || lang.startsWith('en')) candidates.push(cue.text);
        }
      }
    }
    if (candidates.length) return candidates.join(' ');
    const selectors = [
      '.ytp-caption-segment',
      '.caption-window .captions-text',
      '[data-testid="closed-caption-text"]',
      '.vjs-text-track-display .vjs-text-track-cue',
      '.jw-text-track-cue',
      '.plyr__captions span',
      '.vimeo-captions',
      '.fp-captions',
      '[class*="caption-line"]',
      '[class*="caption-text"]',
      '[class*="subtitle-line"]',
      '[class*="subtitle-text"]',
      '[data-testid*="caption"]'
    ];
    if (Date.now() - rootsCheckedAt > 5000) {
      captionRoots = [document];
      for (let i = 0; i < captionRoots.length && i < 200; i++) {
        for (const element of captionRoots[i].querySelectorAll('*')) if (element.shadowRoot) captionRoots.push(element.shadowRoot);
      }
      rootsCheckedAt = Date.now();
    }
    for (const currentRoot of captionRoots) {
      for (const selector of selectors) {
        const found = [...currentRoot.querySelectorAll(selector)].filter(el => el.getClientRects().length && !el.closest('#qingyi-root'));
        if (found.length) {
          const leaves = found.filter(el => !found.some(other => other !== el && el.contains(other)));
          const text = leaves.map(el => el.textContent.trim()).filter(Boolean).join(' ');
          if (text.length >= 10 && /[a-z]{2}/i.test(text)) return text;
        }
      }
    }
    return '';
  }
  function start(nextMode) {
    stop();
    mode = nextMode;
    mount();
    if (isTop) {
      translator = makeTranslator();
      $('label').textContent = nextMode === 'audio' ? '轻译 · 声音' : '轻译 · 英文字幕';
      $('zh').textContent = nextMode === 'audio' ? '等待英文声音…' : '等待英文字幕…';
      status(nextMode === 'audio' ? '正在连接标签页声音…' : '正在读取英文字幕…');
      translator.prepare(false).then(() => drainTranslations()).catch(() => {});
    }
    if (nextMode === 'subtitle') timer = setInterval(() => {
      const text = captionText();
      if (text) {
        if (isTop) translate(text);
        else if (text !== lastSource) { lastSource = text; chrome.runtime.sendMessage({type: 'FRAME_CAPTION', text}).catch(() => {}); }
      }
    }, 120);
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'START') start(message.mode);
    else if (message.type === 'STOP') stop();
    else if (message.type === 'AUDIO_TEXT' && isTop && mode === 'audio') translate(message.text);
    else if (message.type === 'FRAME_CAPTION' && isTop && mode === 'subtitle') translate(message.text);
    else if (message.type === 'AUDIO_STATUS') status(message.error || '声音识别已停止');
  });
  chrome.runtime.sendMessage({type: 'GET_MODE'}).then(result => { if (result?.mode && !mode) start(result.mode); }).catch(() => {});
})();
