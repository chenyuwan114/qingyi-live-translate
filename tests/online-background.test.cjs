const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
function harness() {
  let handler;
  let saved;
  const requests = [];
  const chrome = {
    runtime: {
      id: 'qingyi-test',
      getURL: name => `chrome-extension://qingyi-test/${name}`,
      getContexts: async () => [],
      sendMessage: async () => ({ok: true}),
      onMessage: {addListener: fn => {handler = fn;}}
    },
    scripting: {executeScript: async () => {}},
    tabs: {sendMessage: async () => {}, onRemoved: {addListener: () => {}}},
    offscreen: {createDocument: async () => {}},
    tabCapture: {getMediaStreamId: async () => 'stream'},
    storage: {session: {
      get: async () => ({qingyi: saved}),
      set: async data => {saved = data.qingyi;},
      remove: async () => {saved = undefined;}
    }}
  };
  const fetch = async url => {
    requests.push(String(url));
    return {ok: true, json: async () => ({responseStatus: 200, responseData: {translatedText: '你好世界'}})};
  };
  vm.runInNewContext(source, {chrome, fetch, URL, URLSearchParams, TextEncoder, AbortSignal, console});
  const message = (payload, sender = {tab: {id: 7}}) => new Promise(resolve => {
    const sync = handler(payload, sender, resolve);
    if (sync !== true) resolve(undefined);
  });
  return {message, requests};
}

test('online mode sends only opted-in tab text to fixed MyMemory endpoint', async () => {
  const app = harness();
  await app.message({type: 'START_SUBTITLE_ONLINE', tabId: 7}, {});
  const translated = await app.message({type: 'ONLINE_TRANSLATE', text: 'Hello world'});
  assert.equal(translated.ok, true);
  assert.equal(translated.translation, '你好世界');
  const url = new URL(app.requests[0]);
  assert.equal(url.origin, 'https://api.mymemory.translated.net');
  assert.equal(url.searchParams.get('q'), 'Hello world');
  assert.equal(url.searchParams.get('langpair'), 'en|zh-CN');
  const foreignTab = await app.message({type: 'ONLINE_TRANSLATE', text: 'private'}, {tab: {id: 8}});
  assert.equal(foreignTab.ok, false);
  assert.equal(app.requests.length, 1);
});

test('local subtitle mode never permits the online translation request', async () => {
  const app = harness();
  await app.message({type: 'START_SUBTITLE', tabId: 7}, {});
  const result = await app.message({type: 'ONLINE_TRANSLATE', text: 'Hello world'});
  assert.equal(result.ok, false);
  assert.equal(app.requests.length, 0);
});
