// Cliente de la API local de antena (la misma que usan el MCP y el Stream Deck).
// Desde el móvil, la clave llega en ?key=… y se reenvía en cada petición.
const KEY = new URLSearchParams(location.search).get('key');
import type { UploadResult } from './types';
export const withKey = (p: string) => (KEY ? p + (p.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY) : p);

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(withKey(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d: unknown = await r.json().catch(() => ({}));
  const err = d && typeof d === 'object' && 'error' in d ? (d as { error?: unknown }).error : undefined;
  if (!r.ok) throw new Error(typeof err === 'string' && err ? err : `Error ${r.status}`);
  return d as T;
}
export const get = <T = unknown>(p: string) => api<T>('GET', p);
export const post = <T = unknown>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = unknown>(p: string, b: unknown = {}) => api<T>('PUT', p, b);
export const del = <T = unknown>(p: string) => api<T>('DELETE', p);
export const enc = encodeURIComponent;

/** Sube un archivo a media/ con progreso. */
export function upload(file: File, onProgress?: (p: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', withKey('/api/media/upload?name=' + enc(file.name)));
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let d: Partial<UploadResult> & { error?: string } = {};
      try { d = JSON.parse(xhr.responseText || '{}'); } catch { /* respuesta vacía o no JSON */ }
      if (xhr.status >= 400) reject(new Error(d.error || 'No se pudo subir')); else resolve(d as UploadResult);
    };
    xhr.onerror = () => reject(new Error('No se pudo subir'));
    xhr.send(file);
  });
}
