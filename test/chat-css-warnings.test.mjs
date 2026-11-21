import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horizontalCssWarnings } from '../app/src/lib/chat-css.ts';

// The CSS a horizontal variant inherited from the vertical chat: it boxed the row into a
// 430×571 column and pinned the card width and font, so the strip showed nothing.
const VERTICAL_CSS = `
  .root {
     inset: 15px 5px auto auto;
     width: 430px;
     height: 571px;
     padding: 12px 14px 0;
     -webkit-mask-image: linear-gradient(180deg, #000 0, transparent 100%);
  }
  /* Message card */
  .msg {
     position: relative;
     flex: none;
     padding: 10px 14px 12px;
     font: 500 17px/1.32 var(--f-body);
  }
  .msg:last-child:not(.out)::after { content: ""; position: absolute; inset: 0; }
  .who { color: #FF8FA6; }
`;

test('flags the root sizing and card overrides that break the horizontal layout', () => {
  assert.deepEqual(horizontalCssWarnings(VERTICAL_CSS), [
    '.root { inset }', '.root { width }', '.root { height }', '.root { padding }', '.root { -webkit-mask-image }',
    '.msg { flex }', '.msg { padding }', '.msg { font }',
  ]);
});

test('card styling that keeps the layout is not flagged', () => {
  const css = `
    .msg { position: relative; padding-left: 14px; padding-right: 14px; border: 1.5px solid red;
      border-radius: 14px; background: #111; box-shadow: 0 0 12px red; font-family: var(--f-body); font-weight: 500; }
    .msg.mod { border-left-color: #fff; }
    .msg:last-child:not(.out)::after { content: ""; position: absolute; inset: 0; animation: x 1s; }
    .who { gap: .5em; font-family: var(--f-cond); }
    .text { color: #fff; }
    @keyframes x { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .msg::after { animation: none !important; } }`;
  assert.deepEqual(horizontalCssWarnings(css), []);
});

test('each selector and property is reported once, also inside @media, and comments are ignored', () => {
  const css = `/* .root { width: 1px } */
    .root, .msg { height: 100px }
    @media (min-width: 1px) { .root { height: 50px } .msg { font-size: 20px; flex-basis: 10px } }
    .msg.mod { height: 90px }`;
  assert.deepEqual(horizontalCssWarnings(css), ['.root { height }', '.msg { height }', '.msg { font-size }', '.msg { flex-basis }']);
});

test('empty or non-string CSS gives no warnings', () => {
  assert.deepEqual(horizontalCssWarnings(''), []);
  assert.deepEqual(horizontalCssWarnings(undefined), []);
});
