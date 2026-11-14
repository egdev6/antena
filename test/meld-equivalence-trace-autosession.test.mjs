import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatTrace } from './helpers/meld-trace.mjs';
import { autoSessionTrace } from './helpers/meld-trace-autosession.mjs';

test('Meld automatic-session status and streaming match the unchanged-main trace', { timeout: 60000 }, async t => {
  const actual = formatTrace(await autoSessionTrace(t));
  const expected = await readFile(new URL('./fixtures/meld-equivalence-trace-autosession.json', import.meta.url), 'utf8');
  assert.equal(actual, expected);
});
