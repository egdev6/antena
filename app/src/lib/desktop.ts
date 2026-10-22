// Puente con la app de escritorio (Tauri). En un navegador normal todo esto devuelve null y la UI lo oculta.
declare global { interface Window { __TAURI__?: any } }

export const isDesktop = () => !!window.__TAURI__?.core?.invoke;

export async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isDesktop()) return null;
  return window.__TAURI__.core.invoke(cmd, args);
}

export type Monitor = { name: string; width: number; height: number; x: number; y: number; scale: number; primary: boolean; prompterLike: boolean };
export const listMonitors = () => invoke<Monitor[]>('monitors');
export const openPrompter = (monitor?: string | null, fullscreen = true) => invoke('open_prompter', { monitor: monitor || null, fullscreen });
export const openTeleprompter = (monitor?: string | null, fullscreen = true) => invoke('open_teleprompter', { monitor: monitor || null, fullscreen });
export const openDock = (alwaysOnTop = true) => invoke('open_dock', { alwaysOnTop });
export const desktopInfo = () => invoke<{ port: number; managed: boolean; dataDir: string; version: string }>('desktop_info');
