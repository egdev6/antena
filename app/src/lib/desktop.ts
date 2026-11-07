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
export type PanelWindows = { dock: boolean; prompter: boolean; teleprompter: 'closed' | 'floating' | 'screen' };
export const panelWindows = () => invoke<PanelWindows>('panel_windows');
export const closePanelWindow = (label: 'prompter' | 'teleprompter') => invoke<void>('close_panel_window', { label });
export async function onPanelWindowsChange(callback: () => void): Promise<() => void> {
  if (!isDesktop() || !window.__TAURI__?.event?.listen) return () => {};
  return window.__TAURI__.event.listen('antena://panel-windows', callback);
}
export const desktopInfo = () => invoke<{ port: number; managed: boolean; dataDir: string; version: string }>('desktop_info');

// Actualizaciones: las buscan e instalan los comandos de la app (update_check, update_install), que
// comprueban la firma con la clave pública de tauri.conf.json y apagan el servidor antes de que corra
// el instalador. En el navegador no existen y la UI solo enlaza las releases.
export type AppUpdate = { version: string; notes: string; install: (onProgress: (p: number | null) => void) => Promise<void> };
export async function checkUpdate(): Promise<AppUpdate | null> {
  const found = await invoke<{ version: string; notes: string } | null>('update_check');
  if (!found) return null;
  return {
    ...found,
    install: async onProgress => {
      const off = await window.__TAURI__?.event?.listen?.('antena://update-progress', (e: { payload: { progress: number | null } }) => onProgress(e.payload.progress));
      try { await invoke('update_install'); } finally { off?.(); }
    },
  };
}
