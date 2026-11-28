import type { AppState } from '../lib/types';

type AlertIssueSource = Pick<AppState, 'media' | 'lookDefaults'> & Pick<AppState['config'], 'alerts'>;

/** Warn about media referenced by an alert that is no longer on disk. */
export function alertIssues(s: AlertIssueSource, type: string): string[] {
  const a = { ...(s.lookDefaults || {}), ...(s.alerts?.[type] || {}) } as Record<string, any>;
  const files = new Set((s.media || []).map(m => m.name));
  const out: string[] = [];
  if (['media', 'mixed'].includes(a.layout) && a.media && !files.has(a.media)) out.push(`falta ${a.media}`);
  if (a.sound && !['default', 'none'].includes(a.sound) && !files.has(a.sound)) out.push(`falta ${a.sound}`);
  for (const v of a.variations || []) {
    const o = v.overrides || {};
    if (o.media && !files.has(o.media)) out.push(`«${v.name}»: falta ${o.media}`);
    if (o.sound && !['default', 'none'].includes(o.sound) && !files.has(o.sound)) out.push(`«${v.name}»: falta ${o.sound}`);
  }
  return out;
}
export const alertWarnings = (s: AlertIssueSource & Pick<AppState, 'types'>) => (s?.types ? Object.keys(s.types).filter(t => alertIssues(s, t).length) : []);
