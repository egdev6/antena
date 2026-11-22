// Shared saved-theme projection and live switch action for panel and dock.
import { useEffect, useState, type CSSProperties } from 'react';
import { get, post } from './api';
import { confirmLeave, isSaving } from './draft';
import { useLive } from './live';
import { toast } from './ui';
import type { SavedThemeSummary, Theme } from './types';

export type ThemeLook = {
  theme: Theme;
  alert: { title?: string; text?: string; sub?: string; layout?: string; textColor?: string; accentColor?: string; fontSize?: number };
  goal: { title?: string; showMetric?: boolean; visible?: boolean };
  chat: { fontSize?: number; layout?: string; showPlatform?: boolean; reverse?: boolean };
};

export function useThemes() {
  const saved = useLive(s => s?.config?.themes?.saved);
  const activeId = useLive(s => s?.config?.themes?.activeId);
  const theme = useLive(s => s?.theme);
  const alerts = useLive(s => s?.config?.alerts);
  const widgets = useLive(s => s?.config?.widgets);
  const [looks, setLooks] = useState<Record<string, ThemeLook>>({});
  useEffect(() => {
    let current = true;
    if (!saved) return;
    // Each request is tied to this snapshot; an older response cannot win a selection/switch race.
    Promise.all(saved.map(async item => {
      try { return [item.id, (await get<{ look: ThemeLook }>(`/api/themes/${encodeURIComponent(item.id)}/look`)).look] as const; }
      catch { return [item.id, undefined] as const; }
    })).then(entries => { if (current) setLooks(Object.fromEntries(entries.filter((x): x is readonly [string, ThemeLook] => !!x[1]))); });
    return () => { current = false; };
  }, [saved, activeId, theme, alerts, widgets]);
  return { themes: saved || [], activeId, looks };
}

export async function activateTheme(theme: SavedThemeSummary) {
  if (theme.active) return;
  if (isSaving()) { toast('Espera a que termine el guardado antes de cambiar de tema', true); return; }
  if (!confirmLeave()) return;
  await post(`/api/themes/${encodeURIComponent(theme.id)}/activate`);
  toast(`${theme.name} activado · se aplica al momento en pantalla`);
}

export function ThemeSwatch({ color }: { color?: string }) {
  return <span className="theme-swatch" aria-hidden="true" style={{ background: color || 'var(--color-primitive-red-neon)' } as CSSProperties} />;
}
