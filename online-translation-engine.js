(function (scope) {
  'use strict';
  class QingyiOnlineTranslator {
    constructor({onState = () => {}} = {}) {
      this.onState = onState;
      this.epoch = 0;
      this.instance = null;
      this.failure = null;
      this.cache = new Map();
      this.pending = new Map();
    }
    state(phase, message, extra = {}) { this.onState({phase, message, ...extra}); }
    prepare() {
      this.instance = this;
      this.state('ready', '在线翻译已就绪（每日免费额度 5,000 字符）。');
      return Promise.resolve(this);
    }
    translate(text) {
      text = text.trim();
      if (this.failure) return Promise.reject(this.failure);
      if (this.cache.has(text)) return Promise.resolve(this.cache.get(text));
      if (this.pending.has(text)) return this.pending.get(text);
      const epoch = this.epoch;
      this.state('translating', '在线翻译中…');
      const task = chrome.runtime.sendMessage({type: 'ONLINE_TRANSLATE', text}).then(response => {
        if (epoch !== this.epoch) throw Object.assign(new Error('已停止'), {code: 'RESET'});
        if (!response?.ok) throw Object.assign(new Error(response?.error || '在线翻译失败'), {code: 'ONLINE_FAILED'});
        this.cache.set(text, response.translation);
        if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
        this.state('ready', '在线译文已更新。');
        return response.translation;
      }).catch(error => {
        if (epoch === this.epoch && error.code !== 'RESET') {
          this.failure = error;
          this.state('error', `${error.message}（可点击重试）`, {code: error.code || 'ONLINE_FAILED'});
        }
        throw error;
      }).finally(() => this.pending.delete(text));
      this.pending.set(text, task);
      return task;
    }
    reset() {
      this.epoch++;
      this.instance = null;
      this.failure = null;
      this.cache.clear();
      this.pending.clear();
    }
  }
  scope.QingyiOnlineTranslator = QingyiOnlineTranslator;
  if (typeof module !== 'undefined' && module.exports) module.exports = QingyiOnlineTranslator;
})(globalThis);
