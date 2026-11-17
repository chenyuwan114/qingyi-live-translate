(function (scope) {
  'use strict';

  const DEFAULT_TIMEOUTS = {availability: 3000, create: 10000, download: 120000, translate: 4000};
  const OPTIONS = {sourceLanguage: 'en', targetLanguage: 'zh'};
  const error = (code, message) => Object.assign(new Error(message), {code});
  const observed = promise => { promise.catch(() => {}); return promise; };
  const destroy = instance => { try { instance?.destroy?.(); } catch (_) {} };

  class QingyiTranslator {
    constructor({onState = () => {}, api = scope.Translator, timeouts = {}} = {}) {
      this.api = api;
      this.onState = onState;
      this.timeouts = {...DEFAULT_TIMEOUTS, ...timeouts};
      for (const key of Object.keys(DEFAULT_TIMEOUTS)) {
        if (!Number.isFinite(this.timeouts[key]) || this.timeouts[key] <= 0) {
          throw new TypeError(`无效的超时设置：${key}`);
        }
      }
      this.epoch = 0;
      this.instance = null;
      this.preparing = null;
      this.failure = null;
      this.allowDownload = false;
      this.pending = new Set();
      this.cache = new Map();
      this.translations = new Map();
    }

    _state(phase, message, extra = {}, epoch = this.epoch) {
      if (epoch !== this.epoch) return;
      try { this.onState({phase, message, ...extra}); } catch (_) {}
    }

    // Every operation settles even if the browser ignores its AbortSignal.
    // A late create() result is destroyed instead of becoming a live instance.
    _run(stage, timeout, operation, epoch, onLateValue) {
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        let timer;
        const finish = (reason, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(cancel);
          if (reason) reject(reason); else resolve(value);
        };
        const cancel = reason => {
          finish(reason);
          controller.abort(reason);
        };
        if (epoch !== this.epoch) {
          cancel(error('RESET', '翻译已停止或重置。'));
          return;
        }
        this.pending.add(cancel);
        timer = setTimeout(() => {
          const descriptions = {
            availability: '检查翻译引擎超时',
            create: '初始化翻译引擎超时',
            download: '下载英中语言包超时',
            translate: '生成中文译文超时'
          };
          cancel(error(`TIMEOUT_${stage.toUpperCase()}`, `${descriptions[stage]}，请点击重试。`));
        }, timeout);
        let result;
        try { result = operation(controller.signal); }
        catch (reason) { finish(reason); return; }
        Promise.resolve(result).then(value => {
          if (settled || epoch !== this.epoch) {
            if (onLateValue) onLateValue(value);
            if (!settled) cancel(error('RESET', '翻译已停止或重置。'));
            return;
          }
          finish(null, value);
        }, reason => { if (!settled) finish(reason); });
      });
    }

    _failed(reason, epoch) {
      if (epoch !== this.epoch || reason?.code === 'RESET' || reason?.code === 'DOWNLOAD_REQUIRED') return;
      const failure = reason instanceof Error ? reason : new Error(String(reason));
      if (!failure.code) failure.code = 'TRANSLATOR_FAILED';
      if (this.failure) return;
      this.failure = failure;
      destroy(this.instance);
      this.instance = null;
      for (const cancel of [...this.pending]) cancel(failure);
      this._state('error', `${failure.message}（重试前已暂停翻译）`, {code: failure.code}, epoch);
    }

    prepare(allowDownload = false) {
      if (this.failure) return observed(Promise.reject(this.failure));
      if (this.instance) return Promise.resolve(this.instance);
      if (this.preparing) {
        this.allowDownload ||= Boolean(allowDownload);
        return this.preparing;
      }
      this.allowDownload = Boolean(allowDownload);
      const epoch = this.epoch;
      const task = (async () => {
        if (!this.api?.availability || !this.api?.create) {
          throw error('API_UNAVAILABLE', '此 Chrome 暂不支持内置翻译，请使用支持该功能的桌面版 Chrome。');
        }
        this._state('checking', '正在检查英中翻译引擎…', {}, epoch);
        const availability = await this._run('availability', this.timeouts.availability,
          () => this.api.availability({...OPTIONS}), epoch);
        if (availability === 'unavailable') throw error('LANGUAGE_UNAVAILABLE', '此设备无法使用 Chrome 英中语言包。');
        if (!['available', 'downloadable', 'downloading'].includes(availability)) {
          throw error('INVALID_AVAILABILITY', `无法识别翻译引擎状态：${availability}`);
        }
        const downloading = availability !== 'available';
        if (downloading && !this.allowDownload) {
          this._state('download-required', '请点击按钮下载英中语言包。', {code: 'DOWNLOAD_REQUIRED'}, epoch);
          throw error('DOWNLOAD_REQUIRED', '英中语言包需要由你点击下载。');
        }
        this._state(downloading ? 'downloading' : 'initializing',
          downloading ? '正在下载英中语言包…' : '正在启动英中翻译引擎…', {}, epoch);
        const stage = downloading ? 'download' : 'create';
        const instance = await this._run(stage, this.timeouts[stage], signal => this.api.create({
          ...OPTIONS,
          signal,
          monitor: monitor => monitor.addEventListener('downloadprogress', event => {
            if (epoch !== this.epoch || this.failure || signal.aborted) return;
            const fraction = event.total > 0 ? event.loaded / event.total : event.loaded;
            const progress = Math.max(0, Math.min(1, Number(fraction) || 0));
            this._state('downloading', `正在下载英中语言包 ${Math.round(progress * 100)}%`, {progress}, epoch);
          })
        }), epoch, destroy);
        if (!instance || typeof instance.translate !== 'function') {
          destroy(instance);
          throw error('INVALID_TRANSLATOR', '翻译引擎没有正确启动。');
        }
        if (epoch !== this.epoch) { destroy(instance); throw error('RESET', '翻译已停止或重置。'); }
        this.instance = instance;
        this._state('ready', '英中翻译已就绪。', {}, epoch);
        return instance;
      })();
      const promise = task.then(value => {
        if (this.preparing === promise) this.preparing = null;
        return value;
      }, reason => {
        if (this.preparing === promise) this.preparing = null;
        this._failed(reason, epoch);
        throw reason;
      });
      this.preparing = observed(promise);
      return this.preparing;
    }

    translate(text) {
      if (this.failure) return observed(Promise.reject(this.failure));
      if (typeof text !== 'string' || !text.trim()) return observed(Promise.reject(error('EMPTY_TEXT', '没有可翻译的英文。')));
      text = text.trim();
      if (this.cache.has(text)) {
        const cached = this.cache.get(text);
        this.cache.delete(text);
        this.cache.set(text, cached);
        this._state('ready', '已读取缓存译文。');
        return Promise.resolve(cached);
      }
      if (this.translations.has(text)) return this.translations.get(text);
      const epoch = this.epoch;
      const task = (async () => {
        const instance = await this.prepare(false);
        if (epoch !== this.epoch) throw error('RESET', '翻译已停止或重置。');
        this._state('translating', '正在生成中文译文…', {}, epoch);
        const result = await this._run('translate', this.timeouts.translate,
          signal => instance.translate(text, {signal}), epoch);
        if (typeof result !== 'string' || !result.trim()) throw error('EMPTY_TRANSLATION', '翻译引擎返回了空译文。');
        if (epoch !== this.epoch) throw error('RESET', '翻译已停止或重置。');
        this.cache.set(text, result);
        if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
        this._state('ready', '中文译文已更新。', {}, epoch);
        return result;
      })();
      const promise = task.then(value => {
        if (this.translations.get(text) === promise) this.translations.delete(text);
        return value;
      }, reason => {
        if (this.translations.get(text) === promise) this.translations.delete(text);
        this._failed(reason, epoch);
        throw reason;
      });
      this.translations.set(text, observed(promise));
      return promise;
    }

    reset() {
      this.epoch++;
      const reason = error('RESET', '翻译已停止或重置。');
      for (const cancel of [...this.pending]) cancel(reason);
      destroy(this.instance);
      this.instance = null;
      this.preparing = null;
      this.failure = null;
      this.allowDownload = false;
      this.translations.clear();
      this.cache.clear();
    }
  }

  scope.QingyiTranslator = QingyiTranslator;
  if (typeof module !== 'undefined' && module.exports) module.exports = QingyiTranslator;
})(globalThis);
