import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatTrace, meldTrace } from './helpers/meld-trace.mjs';

test('Meld WebChannel and public status/SSE match the unchanged-main trace', { timeout: 30000 }, async t => {
  const expected = await readFile(new URL('./fixtures/meld-equivalence-trace.json', import.meta.url), 'utf8');
  assert.equal(formatTrace(await meldTrace(t)), expected);
});
