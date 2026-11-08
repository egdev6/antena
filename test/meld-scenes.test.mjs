import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMeldScenes } from '../app/src/lib/meld-scenes.ts';

const scene = (id, name, current = false) => ({ id, name, current, layers: [] });
const summarize = scenes => groupMeldScenes(scenes).map(({ scene, vertical, format, air }) => [scene.id, vertical?.id || null, format, air]);

test('shared scene grouping uses the exact suffix and preserves order, unpaired scenes and live state', () => {
  assert.deepEqual(summarize([]), []);
  assert.deepEqual(summarize([
    scene('v', 'Camera [Vertical]', true), scene('h', 'Camera', true),
    scene('soloH', 'Solo H'), scene('soloV', 'Solo V [Vertical]'),
    scene('similar', 'Name [Vertical] extra'), scene('nested', 'Camera [Vertical] [Vertical]'),
    scene('lower', 'Camera [vertical]'), scene('noSpace', 'Camera[Vertical]'),
  ]), [
    ['h', 'v', 'H + V', 'H + V'], ['soloH', null, 'H', ''], ['soloV', null, 'V', ''],
    ['similar', null, 'H', ''], ['nested', null, 'V', ''], ['lower', null, 'H', ''], ['noSpace', null, 'H', ''],
  ]);
  for (const [h, v, air] of [[true, false, 'H'], [false, true, 'V'], [false, false, '']]) {
    assert.deepEqual(summarize([scene('h', 'Camera', h), scene('v', 'Camera [Vertical]', v)]), [['h', 'v', 'H + V', air]]);
  }
  assert.deepEqual(summarize([scene('v', 'Solo [Vertical]', true)]), [['v', null, 'V', 'V']]);
});
