// #126: el resumen conserva Europe/Madrid, no la zona del proceso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function summaries(tz) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Session } from './src/session.mjs';
    const stamps = ['2026-01-02T23:00:00Z', '2026-07-02T22:00:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '', 'no-es-fecha', null];
    const result = stamps.map(startedAt => {
      const data = { ...Session.fresh('Sintético'), startedAt };
      if (startedAt === stamps[0]) {
        data.endedAt = '2026-01-02T23:01:05Z';
        data.notes = [{ id: 'n', kind: 'marker', at: '2026-01-02T23:00:07Z', label: 'Marca' }];
      }
      const before = JSON.stringify(data);
      const md = Session.prototype.summaryMarkdown.call(Object.create(Session.prototype), data);
      return { md, unchanged: before === JSON.stringify(data) };
    });
    console.log(JSON.stringify(result));
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('resumen: ceros, medianoche, DST y zona Madrid sin alterar ISO ni duraciones', () => {
  const utc = summaries('UTC');
  assert.deepEqual(summaries('America/Los_Angeles'), utc);
  const expected = ['03/01/2026 00:00 · duración 1:05', '03/07/2026 00:00', '29/03/2026 01:59', '29/03/2026 03:00', '', '', ''];
  utc.forEach(({ md, unchanged }, i) => {
    assert.equal(md.split('\n')[2], expected[i]);
    assert.ok(unchanged, 'formatear no modifica los datos persistidos');
    assert.doesNotMatch(md, /Invalid Date|NaN/);
  });
  assert.match(utc[0].md, /`0:07` Marca/);
});
