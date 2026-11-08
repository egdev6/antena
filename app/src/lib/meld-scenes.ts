import type { MeldScene } from './types';

const VERTICAL_SUFFIX = ' [Vertical]';
const isVertical = (name: string) => name.endsWith(VERTICAL_SUFFIX);

export function groupMeldScenes(scenes: MeldScene[]) {
  const horizontal = scenes.filter(scene => !isVertical(scene.name));
  return scenes.filter(scene => !isVertical(scene.name) || !horizontal.some(h => h.name + VERTICAL_SUFFIX === scene.name))
    .map(scene => {
      const vertical = isVertical(scene.name) ? undefined : scenes.find(v => v.name === scene.name + VERTICAL_SUFFIX);
      const h = !isVertical(scene.name) && !!scene.current;
      const v = !!(vertical?.current || (isVertical(scene.name) && scene.current));
      const format = isVertical(scene.name) ? 'V' : vertical ? 'H + V' : 'H';
      const air = h && v ? 'H + V' : h ? 'H' : v ? 'V' : '';
      return { scene, vertical, format, air };
    });
}
