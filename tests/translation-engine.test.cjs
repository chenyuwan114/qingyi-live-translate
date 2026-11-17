const test = require('node:test');
const assert = require('node:assert/strict');
const QingyiTranslator = require('../translation-engine.js');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const fast = {availability: 20, create: 20, download: 30, translate: 20};
const stub = (overrides = {}) => ({
  availability: async () => 'available',
  create: async () => ({translate: async text => `中文：${text}`, destroy() {}}),
  ...overrides
});

test('whole initialization is single-flight, including availability', async () => {
  const gate = deferred();
  let checks = 0, creates = 0;
  const engine = new QingyiTranslator({api: stub({
    availability() { checks++; return gate.promise; },
    async create() { creates++; return {translate: async () => '你好'}; }
  })});
  const one = engine.prepare();
  const two = engine.prepare();
  assert.equal(one, two);
  gate.resolve('available');
  await Promise.all([one, two]);
  assert.equal(checks, 1);
  assert.equal(creates, 1);
});

for (const stage of ['availability', 'create', 'download', 'translate']) {
  test(`hung ${stage} times out, latches failure, and recovers after reset`, async () => {
    let hung = true, attempts = 0;
    const states = [];
    const api = stub({
      availability() {
        if (stage === 'availability') { attempts++; if (hung) return new Promise(() => {}); }
        return Promise.resolve(stage === 'download' ? 'downloadable' : 'available');
      },
      create() {
        if (stage === 'create' || stage === 'download') { attempts++; if (hung) return new Promise(() => {}); }
        return Promise.resolve({
          translate() { if (stage === 'translate') { attempts++; if (hung) return new Promise(() => {}); } return Promise.resolve('恢复成功'); },
          destroy() {}
        });
      }
    });
    const engine = new QingyiTranslator({api, timeouts: fast, onState: state => states.push(state)});
    const pending = stage === 'translate' ? engine.translate('hello') : engine.prepare(stage === 'download');
    await assert.rejects(pending, {code: `TIMEOUT_${stage.toUpperCase()}`});
    assert.equal(states.at(-1).phase, 'error');
    const before = attempts;
    hung = false;
    await assert.rejects(engine.translate('again'), {code: `TIMEOUT_${stage.toUpperCase()}`});
    assert.equal(attempts, before);
    engine.reset();
    await engine.prepare(stage === 'download');
    assert.equal(await engine.translate('hello'), '恢复成功');
  });
}

test('download waits for explicit prepare(true), reports progress', async () => {
  let creates = 0;
  const states = [];
  const engine = new QingyiTranslator({onState: state => states.push(state), api: stub({
    availability: async () => 'downloadable',
    async create(options) {
      creates++;
      options.monitor({addEventListener(type, listener) {
        assert.equal(type, 'downloadprogress');
        listener({loaded: 0.4, total: 1});
      }});
      return {translate: async () => '语言包已就绪'};
    }
  })});
  await assert.rejects(engine.prepare(), {code: 'DOWNLOAD_REQUIRED'});
  assert.equal(creates, 0);
  assert.equal(states.at(-1).phase, 'download-required');
  await engine.prepare(true);
  assert.equal(creates, 1);
  assert.ok(states.some(state => state.phase === 'downloading' && state.progress === 0.4));
  assert.equal(await engine.translate('ready'), '语言包已就绪');
});

test('reset immediately rejects pending creation and destroys late-created instance', async () => {
  const gate = deferred();
  let signal, destroyed = 0, creates = 0;
  const engine = new QingyiTranslator({api: stub({create(options) {
    signal = options.signal;
    creates++;
    if (creates === 1) return gate.promise;
    return Promise.resolve({translate: async () => '新实例'});
  }})});
  const first = engine.prepare();
  await pause(0);
  engine.reset();
  assert.equal(signal.aborted, true);
  await assert.rejects(first, {code: 'RESET'});
  await engine.prepare();
  gate.resolve({translate: async () => '旧实例', destroy() { destroyed++; }});
  await pause(0);
  assert.equal(destroyed, 1);
  assert.equal(await engine.translate('test'), '新实例');
});

test('late translation cannot overwrite a reset session or seed its cache', async () => {
  const old = deferred();
  let calls = 0, destroyed = 0;
  const engine = new QingyiTranslator({api: stub({async create() {
    return {translate() { calls++; return calls === 1 ? old.promise : Promise.resolve('新结果'); }, destroy() { destroyed++; }};
  }})});
  const pending = engine.translate('same');
  await pause(0);
  engine.reset();
  await assert.rejects(pending, {code: 'RESET'});
  old.resolve('旧结果');
  assert.equal(await engine.translate('same'), '新结果');
  assert.equal(calls, 2);
  assert.equal(destroyed, 1);
});

test('cache and concurrent identical requests avoid work; cache holds at most 300 entries', async () => {
  let calls = 0;
  const engine = new QingyiTranslator({api: stub({async create() {
    return {async translate(text) { calls++; return `译文${text}`; }};
  }})});
  const a = engine.translate('hello');
  const b = engine.translate('hello');
  assert.equal(a, b);
  assert.equal(await a, '译文hello');
  assert.equal(await engine.translate('hello'), '译文hello');
  assert.equal(calls, 1);
  for (let i = 0; i < 300; i++) await engine.translate(`line${i}`);
  assert.equal(engine.cache.size, 300);
  await engine.translate('hello');
  assert.equal(calls, 302);
});

test('rejected and late-rejected browser promises do not leak unhandled rejections', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const late = deferred();
    const engine = new QingyiTranslator({api: stub({create: () => late.promise}), timeouts: fast});
    const pending = engine.prepare();
    await assert.rejects(pending, {code: 'TIMEOUT_CREATE'});
    late.reject(new Error('late browser failure'));
    const rejected = new QingyiTranslator({api: stub({availability: async () => { throw new Error('unavailable'); }})});
    await assert.rejects(rejected.prepare(), /unavailable/);
    await pause(10);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});
