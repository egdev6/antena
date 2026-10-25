import { useEffect, useState } from 'react';
import { confirmLeave } from '../lib/draft';

// Direcciones antiguas (v1) → nuevas (v2, listado → slide). Los enlaces viejos siguen valiendo.
const REDIRECTS: [RegExp, string][] = [
  [/^alerta\/(.+)$/, 'alertas/$1'],
  [/^comando\/(.+)$/, 'comandos/$1'],
  [/^mensaje\/(.+)$/, 'mensajes/$1'],
  [/^widget\/questions$/, 'preguntas'],
  [/^widget\/tierlist$/, 'tierlist'],
  [/^widget\/giveaway$/, 'sorteo'],
  [/^widget\/teleprompter$/, 'teleprompter'],
  [/^widget\/(chat|latest|credits)$/, 'widgets/$1'],
  [/^widget\/goals$/, 'widgets/objetivos'],
  [/^widgets\/goal-(.+)$/, 'widgets/objetivos/$1'],
  [/^widgets\/nuevo$/, 'widgets/objetivos/nuevo'],
];
const fix = (h: string) => { for (const [re, to] of REDIRECTS) if (re.test(h)) return h.replace(re, to); return h; };
const read = () => fix((location.hash || '#/directo').slice(2)).split('/').map(decodeURIComponent);

let current = location.hash || '#/directo';
export function useHash(): string[] {
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      // cambios sin guardar: se pregunta antes de salir (y se vuelve a donde estaba si no)
      if (location.hash !== current && !confirmLeave()) { history.replaceState(null, '', current); return; }
      const before = current.split('/').slice(0, 2).join('/');
      current = location.hash || '#/directo';
      setParts(read());
      // abrir o cerrar un slide no mueve el scroll del listado
      if (current.split('/').slice(0, 2).join('/') !== before) window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}
export const go = (h: string) => { location.hash = h; };
