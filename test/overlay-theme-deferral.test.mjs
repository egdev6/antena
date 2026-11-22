// Ejecuta el módulo real del overlay con DOM y reloj mínimos; los estímulos son sus eventos SSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.parts = new Map(); this.children = [];
    const classes = new Set();
    this.classList = { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) };
    this.style = { setProperty() {}, removeProperty() {} };
    this.scrollWidth = 0; this.clientWidth = 100; this.textContent = ''; this.href = '';
  }
  querySelector(selector) { if (!this.parts.has(selector)) this.parts.set(selector, new Element()); return this.parts.get(selector); }
  replaceChildren(...children) { this.children = children; }
  cloneNode() { return new Element(this.tag); }
  animate() {}
  remove() { this.removed = true; }
}

async function overlay() {
  const html = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
  const script = /<script type="module">\s*import \{ AntenaStream \}[^\n]*\n([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, 'módulo del overlay');
  const elements = { stage: new Element(), bg: new Element(), 'custom-css': new Element(), 'eg-theme': new Element('link'),
    'tpl-card': { content: { firstElementChild: new Element() } } };
  const audio = [], timers = new Map(); let now = 0, nextId = 0, stream;
  class FakeStream extends EventTarget { constructor() { super(); stream = this; } }
  class Audio { constructor(url) { this.url = url; } play() { audio.push({ url: this.url, volume: this.volume }); return Promise.resolve(); } }
  const document = { getElementById: id => elements[id] ?? null, createElement: tag => new Element(tag),
    documentElement: new Element('html'), body: new Element('body') };
  const setTimeout = (fn, ms) => { const id = ++nextId; timers.set(id, { at: now + ms, fn }); return id; };
  const clearTimeout = id => timers.delete(id);
  runInNewContext(script[1], { document, window: {}, location: { search: '' }, URLSearchParams, EventTarget,
    AntenaStream: FakeStream, Audio, setTimeout, clearTimeout, requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ fontSize: '80' }), performance: { now: () => now }, console });
  const emit = (type, data) => stream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  const advance = async ms => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await Promise.resolve(); await Promise.resolve();
    }
    now = until;
  };
  return { emit, advance, audio, ...elements };
}

const theme = (version, position, icon, sound) => ({ version, position, align: 'center', icons: { follow: `emoji:${icon}` }, sound, soundVolume: 100 });
const alert = id => ({ id, type: 'follow', platform: 'twitch', icon: 'heart', title: id, text: id, sub: '', durationMs: 1000,
  volume: 1, look: { layout: 'card', sound: 'default', soundVolume: 100 }, actions: [] });

test('theme SSE waits through the current exit; queued alert uses the latest CSS, icon, position and sound', async () => {
  const page = await overlay();
  page.emit('theme', theme('old', 'top', '🎉', 'old.mp3'));
  page.emit('alert', alert('first')); await Promise.resolve(); await Promise.resolve();
  assert.equal(page['eg-theme'].href, '/theme.css?v=old');
  assert.equal(page.stage.children[0].querySelector('.tile').children[0].textContent, '🎉');
  assert.deepEqual(page.audio.map(a => a.url), ['/media/old.mp3']);
  page.emit('alert', alert('second'));
  page.emit('theme', theme('middle', 'center', '⭐', 'middle.mp3'));
  page.emit('theme', theme('new', 'bottom', '💜', 'new.mp3'));
  assert.equal(page['eg-theme'].href, '/theme.css?v=old');
  assert.equal(page.stage.classList.contains('top'), true);
  assert.equal(page.stage.classList.contains('bottom'), false);
  await page.advance(1400); // empieza la animación de salida de la primera
  assert.equal(page['eg-theme'].href, '/theme.css?v=old');
  await page.advance(560);
  assert.equal(page['eg-theme'].href, '/theme.css?v=new');
  assert.equal(page.stage.classList.contains('bottom'), true);
  await page.advance(700);
  assert.equal(page.stage.children[0].querySelector('.tile').children[0].textContent, '💜');
  assert.deepEqual(page.audio.map(a => a.url), ['/media/old.mp3', '/media/new.mp3']);
});
