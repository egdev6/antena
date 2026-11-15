import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatTrace } from './helpers/meld-trace.mjs';
import { recordingTrace } from './helpers/meld-trace-recording.mjs';

test('Meld recording and route guards match the unchanged-main trace', { timeout: 60000 }, async t => {
  const actual = formatTrace(await recordingTrace(t));
  const expected = await readFile(new URL('./fixtures/meld-equivalence-trace-recording.json', import.meta.url), 'utf8');
  assert.equal(actual, expected);
});
