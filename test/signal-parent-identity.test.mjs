import test from 'node:test';
import assert from 'node:assert/strict';
import { parseParentCreationTime } from './helpers/signal-child.mjs';

// This is only the decimal-string contract. Passing on Unix is not evidence of
// Windows process identity validation; the native negative case lives in
// windows-signal-child.test.mjs and must run on a physical Windows runner.
test('parent creation time preserves canonical positive uint64 strings without numeric coercion', () => {
  for (const value of [
    '1',
    '10000001',
    '9007199254740991',
    '9007199254740992',
    '9007199254740993',
    '134000000000000001',
    '18446744073709551614',
    '18446744073709551615',
  ]) {
    const parsed = parseParentCreationTime(value);
    assert.equal(typeof parsed, 'string');
    assert.equal(parsed, value, 'Keep every FILETIME tick, including adjacent values above 2^53');
  }
});

test('parent creation time rejects missing values and non-string identities rather than coercing them', () => {
  assert.throws(() => parseParentCreationTime(), TypeError);
  for (const value of [
    undefined, null, true, false,
    0, 1, Number.MAX_SAFE_INTEGER, 9007199254740992, NaN, Infinity,
    1n, 18446744073709551615n,
    [], ['1'], {}, new String('1'), Buffer.from('1'), Symbol('1'),
  ]) {
    assert.throws(() => parseParentCreationTime(value), TypeError);
  }
  let coerced = false;
  const value = { toString() { coerced = true; return '1'; } };
  assert.throws(() => parseParentCreationTime(value), TypeError);
  assert.equal(coerced, false, 'An identity must already be a string, not executable coercion');
});

test('parent creation time rejects noncanonical decimals, zero and uint64 overflow', () => {
  for (const value of [
    '', '0', '00', '01', '+1', '-1', '-0',
    ' 1', '1 ', '\t1', '1\t', '\n1', '1\n', '1\r\n', '1\u0000', '\u00a01',
    '1.0', '1e3', '0x1', '1_000', '١', '１',
    '18446744073709551616', '184467440737095516150',
    '9999999999999999999999999999999999999999',
    '0000000000000000000000000000000000000001',
  ]) {
    assert.throws(() => parseParentCreationTime(value), TypeError,
      `Reject invalid parent creation time ${JSON.stringify(value)}`);
  }
});
