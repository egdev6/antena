import { useEffect, useState } from 'react';

export function useHash(): string[] {
  const read = () => (location.hash || '#/directo').slice(2).split('/').map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => { setParts(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}
export const go = (h: string) => { location.hash = h; };
