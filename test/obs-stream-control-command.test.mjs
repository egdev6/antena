import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObsAdapter } from '../src/programs/obs-adapter.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
test('OBS command emits controlCommand for the six control commands before the RPC, like Meld', { timeout: 10000 }, async t => {
  const fake = fakeObs(); await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
  const program = new ObsAdapter({ retryDelays: [] });
  t.after(async () => { await program.quiesceClose(); await fake.close(); });
  program.start(`ws://127.0.0.1:${fake.server.address().port}`);
  for (let i = 0; i < 300 && program.status.state !== 'conectado'; i++) await delay(10);
  const seen = [];
  program.on('controlCommand', c => seen.push([c, fake.requests.filter(r => /(Stream|Record)$/.test(r.requestType)).length]));
  const commands = ['meld.startStreamingAction', 'meld.stopStreamingAction', 'meld.toggleStreamingAction',
    'meld.startRecordingAction', 'meld.stopRecordingAction', 'meld.toggleRecordingAction'];
  for (const command of commands) assert.equal(await program.command(command), undefined);
  assert.throws(() => program.command('meld.unknownAction'), { message: 'Acción todavía no disponible con OBS.' });
  assert.deepEqual(seen, commands.map((command, index) => [command, index]));
  assert.deepEqual(fake.requests.filter(r => /(Stream|Record)$/.test(r.requestType)).map(r => r.requestType),
    ['StartStream', 'StopStream', 'ToggleStream', 'StartRecord', 'StopRecord', 'ToggleRecord']);
});
