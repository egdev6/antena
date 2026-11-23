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

const PLATFORM_SWATCH = 'conic-gradient(var(--color-primitive-red-neon) 0 25%,var(--color-status-warning) 25% 50%,var(--color-status-success) 50% 75%,var(--color-status-info) 75%)';

export function ThemeAvatar({ theme, look, size = 20 }: { theme?: SavedThemeSummary; look?: { theme?: Pick<Theme, 'accent' | 'platformAccent'> }; size?: number }) {
  const avatar = theme?.avatar;
  const background = avatar?.color || (look?.theme?.platformAccent ? PLATFORM_SWATCH : look?.theme?.accent) || 'var(--color-primitive-red-neon)';
  return <span className="theme-avatar" aria-hidden="true" style={{ width: size, height: size, borderColor: avatar?.color || 'var(--color-border-control)' }}>
    <span className="theme-avatar__content" style={{ background }}>{avatar?.image && <img src={'/media/' + encodeURIComponent(avatar.image)} alt="" />}</span>
  </span>;
}

export function ThemeSwatch({ color }: { color?: string }) {
  return <span className="theme-swatch" aria-hidden="true" style={{ background: color || 'var(--color-primitive-red-neon)' } as CSSProperties} />;
}
