// Apariencia: un solo tema para todo lo que sale en pantalla (overlay de alertas, widgets y créditos).
// El de serie es el de EGDEV; aquí se sobrescribe. Se guarda solo (src/theme.mjs) y llega en vivo a Meld.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { del, get, post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { copy, cx, guard, PfIcon, ScaledFrame, Sec, Seg, Switch, toast } from '../../lib/ui';
import type { Theme, ThemeInfo } from '../../lib/types';
import { draftChanged, registerDraft, useManualSave } from '../../lib/draft';
import { PageHead, SaveBar, usePageTab } from '../../lib/layout';

const SAMPLES: [string, string][] = [['follow', 'Seguidor'], ['sub', 'Suscripción'], ['cheer', 'Bits'], ['raid', 'Raid'], ['superchat', 'Super Chat'], ['viewers', 'Récord']];
const WIDGETS: { id: string; label: string; src: string; w: number; h: number }[] = [
  { id: 'alert', label: 'Alerta', src: '/overlay?preview', w: 1920, h: 1080 },
  { id: 'chat', label: 'Chat', src: '/widget/chat?demo', w: 600, h: 700 },
  { id: 'goal', label: 'Objetivo', src: '/widget/goal?demo', w: 1000, h: 300 },
  { id: 'latest', label: 'Últimos', src: '/widget/latest?demo', w: 1400, h: 220 },
  { id: 'ticker', label: 'Ticker', src: '/widget/ticker?demo', w: 1920, h: 120 },
  { id: 'question', label: 'Pregunta', src: '/widget/question?demo', w: 1920, h: 1080 },
  { id: 'giveaway', label: 'Sorteo', src: '/widget/giveaway?demo', w: 1920, h: 1080 },
  { id: 'credits', label: 'Créditos', src: '/widget/credits?demo', w: 1920, h: 1080 },
];
// tipos de alerta a los que se les puede cambiar el icono, con su icono de serie
const ICON_TYPES: [string, string][] = [['follow', 'heart'], ['sub', 'star'], ['resub', 'star'], ['giftsub', 'gift'], ['cheer', 'gem'], ['raid', 'rocket'], ['redemption', 'spark'],
  ['superchat', 'coin'], ['supersticker', 'coin'], ['member', 'badge'], ['milestone', 'badge'], ['giftmember', 'gift'], ['viewers', 'twitch'], ['ytviewers', 'youtube'], ['command', 'spark']];
const ICON_LABEL: Record<string, string> = { heart: 'Corazón', star: 'Estrella', gift: 'Regalo', gem: 'Gema', rocket: 'Cohete', spark: 'Chispa', coin: 'Moneda', badge: 'Insignia', eye: 'Ojo', bell: 'Campana', fire: 'Fuego', trophy: 'Trofeo', crown: 'Corona', zap: 'Rayo', megaphone: 'Megáfono', music: 'Música', smile: 'Sonrisa', users: 'Personas', rocket2: 'Cohete 2', thumb: 'Pulgar' };

