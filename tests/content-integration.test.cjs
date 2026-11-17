const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const engine = fs.readFileSync(path.join(__dirname, '..', 'translation-engine.js'), 'utf8');

function page(api) {
  const nodes = new Map();
  const element = id => nodes.get(id) || nodes.set(id, {textContent: '', style: {display: 'none'}, onclick: null,
    addEventListener() {}, setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {}}).get(id);
  const root = {innerHTML: '', getElementById: element, querySelector: selector => element(selector === '.head' ? 'head' : 'close')};
  const host = {isConnected: false, style: {setProperty() {}}, attachShadow: () => root,
    setAttribute() {}, matches: () => false, showPopover() {}, getBoundingClientRect: () => ({left: 0, top: 0, width: 240, height: 100}),
    remove() { this.isConnected = false; }};
  const video = {currentTime: 42, currentSrc: 'https://video.deeplearning.ai/test.m3u8', textTracks: []};
  const pageData = {props: {pageProps: {trpcState: {json: {queries: [{state: {data: {captions: [
    {startInSeconds: 41, endInSeconds: 44, text: "has three main benefits that you'll start to see right away."}
  ]}}}]}}}}};
  const document = {
    createElement: () => host,
    body: {append: () => { host.isConnected = true; }},
    documentElement: {append: () => { host.isConnected = true; }},
    addEventListener() {},
    querySelector: selector => selector === '.lesson-video-player video' ? video : selector === 'script#__NEXT_DATA__' ? {textContent: JSON.stringify(pageData)} : null,
    querySelectorAll: () => []
  };
  let receive;
  const window = {innerWidth: 1280, innerHeight: 720}; window.top = window;
  const context = vm.createContext({window, document, location: {hostname: 'learn.deeplearning.ai'},
    chrome: {runtime: {onMessage: {addListener: handler => { receive = handler; }}, sendMessage: async () => ({mode: null})}},
    Translator: api, setInterval, clearInterval, setTimeout, clearTimeout, requestAnimationFrame, AbortController, console});
  vm.runInContext(engine, context);
  vm.runInContext(source, context);
  return {receive, element, stop: () => receive({type: 'STOP'})};
}
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('DeepLearning captions reach a visible Chinese translation', async () => {
  const view = page({availability: async () => 'available', create: async () => ({translate: async () => '你很快就会看到三个主要好处。', destroy() {}})});
  view.receive({type: 'START', mode: 'subtitle'});
  await tick(180);
  assert.match(view.element('en').textContent, /three main benefits/);
  assert.equal(view.element('zh').textContent, '你很快就会看到三个主要好处。');
  view.stop();
});
test('missing language pack stays visible and offers a download button', async () => {
  const view = page({availability: async () => 'downloadable', create: async () => { throw new Error('must not download automatically'); }});
  view.receive({type: 'START', mode: 'subtitle'});
  await tick(180);
  assert.match(view.element('en').textContent, /three main benefits/);
  assert.equal(view.element('zh').textContent, '等待英中语言包');
  assert.equal(view.element('prepare').style.display, 'inline-block');
  assert.match(view.element('status').textContent, /下载/);
  view.stop();
});
