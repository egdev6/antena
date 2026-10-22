// Logos de plataforma (Twitch y YouTube) a color, con su viewBox original. Fuente única para los
// widgets (chat, objetivos) y para el panel React (app/src/lib/ui.tsx), que importa esta definición.
// Se construyen por DOM con rutas fijas: nunca entra marcado configurable.

/**
 * @typedef {{ viewBox: string, paths: [string, string][] }} PlatformLogo
 */

/** @type {Record<string, PlatformLogo>} */
export const LOGOS = {
  twitch: {
    viewBox: '0 0 2400 2800',
    paths: [
      ['#fff', 'm2200 1300-400 400h-400l-350 350v-350H600V200h1600z'],
      ['#9146ff', 'M500 0 0 500v1800h600v500l500-500h400l900-900V0H500zm1700 1300-400 400h-400l-350 350v-350H600V200h1600v1100z'],
      ['#9146ff', 'M1700 550h200v600h-200zm-550 0h200v600h-200z'],
    ],
  },
  youtube: {
    viewBox: '0 0 256 180',
    paths: [
      ['red', 'M250.346 28.075A32.18 32.18 0 0 0 227.69 5.418C207.824 0 127.87 0 127.87 0S47.912.164 28.046 5.582A32.18 32.18 0 0 0 5.39 28.24c-6.009 35.298-8.34 89.084.165 122.97a32.18 32.18 0 0 0 22.656 22.657c19.866 5.418 99.822 5.418 99.822 5.418s79.955 0 99.82-5.418a32.18 32.18 0 0 0 22.657-22.657c6.338-35.348 8.291-89.1-.164-123.134Z'],
      ['#FFF', 'm102.421 128.06 66.328-38.418-66.328-38.418z'],
    ],
  },
};

const NAMES = { twitch: 'Twitch', youtube: 'YouTube' };
export const PLATFORM_NAMES = NAMES;

/** <svg> del logo construido por DOM (twitch | youtube); otra plataforma → null. */
export function platformSvg(platform, cls = 'pf-ico') {
  const logo = LOGOS[platform];
  if (!logo) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', logo.viewBox);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', NAMES[platform]);
  if (cls) svg.setAttribute('class', cls);
  for (const [fill, d] of logo.paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', fill); p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
