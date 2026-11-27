// #364: the continuous animations of the goal, tier list and latest widgets run on the
// compositor. They run for the whole stream inside a browser source, so none of their
// animations or transitions may change a property that repaints on every frame.
// CSS review without a browser; the rendered behaviour is in overlay-anims-browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const REPAINT = new Set(['width', 'background-position', 'background-position-x', 'background-position-y', 'box-shadow', 'all']);
const TIME = /^[\d.]+m?s$/;
const EASING = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|(cubic-bezier|steps|linear)\(.*\))$/;
const ANIMATION_KEYWORDS = /^(normal|reverse|alternate|alternate-reverse|none|forwards|backwards|both|running|paused|infinite|[\d.]+)$/;

/** CSS tree: { rules: [{ prelude, rules, decls }], decls: ['prop: value', ...] } (nested at-rules included). */
function parse(css) {
  let i = 0;
  const block = () => {
    const rules = [], decls = [];
    let buf = '', depth = 0, quote = '';
    while (i < css.length) {
      const ch = css[i++];
      if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === '{' && depth === 0) { rules.push({ prelude: buf.trim(), ...block() }); buf = ''; }
      else if (ch === '}' && depth === 0) { if (buf.trim()) decls.push(buf.trim()); return { rules, decls }; }
      else if (ch === ';' && depth === 0) { if (buf.trim()) decls.push(buf.trim()); buf = ''; }
      else buf += ch;
    }
    if (buf.trim()) decls.push(buf.trim());
    return { rules, decls };
  };
  return block();
}

/** Splits a value at the commas that are not inside parentheses. */
function commaList(value) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const words = item => item.match(/[^\s(]+(\([^)]*\))?/g) || [];

/** Properties that the CSS animates or transitions, as `{ where, property }` offenders-to-be. */
function animatedProperties(css) {
  const tree = parse(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const keyframes = new Map(), uses = [];
  const walk = (node, selector) => {
    for (const rule of node.rules) {
      if (/^@keyframes\b/.test(rule.prelude)) {
        const props = new Set();
        for (const frame of rule.rules) for (const decl of frame.decls) props.add(decl.split(':')[0].trim().toLowerCase());
        keyframes.set(rule.prelude.replace(/^@keyframes\s+/, ''), props);
      } else walk(rule, rule.prelude);
    }
    for (const decl of node.decls) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim().toLowerCase(), value = decl.slice(at + 1).trim();
      if (prop === 'transition-property') for (const name of commaList(value)) uses.push({ where: selector, kind: 'transition', name: name.toLowerCase() });
      if (prop === 'transition') for (const item of commaList(value)) {
        const name = words(item).find(w => !TIME.test(w) && !EASING.test(w) && w !== 'allow-discrete' && w !== 'normal');
        if (name) uses.push({ where: selector, kind: 'transition', name: name.toLowerCase() });
      }
      if (prop === 'animation-name') for (const name of commaList(value)) uses.push({ where: selector, kind: 'animation', name });
      if (prop === 'animation') for (const item of commaList(value)) {
        const name = words(item).find(w => !TIME.test(w) && !EASING.test(w) && !ANIMATION_KEYWORDS.test(w));
        if (name) uses.push({ where: selector, kind: 'animation', name });
      }
    }
  };
  walk(tree, '');
  return uses.flatMap(use => use.kind === 'transition'
    ? [{ where: `${use.where} transition`, property: use.name }]
    : [...(keyframes.get(use.name) || [])].map(property => ({ where: `${use.where} animation ${use.name}`, property })));
}

const repaintOffenders = css => animatedProperties(css).filter(({ property }) => REPAINT.has(property));

const styleOf = file => [...readFileSync(path.join(root, file), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');

test('the checker flags width, background-position and box-shadow in transitions and keyframes', () => {
  const found = css => repaintOffenders(css).map(o => o.property).sort();
  assert.deepEqual(found('.a{transition:width .5s cubic-bezier(.2,1,.3,1)}'), ['width']);
  assert.deepEqual(found('.a{transition:opacity .4s,box-shadow 1s ease-out}'), ['box-shadow']);
  assert.deepEqual(found('.a{transition:1s linear background-position}'), ['background-position']);
  assert.deepEqual(found('.a{transition-property:transform,width}'), ['width']);
  assert.deepEqual(found('.a{transition:all .3s}'), ['all']);
  assert.deepEqual(found('@layer x{.a{animation:move 1.6s linear infinite}@keyframes move{to{background-position:56px 0}}}'), ['background-position']);
  assert.deepEqual(found('.a{animation-name:glow}@keyframes glow{0%{box-shadow:0 0 0 1px red,0 0 9px blue}100%{}}'), ['box-shadow']);
  assert.deepEqual(found('.a{animation:pulse 1.4s ease-in-out infinite alternate}@keyframes pulse{to{box-shadow:0 0 9px red}}'), ['box-shadow']);
});

test('the checker accepts compositor-only animations and static properties', () => {
  const css = `.a{width:0;box-shadow:0 0 9px red;background-position:1px 2px;transition:opacity .4s,transform .5s cubic-bezier(.2,1.2,.4,1)}
    .b{animation:drop .5s cubic-bezier(.2,1.4,.4,1) both}@keyframes drop{from{opacity:0;transform:translateY(-14px) scale(.9)}}
    .c{animation:spin 1s linear infinite}@keyframes spin{to{translate:9px 0;scale:2}}`;
  assert.deepEqual(repaintOffenders(css), []);
  assert.deepEqual(animatedProperties(css).map(a => a.property).sort(), ['opacity', 'opacity', 'scale', 'transform', 'transform', 'translate']);
});

for (const widget of ['goal', 'tierlist', 'latest']) {
  test(`${widget}.html: no animation or transition changes width, background-position or box-shadow`, () => {
    const css = styleOf(`public/widgets/${widget}.html`);
    assert.ok(css.includes('@layer egdev'), 'the widget stylesheet was found');
    assert.deepEqual(repaintOffenders(css), []);
  });
}
