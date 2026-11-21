// Custom chat CSS runs after the widget styles, so it can silently undo the horizontal layout:
// the widget sizes the row, each card and the font to fit the browser source height. This
// detects the declarations that override that sizing, to warn in the editor (never to block).

const ROOT_PROPS = new Set([
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'inset', 'top', 'right', 'bottom', 'left', 'padding', 'padding-top', 'padding-bottom',
  'flex-direction', 'flex-wrap', 'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image',
]);
const MSG_PROPS = new Set([
  'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'width', 'min-width', 'max-width',
  'height', 'min-height', 'max-height', 'font', 'font-size', 'line-height',
  'padding', 'padding-top', 'padding-bottom',
]);

/** Which element a selector styles: only its last compound counts (`.msg .who` styles `.who`). */
function target(selector: string): 'root' | 'msg' | null {
  if (selector.includes('::')) return null; // pseudo-elements do not take part in the layout
  const last = selector.trim().split(/[\s>+~]+/).pop() || '';
  if (/\.root(?![\w-])/.test(last)) return 'root';
  if (/\.msg(?![\w-])/.test(last)) return 'msg';
  return null;
}

/**
 * Declarations in `css` that override the horizontal layout, as `.root { width }` labels in
 * order of appearance, each reported once. Rules inside @media count; @keyframes do not match.
 */
export function horizontalCssWarnings(css: unknown): string[] {
  if (typeof css !== 'string' || !css.trim()) return [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const targets = new Set(selectors.split(',').map(target).filter(Boolean) as ('root' | 'msg')[]);
    if (!targets.size) continue;
    const props = body.split(';').map(d => d.split(':')[0].trim().toLowerCase()).filter(Boolean);
    for (const t of ['root', 'msg'] as const) {
      if (!targets.has(t)) continue;
      for (const prop of props) {
        const label = `.${t} { ${prop} }`;
        if ((t === 'root' ? ROOT_PROPS : MSG_PROPS).has(prop) && !found.includes(label)) found.push(label);
      }
    }
  }
  return found;
}
