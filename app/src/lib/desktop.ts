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

// Actualizaciones (plugin updater de Tauri): solo en la app. El plugin se carga bajo demanda para que
// el panel en el navegador no lo descargue. La firma se comprueba al descargar con la clave pública
// de tauri.conf.json; si no coincide, no se instala.
export type AppUpdate = { version: string; notes: string; install: (onProgress: (p: number | null) => void) => Promise<void> };
export async function checkUpdate(): Promise<AppUpdate | null> {
  if (!isDesktop()) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body || '',
    install: async onProgress => {
      let total = 0, done = 0;
      await update.downloadAndInstall(ev => {
        if (ev.event === 'Started') total = ev.data.contentLength || 0;
        else if (ev.event === 'Progress') done += ev.data.chunkLength;
        onProgress(total ? Math.min(1, done / total) : null);
      });
      // en Windows el instalador cierra la app y la vuelve a abrir; en el resto se reinicia aquí
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}
