import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatTrace } from './helpers/meld-trace.mjs';
import { consumerTrace } from './helpers/meld-trace-consumers.mjs';

test('Meld consumer interactions match the unchanged-main trace', { timeout: 60000 }, async t => {
  const actual = formatTrace(await consumerTrace(t));
  const expected = await readFile(new URL('./fixtures/meld-equivalence-trace-consumers.json', import.meta.url), 'utf8');
  assert.equal(actual, expected);
});
