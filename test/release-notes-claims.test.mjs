import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPushExport } from '../src/push-export.mjs';

const notes = readFileSync(new URL('../docs/releases/v0.14.0.md', import.meta.url), 'utf8');
const push = notes.split('\n').find(line => line.includes('ANTENA_PUSH_URL')) || '';
const anonymous = notes.split('\n').filter(line => /an[oó]nim/i.test(line)).join('\n');
const make = url => createPushExport({ config: { url, token: 'synthetic-token' } });

test('S3: push instructions do not claim the required token is optional', () => {
  assert.throws(() => createPushExport({ config: { url: 'http://127.0.0.1:4311/x' } }),
    { message: 'El token del receptor no es válido.' });
  assert.doesNotMatch(push, /si hace falta[^\n]*ANTENA_PUSH_TOKEN/i);
  assert.match(push, /ANTENA_PUSH_TOKEN/);
});

test('S3: push instructions identify supported loopback addresses', () => {
  assert.throws(() => make('http://localhost:4311/x'), { message: 'La URL del receptor no es válida.' });
  assert.equal(make('http://127.0.0.1:4311/x').status().enabled, true);
  assert.equal(make('http://[::1]:4311/x').status().enabled, true);
  assert.match(push, /127\.0\.0\.1|\[::1\]/);
});

test('S3: push mentions that only automatic Meld sessions are exported', () => {
  assert.match(push, /(?:autom[aá]tic[^\n]{0,40}Meld|Meld[^\n]{0,40}autom[aá]tic)/i);
});

test('S3: push distinguishes bounded retries from permanent errors', () => {
  assert.match(push, /temporales|transitorios|algunos|408|429|5xx/i);
  assert.match(push, /limitad|m[aá]ximo|hasta|cinco|\b5\b/i);
});

test('S3: anonymous YouTube counts are described as estimates', () => {
  assert.match(anonymous, /estim|aproximad|no[^\n]{0,20}exact/i);
});

test('S3: limitations disclose that platform results can be incomplete', () => {
  assert.match(notes, /limitad|l[ií]mite|incomplet/i);
});

test('S3: notes link separately to a technical changelog', () => {
  assert.match(notes, /\[[^\]]*(?:cambios|t[eé]cnic|changelog)[^\]]*\]\([^)]*(?:compare|changelog)[^)]*\)/i);
});