const TABS = ['color', 'tipografia', 'iconos', 'forma', 'sonido'];
const draftSrc = (src: string) => src + (src.includes('?') ? '&' : '?') + 'themeDraft';
export function Apariencia({ parts }: { parts: string[] }) {
  useManualSave();
  const [tab, setTab] = usePageTab(parts, 'apariencia', TABS);
  const info = useRef<ThemeInfo | null>(null);
  const [, setLoaded] = useState(0);
  const t = useLive(s => s.theme);
  const types = useLive(s => s.types);
  const [view, setView] = useState('alert');
  const [frameKey, setFrameKey] = useState(0);
  const pending = useRef<Partial<Theme>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = guard(async () => { info.current = await get<ThemeInfo>('/api/theme'); live.update(() => ({ theme: info.current!.theme })); setLoaded(x => x + 1); });
  // borrador: los cambios van a /api/theme/draft (solo lo ven las vistas previas con ?themeDraft); «Guardar» los aplica a Meld
  const sendDraft = () => { const p = pending.current; if (Object.keys(p).length) put('/api/theme/draft', p).catch(e => toast(e.message, true)); };
  const flush = async () => {
    clearTimeout(timer.current);
    const p = pending.current;
    if (!Object.keys(p).length) return;
    const d = await put<ThemeInfo>('/api/theme', p);
    pending.current = {}; info.current = d; live.update(() => ({ theme: d.theme })); draftChanged();
  };
  const discard = () => {
    clearTimeout(timer.current);
    if (!Object.keys(pending.current).length) return;
    pending.current = {}; if (info.current) live.update(() => ({ theme: info.current!.theme }));
    del('/api/theme/draft').catch(() => {}); draftChanged();
  };
  useEffect(() => { load(); return registerDraft('theme', { dirty: () => Object.keys(pending.current).length > 0, keys: () => Object.keys(pending.current), save: flush, discard }); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  // al abrir la pestaña de alertas sale una de ejemplo para ver el tema; igual que en el editor,
  // se dispara cuando el marco termina de cargar (onload), nunca antes: si el iframe tarda, el ejemplo no se pierde (#6)
  const viewRef = useRef(view); viewRef.current = view;
  const sampleFrame = useCallback((el: HTMLIFrameElement | null) => {
    if (el) el.onload = () => setTimeout(() => { if (viewRef.current === 'alert') post('/api/test', { type: 'follow', target: 'preview' }).catch(() => {}); }, 300);
  }, []);
  const set = (patch: Partial<Theme>) => {
    live.update(s => ({ theme: { ...(s.theme as Theme), ...patch, icons: patch.icons ? { ...(s.theme?.icons || {}), ...patch.icons } : s.theme?.icons || {} } }));
    pending.current = { ...pending.current, ...patch, ...(patch.icons ? { icons: { ...(pending.current.icons || {}), ...patch.icons } } : {}) };
    draftChanged();
    clearTimeout(timer.current); timer.current = setTimeout(sendDraft, 300);
  };
  // el punto de partida, la importación y la restauración mandan: se aplican y guardan al momento y
  // tiran el borrador; se cancela antes de pedirlos para que un envío del borrador en cola no los pise (#157, #164)
  const cancelPending = () => { clearTimeout(timer.current); timer.current = undefined; if (Object.keys(pending.current).length) { pending.current = {}; del('/api/theme/draft').catch(() => {}); draftChanged(); } };
  const replace = (d: ThemeInfo) => { cancelPending(); info.current = d; live.update(() => ({ theme: d.theme })); setFrameKey(k => k + 1); };
  const sample = (type: string) => guard(async () => { setView('alert'); await post('/api/test', { type, target: 'preview' }); })();
  if (!t || !info.current) return <p className="hint">Cargando la apariencia…</p>;
  const I = info.current;
  const fonts = I.fonts;
  const W = WIDGETS.find(w => w.id === view)!;
  const isDefault = JSON.stringify({ ...t, version: '' }) === JSON.stringify({ ...I.defaults, version: '' });

  const color = (k: keyof Theme, label: ReactNode, hint?: string) => <label className="ap-color" title={hint}>{label}
    <span className="row tight"><input type="color" value={String(t[k] || '#000000')} onChange={e => set({ [k]: e.target.value.toUpperCase() } as Partial<Theme>)} />
      <input className="mono" value={String(t[k] || '')} maxLength={7} onChange={e => { const v = e.target.value; if (/^#[0-9a-f]{6}$/i.test(v)) set({ [k]: v.toUpperCase() } as Partial<Theme>); }} /></span></label>;
  const range = (k: keyof Theme, label: string, min: number, max: number, step: number, unit: string) => {
    const v = Number(t[k]);
    return <label>{label} <span className="val">{v} {unit}</span>
      <input type="range" min={min} max={max} step={step} value={v} style={{ ['--v' as any]: ((v - min) / (max - min)) * 100 + '%' }} onChange={e => set({ [k]: Number(e.target.value) } as Partial<Theme>)} /></label>;
  };
  const sw = (k: keyof Theme, label: string) => <Switch checked={!!t[k]} onChange={x => set({ [k]: x } as Partial<Theme>)}>{label}</Switch>;
  const fontSel = (k: 'fontDisplay' | 'fontBody', label: string) => <label>{label}
    <select value={t[k]} onChange={e => set({ [k]: e.target.value })} style={{ fontFamily: fonts.find(f => f.id === t[k])?.css || undefined }}>
      {fonts.map(f => <option key={f.id} value={f.id} style={{ fontFamily: f.css || undefined }}>{f.label}</option>)}
    </select></label>;

  return <>
    <PageHead crumb="Ajustes" title="Apariencia"
      desc="Un solo tema para todo lo que sale en el directo: alertas, chat, objetivos, ticker, preguntas, sorteo, tier list y créditos. La vista previa cambia al momento; Meld, al guardar. El CSS propio de cada alerta o widget sigue ganando."
      tabs={[{ id: 'color', label: 'Color' }, { id: 'tipografia', label: 'Tipografía' }, { id: 'iconos', label: 'Iconos' }, { id: 'forma', label: 'Forma y posición' }, { id: 'sonido', label: 'Sonido' }]} tab={tab} onTab={setTab}
      actions={<>
        <label className="sr-only" htmlFor="ap-preset">Punto de partida</label>
        <select id="ap-preset" className="ap-preset" value="" onChange={e => { const id = e.target.value; if (!id) return; if (!confirm(`¿Empezar desde «${I.presets.find(p => p.id === id)?.label}»? Se sustituye el tema actual.`)) return; guard(async () => { cancelPending(); replace(await post<ThemeInfo>('/api/theme/preset', { id })); }, 'Tema aplicado')(); }}>
          <option value="">Punto de partida…</option>{I.presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => { const { version, ...rest } = t; void version; copy(JSON.stringify(rest, null, 2)); }}>Exportar</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => {
          const txt = prompt('Pega aquí el JSON de un tema exportado:'); if (!txt) return;
          let theme; try { theme = JSON.parse(txt); } catch { throw new Error('Ese texto no es un JSON válido'); }
          cancelPending();
          replace(await post<ThemeInfo>('/api/theme/import', { theme }));
        }, 'Tema importado')}>Importar</button>
        <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={isDefault} onClick={guard(async () => { if (!confirm('¿Volver al tema de serie de EGDEV?')) return; cancelPending(); replace(await post<ThemeInfo>('/api/theme/reset')); }, 'Tema de EGDEV restaurado')}>Restaurar EGDEV</button>
      </>} />
    <div className="cols ap">
      <div className="stack">
        {tab === 'color' && <Sec title="Color" id="ap-color">
          <div className="row3">{color('accent', 'Acento')}{color('accentSoft', 'Acento suave', 'Antetítulos y detalles')}{color('surface', 'Fondo de las tarjetas')}</div>
          <div className="row3">{color('text', 'Texto principal')}{color('textSoft', 'Texto secundario')}{color('muted', 'Texto apagado')}</div>
          <div className="lbl">Fondo<div className="field-ctl"><Seg wide value={t.surfaceStyle} onChange={v => set({ surfaceStyle: v })} options={[['gradient', 'Degradado'], ['solid', 'Sólido'], ['glass', 'Cristal']]} /></div></div>
          <div className="row2">{range('surfaceOpacity', 'Opacidad del fondo', 0, 100, 1, '%')}{range('glow', 'Intensidad del brillo', 0, 200, 5, '%')}</div>
          <div className="row2">
            <label>Borde
              <span className="row tight"><Switch checked={!t.border} onChange={x => set({ border: x ? '' : (t.accent) })}>Del acento</Switch>
                {t.border ? <input type="color" value={t.border} onChange={e => set({ border: e.target.value.toUpperCase() })} /> : null}</span></label>
            {range('borderWidth', 'Grosor del borde', 0, 8, 1, 'px')}
          </div>
          {sw('platformAccent', 'Acento de cada plataforma (Twitch y YouTube con su color)')}
          {t.platformAccent && <div className="row2">{color('twitchColor', <><PfIcon platform="twitch" /> Twitch</>)}{color('youtubeColor', <><PfIcon platform="youtube" /> YouTube</>)}</div>}
        </Sec>}

        {tab === 'tipografia' && <Sec title="Tipografía" id="ap-font" aside={<span className="hint">Sube tus fuentes (woff2, ttf…) en <a href="#/archivos">Archivos</a></span>}>
          <div className="row2">{fontSel('fontDisplay', 'Títulos y nombres')}{fontSel('fontBody', 'Textos')}</div>
          {range('textScale', 'Tamaño del texto de las alertas', 50, 200, 5, '%')}
          <div className="row2 switches">{sw('uppercase', 'Títulos en mayúsculas')}{sw('outline', 'Contorno negro (se lee sobre cualquier fondo)')}</div>
        </Sec>}

        {tab === 'iconos' && <Sec title="Iconos" id="ap-icons">
          <div className="row2">
            <div className="lbl">Trazo<div className="field-ctl"><Seg wide value={t.iconStroke} onChange={v => set({ iconStroke: v })} options={[['thin', 'Fino'], ['normal', 'Normal'], ['bold', 'Grueso']]} /></div></div>
            <div className="lbl">Casilla<div className="field-ctl"><Seg wide value={t.tileShape} onChange={v => set({ tileShape: v })} options={[['square', 'Cuadrada'], ['round', 'Redonda'], ['none', 'Sin casilla']]} /></div></div>
          </div>
          <div className="row2">{color('iconColor', 'Color del icono')}
            <div className="lbl">Etiqueta de plataforma<div className="field-ctl"><Seg wide value={t.platformBadge} onChange={v => set({ platformBadge: v })} options={[['text', 'Texto'], ['logo', 'Logo'], ['none', 'Ninguna']]} /></div></div>
          </div>
          <h3 className="subhead">Icono de cada alerta</h3>
          <div className="ap-icons">
            {ICON_TYPES.map(([type, def]) => {
              const cur = t.icons?.[type] || '';
              const kind = !cur ? 'default' : cur.startsWith('emoji:') ? 'emoji' : cur.startsWith('media:') ? 'media' : cur;
              return <div key={type} className="ap-icon-row">
                <span className="ap-icon-name">{type === 'viewers' ? 'Récord · Twitch' : type === 'ytviewers' ? 'Récord · YouTube' : types[type]?.label || (type === 'command' ? 'Comandos' : type)}</span>
                <select aria-label={`Icono de ${types[type]?.label || type}`} value={kind} onChange={e => {
                  const v = e.target.value;
                  set({ icons: { [type]: v === 'default' ? null : v === 'emoji' ? 'emoji:🎉' : v === 'media' ? (I.images[0] ? 'media:' + I.images[0] : null) : v } as any });
                  if (v === 'media' && !I.images.length) toast('Sube antes una imagen en Archivos', true);
                }}>
                  <option value="default">De serie ({ICON_LABEL[def] || (def === 'twitch' ? 'logo de Twitch' : def === 'youtube' ? 'logo de YouTube' : def)})</option>
                  {I.icons.map(ic => <option key={ic} value={ic}>{ICON_LABEL[ic] || ic}</option>)}
                  <option value="logo">Logo de su plataforma</option>
                  <option value="emoji">Emoji…</option>
                  <option value="media">Imagen de media/…</option>
                  <option value="none">Sin icono</option>
                </select>
                {kind === 'emoji' && <input aria-label="Emoji" className="ap-emoji" value={cur.slice(6)} maxLength={8} onChange={e => e.target.value && set({ icons: { [type]: 'emoji:' + e.target.value } as any })} />}
                {kind === 'media' && <select aria-label="Imagen" value={cur.slice(6)} onChange={e => set({ icons: { [type]: 'media:' + e.target.value } as any })}>{I.images.map(n => <option key={n} value={n}>{n}</option>)}</select>}
              </div>;
            })}
          </div>
        </Sec>}

        {tab === 'forma' && <Sec title="Forma y efectos" id="ap-shape">
          <div className="row3">{range('round', 'Esquinas', 0, 300, 10, '%')}{range('alertWidth', 'Ancho de la alerta', 400, 1600, 20, 'px')}{range('alertScale', 'Escala de la alerta', 30, 200, 5, '%')}</div>
          <div className="row2 switches">{sw('tilt', 'Inclinación 3D')}{sw('reflection', 'Reflejo debajo')}{sw('decorations', 'Decoraciones (halo, puntos y cubo)')}{sw('timerBar', 'Barra de tiempo')}</div>
        </Sec>}

        {tab === 'forma' && <Sec title="Posición y movimiento" id="ap-pos">
          <div className="row2">
            <div className="lbl">Altura<div className="field-ctl"><Seg wide value={t.position} onChange={v => set({ position: v })} options={[['top', 'Arriba'], ['center', 'Centro'], ['bottom', 'Abajo']]} /></div></div>
            <div className="lbl">Lado<div className="field-ctl"><Seg wide value={t.align} onChange={v => set({ align: v })} options={[['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']]} /></div></div>
          </div>
          <div className="row2">{range('offsetX', 'Ajuste horizontal', -960, 960, 10, 'px')}{range('offsetY', 'Ajuste vertical', -540, 540, 10, 'px')}</div>
          <div className="lbl">Entrada y salida de las alertas<div className="field-ctl"><Seg wide value={t.animation} onChange={v => set({ animation: v })} options={[['3d', 'Giro 3D'], ['slide', 'Deslizar'], ['fade', 'Fundido'], ['pop', 'Rebote'], ['none', 'Sin animación']]} /></div></div>
          <p className="hint">La posición vale para el overlay de alertas; si en Meld usas <code>/overlay?pos=top</code>, manda la URL.</p>
        </Sec>}

        {tab === 'sonido' && <Sec title="Sonido" id="ap-sound">
          <div className="row2">
            <label>Sonido de serie de las alertas
              <select value={t.sound} onChange={e => set({ sound: e.target.value })}>
                <option value="default">El tono EGDEV</option><option value="none">Ninguno</option>
                {I.sounds.map(n => <option key={n} value={n}>{n}</option>)}
              </select></label>
            {range('soundVolume', 'Volumen de las alertas', 0, 200, 5, '%')}
          </div>
          <p className="hint">Lo usan las alertas que tienen «Sonido de serie»; las que tienen su propio sonido lo conservan.</p>
        </Sec>}
      </div>

      <div className="stack ap-preview">
        <figure className="eg-stage">
          <figcaption className="eg-stage__bar"><span className="eg-eyebrow">Vista previa</span><span className="eg-stage__spacer" /><span className="hint">{isDefault ? 'Tema de EGDEV' : 'Tema propio'}</span></figcaption>
          <div className="ap-tabs" role="tablist" aria-label="Qué ver">
            {WIDGETS.map(w => <button key={w.id} type="button" role="tab" aria-selected={view === w.id} className={cx('eg-chip', view === w.id && 'is-on')} onClick={() => setView(w.id)}>{w.label}</button>)}
          </div>
          <ScaledFrame key={W.id + frameKey} src={draftSrc(W.src)} w={W.w} h={W.h} className="preview wprev" title={`Vista previa: ${W.label}`} frameRef={sampleFrame} />
          {view === 'alert' && <div className="eg-stage__bar ap-samples">
            {SAMPLES.map(([type, label]) => <button key={type} type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => sample(type)}>{label}</button>)}
          </div>}
        </figure>
        <p className="hint">{view === 'alert' ? 'Las alertas de ejemplo salen solo aquí. Para verlas en Meld, usa «Probar en el directo» en cada alerta.' : 'Con datos de ejemplo. Al guardar, el tema llega a la vez a todas las capas que tengas en Meld.'}</p>
      </div>
    </div>
    <SaveBar />
  </>;
}
