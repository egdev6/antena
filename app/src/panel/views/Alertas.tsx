// Alertas (v3): los tipos fijos en tarjetas por plataforma → slide con pestañas (Editor). Las variaciones abren un 2.º nivel.
import { useState, type ReactNode } from 'react';
import { enc, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { EmptyState, guard, Icon, PfIcon } from '../../lib/ui';
import { IC, type IconData } from '../../lib/icons';
import { Card, CardGroup, CardSwitch, Dot, Kpis, MediaPreview, PageHead, Tags, useListFilter } from '../../lib/layout';
import type { AppState } from '../../lib/types';
import { Editor } from './Editor';

// Icono de cada tipo en la miniatura (los de serie de la app; el tema puede cambiarlos en el overlay).
const ALERT_ICON: Record<string, IconData> = { heart: IC.heart, star: IC.star, gift: IC.gift, spark: IC.sparkle, gem: IC.sparkle, rocket: IC.sparkle, coin: IC.star, badge: IC.star };

/** Avisos de una alerta: archivo que ya no está en media/ (vídeo, imagen o sonido). */
export function alertIssues(s: AppState, type: string): string[] {
  const a = { ...(s.lookDefaults || {}), ...(s.config.alerts?.[type] || {}) } as Record<string, any>;
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
export const alertWarnings = (s: AppState) => (s?.types ? Object.keys(s.types).filter(t => alertIssues(s, t).length) : []);

const isVid = (f?: string) => /\.(webm|mp4|mov|m4v)$/i.test(f || '');
const GROUPS: [string, string, string][] = [
  ['twitch', 'Twitch', 'Seguidores, subs, bits, raids, recompensas y récord'],
  ['youtube', 'YouTube', 'Super Chats, stickers, miembros y récord'],
];

/** Miniatura del diseño de una alerta: la tarjeta en pequeño, el primer fotograma o el fondo con la tarjeta encima. */
function AlertThumb({ a, label, issue, accent, playing, icon }: { a: Record<string, any>; label: string; issue?: string; accent: string; playing: boolean; icon?: ReactNode }) {
  const layout = ['media', 'mixed'].includes(a.layout) && a.media ? a.layout : 'card';
  const mini = <span className="lv-mini" style={{ ['--mini-accent' as any]: accent }}><span className="ic">{icon}</span><span><span className="k">{a.title || label}</span><span className="nm">{SAMPLE_NAME}</span></span></span>;
  if (issue) return <span className="missing"><Icon d={IC.alert} /><span>{issue[0].toUpperCase() + issue.slice(1)}</span></span>;
  if (layout === 'card') return mini;
  const src = '/media/' + enc(a.media);
  return <>
    <MediaPreview src={src} video={isVid(a.media)} playing={playing} label={layout === 'mixed' ? 'fondo + tarjeta' : 'vídeo'} />
    {layout === 'mixed' ? mini : <span className="lv-mini-txt"><small>{a.title || label}</small>{SAMPLE_NAME}</span>}
  </>;
}
const SAMPLE_NAME = 'midudev';
const DESIGN: Record<string, string> = { card: 'tarjeta', media: 'vídeo con texto', mixed: 'vídeo + tarjeta' };

export function Alertas({ parts }: { parts: string[] }) {
  const s = useLive(x => x);
  const f = useListFilter();
  const [hover, setHover] = useState<string | null>(null);
  const [, open, sub, vid] = parts;
  const types = Object.entries(s.types || {});
  const cfg = (t: string) => ({ ...(s.lookDefaults || {}), ...(s.config.alerts?.[t] || {}) }) as Record<string, any>;
  const accent = (s as any).theme?.accent || '#FF0036';
  const all = types.map(([type, meta]) => {
    const a = cfg(type), issues = alertIssues(s, type), vars = a.variations || [];
    return { type, meta, a, issues, vars };
  });
  // el interruptor de la tarjeta se aplica al momento (como activar una variación)
  const toggle = (type: string, on: boolean) => guard(async () => {
    live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts?.[type], enabled: on } } } }));
    try { await put('/api/alerts/' + enc(type), { enabled: on }); }
    catch (e) { live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts?.[type], enabled: !on } } } })); throw e; }
  }, on ? 'Alerta activada' : 'Alerta apagada')();
  const shown = all
    .filter(x => f.chip === 'all' || (f.chip === 'warn' ? x.issues.length > 0 : x.meta.platform === f.chip))
    .filter(x => f.match(x.meta.label, x.type));
  const n = (fn: (x: typeof all[number]) => boolean) => all.filter(fn).length;
  const nVars = all.reduce((t, x) => t + x.vars.length, 0), nVarsOn = all.reduce((t, x) => t + x.vars.filter((v: any) => v.enabled !== false).length, 0);
  const nWarn = n(x => x.issues.length > 0);
  const nTw = n(x => x.meta.platform === 'twitch'), nYt = n(x => x.meta.platform === 'youtube');
  const card = (x: typeof all[number]) => {
    const href = `#/alertas/${x.type}`;
    const on = x.a.enabled !== false;
    const layout = ['media', 'mixed'].includes(x.a.layout) && x.a.media ? x.a.layout : 'card';
    const tags = [
      ...(x.a.ttsEnabled ? [{ t: 'Voz', on: true }] : []),
      ...((x.a.actions || []).length ? [{ t: 'Acciones', on: true }] : []),
      ...(x.vars.length ? [{ t: x.vars.length === 1 ? '1 variación' : `${x.vars.length} variaciones`, on: true }] : []),
      ...(x.meta.system ? [{ t: 'Récord' }] : []),
    ];
    const icoName = (s as any).theme?.icons?.[x.type];
    return <Card key={x.type} href={href} label={`Abrir ${x.meta.label}`} open={open === x.type} off={!on} warn={x.issues.length > 0}
      onEnter={() => setHover(x.type)} onLeave={() => setHover(h => (h === x.type ? null : h))}
      thumb={<AlertThumb a={x.a} label={x.meta.label} issue={x.issues[0]} accent={accent} playing={hover === x.type} icon={icoName === 'logo' || x.meta.system ? <PfIcon platform={x.meta.platform} /> : <Icon d={ALERT_ICON[x.meta.icon] || IC.star} />} />}
      title={x.meta.label} aside={<span className="lv-mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><PfIcon platform={x.meta.platform} />{x.meta.platform === 'youtube' ? 'YouTube' : 'Twitch'}</span>}
      foot={<><span className="lv-cmeta">{DESIGN[layout]}</span><span className="sp" /><CardSwitch checked={on} onChange={v => toggle(x.type, v)} label={`Activar ${x.meta.label}`} /></>}>
      {x.issues.length ? <Dot tone="warn">{x.issues.length === 1 ? 'Falta un archivo' : `Faltan ${x.issues.length} archivos`}</Dot> : <Dot tone={on ? 'ok' : 'off'}>{on ? 'Activa' : 'Apagada'}</Dot>}
      {tags.length ? <Tags items={tags} /> : null}
    </Card>;
  };
  return <>
    <PageHead crumb={`Configurar · ${all.length} alertas de Twitch y YouTube`} title="Alertas"
      desc="Pulsa una para editarla por pestañas. Los tipos son fijos: lo nuevo se crea como variación dentro de cada alerta."
      actions={<a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/apariencia">Tema en Apariencia</a>} />
    <Kpis items={[
      { value: n(x => x.a.enabled !== false), label: `activas de ${all.length}` },
      { value: n(x => ['media', 'mixed'].includes(x.a.layout) && !!x.a.media), label: 'con vídeo o imagen propios' },
      { value: nVars, label: `variaciones · ${nVarsOn} activas` },
      { value: nWarn, label: nWarn === 1 ? 'con un archivo que ya no está en media/' : 'con archivos que ya no están en media/', warn: nWarn > 0 },
    ]} />
    <div className="lv-tools lv-tools--bare">
      <label className="lv-search"><span className="sr-only">Buscar alerta</span><input type="search" value={f.q} placeholder="Buscar alerta" onChange={e => f.setQ(e.target.value)} /></label>
      <div className="lv-chips" role="group" aria-label="Filtrar">{([['all', `Todas · ${all.length}`], ['twitch', `Twitch · ${nTw}`], ['youtube', `YouTube · ${nYt}`], ['warn', `Con avisos · ${nWarn}`]] as [string, string][]).map(([k, l]) =>
        <button key={k} type="button" className="eg-chip" aria-pressed={f.chip === k} onClick={() => f.setChip(k)}>{l}</button>)}</div>
    </div>
    <div className="lv-groups">
      {GROUPS.map(([pf, title, note]) => {
        const list = shown.filter(x => x.meta.platform === pf);
        return list.length ? <CardGroup key={pf} title={title} count={list.length} note={note}>{list.map(card)}</CardGroup> : null;
      })}
      {!shown.length && <div className="lv-empty"><EmptyState>Ninguna alerta coincide.</EmptyState></div>}
    </div>
    {open && s.types?.[open] && (sub === 'v' && vid
      ? <Editor key={`v-${open}-${vid}`} target={{ kind: 'variation', type: open, id: vid }} />
      : <Editor key={`a-${open}`} target={{ kind: 'alert', type: open }} />)}
  </>;
}
