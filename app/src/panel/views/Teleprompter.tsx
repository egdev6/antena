// Teleprompter (lienzo «antena — Rediseño» › Teleprompter): guion por bloques que avanza solo.
// La vista previa es el propio /widget/teleprompter (?embed) escalado: lo que ves aquí es lo que sale en la ventana.
import { useEffect, useRef, useState } from 'react';
import { ManualDraft } from '../../lib/manual-draft';
import { del, enc, get, post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { BrowserSource, confirmDelete, cx, guard, Icon, IconBtn, ItemTabs, mmss, ScaledFrame, Sec, Switch, WidgetLayout } from '../../lib/ui';
import { IC, type IconData } from '../../lib/icons';
import { isDesktop, listMonitors, openTeleprompter, type Monitor } from '../../lib/desktop';
import type { TeleprompterState, TpBlock, TpCompiled } from '../../lib/types';
import { origin } from './Widgets';
import { isSaving, registerDraft, useDraftVersion, useManualSave } from '../../lib/draft';
import { Box, Dot, ListPanel, NameCell, PageHead, SaveBar, Slide, usePageTab } from '../../lib/layout';
import { go } from '../router';

const PREV: IconData = [['polygon', { points: '19 20 9 12 19 4 19 20' }], ['line', { x1: '5', x2: '5', y1: '19', y2: '5' }]];
const NEXT: IconData = [['polygon', { points: '5 4 15 12 5 20 5 4' }], ['line', { x1: '19', x2: '19', y1: '5', y2: '19' }]];
const KEYS: Record<string, string> = { ' ': 'toggle', ArrowUp: 'faster', ArrowDown: 'slower', ArrowLeft: 'prev', ArrowRight: 'next', Home: 'reset' };

const control = (action: string, arg?: unknown) => post<TeleprompterState>('/api/teleprompter/control', { action, arg }).then(d => live.update(() => ({ teleprompter: d })));
const settings = (patch: Record<string, unknown>) => put<TeleprompterState>('/api/teleprompter/settings', patch).then(d => live.update(() => ({ teleprompter: d })));

/** Reloj local corregido con la hora del servidor: para el «quedan» y el estado. */
function usePosition(tp?: TeleprompterState) {
  const [, tick] = useState(0);
  const playing = !!tp?.playback.playing;
  useEffect(() => { if (!playing) return; const h = setInterval(() => tick(x => x + 1), 500); return () => clearInterval(h); }, [playing]);
  if (!tp) return { pos: 0, countdown: 0 };
  const p = tp.playback;
  // el panel y el servidor comparten reloj (mismo PC); desde el móvil puede ir algo desfasado, solo afecta a este texto
  const now = Date.now();
  const pos = p.playing ? Math.min(tp.script.total, p.anchorWord + Math.max(0, now - p.anchorAt) / 60000 * tp.settings.wpm) : p.anchorWord;
  return { pos, countdown: p.playing ? Math.max(0, Math.ceil((p.anchorAt - now) / 1000)) : 0 };
}

export function Teleprompter({ parts }: { parts: string[] }) {
  const tp = useLive(s => s.teleprompter);
  const [tab, setTab] = usePageTab(parts, 'teleprompter', ['directo', 'guiones']);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const desk = isDesktop();
  useEffect(() => { if (desk) listMonitors().then(m => setMonitors(m ?? [])).catch(() => {}); }, [desk]);
  // atajos de teclado en la vista (no mientras escribes)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, select, [contenteditable], button')) return;
      const a = KEYS[e.key]; if (!a) return;
      e.preventDefault(); guard(() => control(a))();
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  const { pos, countdown } = usePosition(tp);
  if (!tp) return <p className="hint">Cargando el teleprompter…</p>;

  const st = tp.settings, sc = tp.script, pb = tp.playback;
  const script: TpCompiled | null = tp.activeId ? tp.script : null;
  let cur = 0; sc.blocks.forEach((b, i) => { if (b.start <= pos + 1e-6) cur = i; });
  const left = Math.max(0, sc.total - pos) / st.wpm * 60;
  const status = countdown ? `Empieza en ${countdown}` : pb.playing ? 'Avanzando' : pos >= sc.total && sc.total ? 'Terminado' : 'Parado';
  const url = origin() + '/widget/teleprompter';

  const pickScript = guard(async (id: string) => {
    const d = await post<TeleprompterState>('/api/teleprompter/select', { id }); live.update(() => ({ teleprompter: d }));
  });
  const newScript = () => go('#/teleprompter/guiones/nuevo');
  const openWindow = guard(async () => {
    if (desk) await openTeleprompter(st.monitor || null, true);
    else window.open('/widget/teleprompter', 'egdev-teleprompter', 'popup,width=1280,height=720');
  });
  const playBtn = (cls: string) => <button type="button" className={cls} onClick={guard(() => control('toggle'))}>
    <Icon d={pb.playing ? IC.pause : IC.play} className="eg-btn__icon" />{pb.playing ? 'Parar' : 'Empezar'}</button>;

  const tabs = [{ id: 'directo', label: 'En directo' }, { id: 'guiones', label: 'Guiones', count: tp.scripts.length }];
  if (tab === 'guiones') return <>
    <PageHead crumb="En directo · solo lo ves tú" title="Teleprompter" tabs={tabs} tab={tab} onTab={setTab}
      actions={<a className="eg-btn eg-btn--primary eg-btn--sm" href="#/teleprompter/guiones/nuevo">+ Nuevo guion</a>} />
    <ListPanel title="Guiones" note="El activo es el que sale en el teleprompter. Pulsa uno para editarlo."
      cols={[{ key: 'name', label: 'Guion' }, { key: 'state', label: 'Estado' }, { key: 'use', label: '' }]}
      rows={tp.scripts.map(x => { const href = `#/teleprompter/guiones/${enc(x.id)}`; return { id: x.id, href, open: parts[2] === x.id, cells: {
        name: <NameCell href={href} name={x.title} sub={x.id === tp.activeId ? `${sc.blocks.length} ${sc.blocks.length === 1 ? 'bloque' : 'bloques'} · ${mmss(sc.total / st.wpm * 60)} a ${st.wpm} palabras/min` : undefined} />,
        state: x.id === tp.activeId ? <Dot tone="ok">Activo</Dot> : <Dot tone="off">Guardado</Dot>,
        use: x.id === tp.activeId ? null : <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => pickScript(x.id)}>Usar</button>,
      } }; })} empty={<>No hay guiones. <a href="#/teleprompter/guiones/nuevo">Crear el primero</a></>} />
    {parts[2] === 'nuevo' ? <NuevoGuion /> : parts[2] && tp.scripts.some(x => x.id === parts[2]) ? <GuionSlide key={parts[2]} id={parts[2]} /> : null}
  </>;
  return <>
    <PageHead crumb="En directo · solo lo ves tú" title="Teleprompter" tabs={tabs} tab={tab} onTab={setTab}
      desc="El guion avanza por bloques a tu ritmo de lectura, en su propia ventana o en una capa de Meld que no se emite." actions={<>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={openWindow}><Icon d={IC.external} className="eg-btn__icon" />Abrir en ventana</button>
        {playBtn('eg-btn eg-btn--primary eg-btn--sm')}
      </>} />
    <ItemTabs label="Guiones" items={tp.scripts.map(s => ({ id: s.id, label: s.title }))} selected={tp.activeId} onSelect={id => { if (id !== tp.activeId) pickScript(id); }} onNew={newScript} newLabel="+ Nuevo guion" />
    <WidgetLayout className="tp"
      source={<BrowserSource url={url} size="1280×720" hint="En Meld: + › Browser, en una escena que no se emita." />}
      preview={<figure className="eg-stage">
          <figcaption className="eg-stage__bar"><span className="eg-eyebrow">En pantalla</span><span className="eg-stage__spacer" /><span aria-live="polite">{status}</span></figcaption>
          <ScaledFrame src="/widget/teleprompter?embed" w={1280} h={720} className="preview wprev tp-frame" title="Vista del teleprompter" />
          <div className="eg-stage__bar">
            <div role="toolbar" aria-label="Control del teleprompter" className="tp-tools">
              <IconBtn icon={IC.repeat} label="Volver al principio" onClick={guard(() => control('reset'))} />
              <IconBtn icon={PREV} label="Bloque anterior" onClick={guard(() => control('prev'))} />
              <IconBtn icon={pb.playing ? IC.pause : IC.play} label={pb.playing ? 'Parar' : 'Empezar'} pressed={pb.playing} onClick={guard(() => control('toggle'))} />
              <IconBtn icon={NEXT} label="Bloque siguiente" onClick={guard(() => control('next'))} />
            </div>
            <span className="eg-stage__spacer" />
            <span className="mono tp-left">{sc.blocks.length ? `Bloque ${cur + 1} de ${sc.blocks.length} · quedan ${mmss(left)}` : 'Sin bloques'}</span>
          </div>
        </figure>}>

        {script && <Sec flat title={<>Guion · {script.title}</>} id="h-guion" aside={<><span className="hint">{mmss(sc.total / st.wpm * 60)} a {st.wpm} palabras/min</span><a className="eg-btn eg-btn--ghost eg-btn--sm" href={`#/teleprompter/guiones/${enc(String(script.id))}`}>Editar guion</a></>}>
          <div className="rows">
            {script.blocks.map((b, i) => <article key={b.id} className={cx('eg-post eg-post--row', i === cur && 'is-active')}>
              <div className="eg-post__content"><b>{b.title || `Bloque ${i + 1}`}</b><span className="eg-post__meta">{b.words ?? 0} palabras · {mmss((b.words ?? 0) / st.wpm * 60)}{i === cur ? ' · leyendo' : ''}</span></div>
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => control('block', b.id))}>Ir</button>
            </article>)}
          </div>
        </Sec>}

        <section className="eg-module-card eg-module-card--banded tp-card" aria-labelledby="h-lec">
          <div className="eg-module-card__head"><h2 id="h-lec" className="eg-module-card__name">Lectura</h2><Switch checked={st.mirror} onChange={x => guard(() => settings({ mirror: x }))()}>Espejo</Switch></div>
          <div className="eg-module-card__body">
            <TpRange label="Velocidad" unit="palabras/min" value={st.wpm} min={80} max={220} step={10} onCommit={v => settings({ wpm: v })} />
            <TpRange label="Tamaño del texto" unit="px" value={st.size} min={18} max={44} step={2} onCommit={v => settings({ size: v })} />
            <Switch checked={st.line} onChange={x => guard(() => settings({ line: x }))()}>Línea de lectura</Switch>
            <Switch checked={st.pauseAtNotes} onChange={x => guard(() => settings({ pauseAtNotes: x }))()}>Pausar en los [corchetes]</Switch>
          </div>
          <div className="eg-module-card__foot">
            <label className="grow">Cuenta atrás al empezar
              <select value={st.countdownSec} onChange={e => guard(() => settings({ countdownSec: Number(e.target.value) }))()}>
                <option value={3}>3 segundos</option><option value={0}>Sin cuenta atrás</option><option value={5}>5 segundos</option>
              </select></label>
          </div>
        </section>

        <Sec title="Manejo" id="h-ctl">
          <table className="eg-table eg-table--compact">
            <caption className="sr-only">Atajos del teleprompter</caption>
            <tbody>
              <tr><th scope="row">Empezar o parar</th><td><kbd className="eg-kbd">Espacio</kbd></td></tr>
              <tr><th scope="row">Más rápido / más lento</th><td><kbd className="eg-kbd">↑</kbd> <kbd className="eg-kbd">↓</kbd></td></tr>
              <tr><th scope="row">Bloque anterior / siguiente</th><td><kbd className="eg-kbd">←</kbd> <kbd className="eg-kbd">→</kbd></td></tr>
              <tr><th scope="row">Volver al principio</th><td><kbd className="eg-kbd">Inicio</kbd></td></tr>
            </tbody>
          </table>
          <p className="hint">Funcionan aquí y en la ventana del teleprompter. En el Stream Deck: <code>/sd/teleprompter</code>, <code>/sd/teleprompter-siguiente</code>, <code>/sd/teleprompter-anterior</code> y <code>/sd/teleprompter-inicio</code>.</p>
        </Sec>

        <Sec title="Ventana propia" id="h-url">
          {desk && <label>Pantalla
            <select value={st.monitor || ''} onChange={e => guard(() => settings({ monitor: e.target.value }))()}>
              <option value="">La principal</option>
              {monitors.map(m => <option key={m.name} value={m.name}>{m.name} · {m.width}×{m.height}{m.primary ? ' · principal' : ''}</option>)}
            </select></label>}
          <div className="row tight"><button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={openWindow}><Icon d={IC.external} className="eg-btn__icon" />Abrir en ventana</button>
            <span className="hint">{desk ? 'Se abre a pantalla completa en esa pantalla; «La principal» es el monitor primario.' : 'Arrástrala al monitor de la cámara y pulsa F11.'}</span></div>
          <div className="eg-notice eg-notice--info eg-notice--sm"><Icon d={IC.monitor} /><span className="eg-notice__text">No sale en el directo: ábrelo en el monitor que tienes junto a la cámara, o en una escena de Meld que no se emita.</span></div>
        </Sec>
    </WidgetLayout>
  </>;
}

/** Deslizador que se mueve suelto y guarda al soltar (no manda una petición por píxel). */
function TpRange({ label, unit, value, min, max, step, onCommit }: { label: string; unit: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => Promise<unknown> }) {
  const [v, setV] = useState(value);
  const [drag, setDrag] = useState(false);
  useEffect(() => { if (!drag) setV(value); }, [value, drag]);
  const commit = () => { setDrag(false); if (v !== value) guard(() => onCommit(v))(); };
  return <label>{label} <span className="val">{v} {unit}</span>
    <input type="range" min={min} max={max} step={step} value={v} style={{ ['--v' as any]: ((v - min) / (max - min)) * 100 + '%' }}
      onPointerDown={() => setDrag(true)} onChange={e => setV(Number(e.target.value))}
      onPointerUp={commit} onKeyUp={commit} onBlur={() => drag && commit()} /></label>;
}

// ---------- guiones (v2): listado → slide con guardado manual ----------
type GuionDraft = { title: string; blocks: TpBlock[] };
function NuevoGuion() {
  const [title, setTitle] = useState('');
  const create = guard(async () => {
    const d = await post<TeleprompterState & { script: { id: string } }>('/api/teleprompter/scripts', { title: title.trim() || 'Nuevo guion' });
    live.update(() => ({ teleprompter: d }));
    go(`#/teleprompter/guiones/${enc(d.activeId || d.scripts.at(-1)!.id)}`);
  });
  return <Slide crumb={<><a href="#/teleprompter/guiones">Guiones</a> › Nuevo</>} title="Nuevo guion" back="#/teleprompter/guiones"
    tabs={[{ id: 'min', label: 'Lo mínimo' }, { id: 'rest', label: 'Bloques, al crear', locked: true }]} tab="min" onTab={() => {}}
    foot={<footer className="lv-sfoot sticky"><span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/teleprompter/guiones">Cancelar</a><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={create}>Crear guion</button></footer>}>
    <Box title="Lo mínimo"><label>Título <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} placeholder="Directo · Agent Teams" /></label>
      <p className="hint">Se crea con un bloque vacío y pasa a ser el guion activo del teleprompter.</p></Box>
  </Slide>;
}
function GuionSlide({ id }: { id: string }) {
  useManualSave();
  useDraftVersion();
  const activeId = useLive(s => s.teleprompter?.activeId);
  const n = useLive(s => s.teleprompter?.scripts.length || 0);
  const [saved, setSaved] = useState<GuionDraft | null>(null);
  const [d, setD] = useState<GuionDraft | null>(null);
  const savedRef = useRef(saved); savedRef.current = saved;
  const mounted = useRef(true);
  const [buffer] = useState(() => new ManualDraft<Partial<GuionDraft>, GuionDraft>({
    empty: () => ({}), merge: (older, newer) => ({ ...older, ...newer }),
    take: () => savedRef.current!, keys: () => ['guion'],
    persist: async patch => {
      const state = await put<TeleprompterState>(`/api/teleprompter/scripts/${enc(id)}`, patch);
      if (mounted.current) live.update(() => ({ teleprompter: state }));
      // The returned active script can be a different entity. Read this saved script.
      return (await get<{ script: GuionDraft }>(`/api/teleprompter/scripts/${enc(id)}`)).script;
    },
    publish: (baseline, newer) => { savedRef.current = baseline; setSaved(baseline); setD(Object.keys(newer).length ? { ...baseline, ...newer } : null); },
    restore: baseline => { setSaved(baseline); setD(null); },
  }));
  useEffect(() => {
    let active = true;
    guard(async () => {
      const result = await get<{ script: GuionDraft }>(`/api/teleprompter/scripts/${enc(id)}`);
      if (active) { savedRef.current = result.script; setSaved(result.script); }
    })();
    const unregister = registerDraft('guion:' + id, buffer);
    return () => { active = false; mounted.current = false; unregister(); buffer.dispose(); };
  }, [buffer, id]);
  if (!saved) return <Slide crumb={<a href="#/teleprompter/guiones">Guiones</a>} title="Cargando…" back="#/teleprompter/guiones"><p className="hint">Cargando el guion…</p></Slide>;
  const cur = d || saved;
  const set = (patch: Partial<GuionDraft>) => { buffer.push(patch); setD({ ...cur, ...patch }); };
  const setBlock = (i: number, patch: Partial<TpBlock>) => set({ blocks: cur.blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const move = (i: number, dd: number) => { const blocks = [...cur.blocks]; const [b] = blocks.splice(i, 1); blocks.splice(i + dd, 0, b); set({ blocks }); };
  const words = cur.blocks.reduce((t, b) => t + (b.text.match(/[^\s[\]]+/g) || []).length, 0);
  return <Slide crumb={<><a href="#/teleprompter/guiones">Guiones</a> › {activeId === id ? 'Activo' : 'Guardado'}</>} wide back="#/teleprompter/guiones"
    title={<input className="lv-title-input" aria-label="Título del guion" value={cur.title} onChange={e => set({ title: e.target.value })} />}
    head={<div className="lv-shead-actions"><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving() || n < 2} title={n < 2 ? 'Es el único guion' : undefined} onClick={guard(async () => {
      if (isSaving() || !confirmDelete(saved.title, 'este guion')) return; buffer.discard(); go('#/teleprompter/guiones');
      const r = await del<TeleprompterState>(`/api/teleprompter/scripts/${enc(id)}`); live.update(() => ({ teleprompter: r }));
    })}>Borrar guion…</button>{activeId === id ? null : <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={isSaving()} onClick={guard(async () => { if (isSaving()) return; const r = await post<TeleprompterState>('/api/teleprompter/select', { id }); live.update(() => ({ teleprompter: r })); }, 'Guion activo')}>Usar en el teleprompter</button>}</div>}
    foot={<SaveBar />}>
    <div className="lv-cols aside">
      <div className="lv-col">{cur.blocks.map((b, i) => <Box key={b.id} title={<>Bloque {i + 1}</>} aside={<div className="row tight">
        <IconBtn icon={IC.up} label="Subir" disabled={i === 0} onClick={() => move(i, -1)} />
        <IconBtn icon={IC.down} label="Bajar" disabled={i === cur.blocks.length - 1} onClick={() => move(i, 1)} />
        <IconBtn icon={IC.x} label="Quitar bloque" disabled={cur.blocks.length < 2} onClick={() => { if (b.text.trim() && !confirm(b.title?.trim() ? `¿Quitar «${b.title.trim()}»?` : '¿Quitar este bloque?')) return; set({ blocks: cur.blocks.filter((_, j) => j !== i) }); }} /></div>}>
        <label>Título <input value={b.title} onChange={e => setBlock(i, { title: e.target.value })} /></label>
        <label>Texto <textarea className="tp-prose" spellCheck value={b.text} onChange={e => setBlock(i, { text: e.target.value })} placeholder="Escribe aquí lo que vas a decir. Una línea en blanco separa párrafos." /></label>
      </Box>)}
        <div><button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={() => set({ blocks: [...cur.blocks, { id: 'b' + Date.now().toString(36), title: `Bloque ${cur.blocks.length + 1}`, text: '' }] })}><Icon d={IC.plus} className="eg-btn__icon" />Añadir bloque</button></div>
      </div>
      <aside className="lv-col"><Box title="Notas"><p className="hint">Lo que va entre [corchetes] sale en amarillo y no se lee: son notas para ti. Los cambios llegan al teleprompter al pulsar Guardar.</p><p className="hint">{words} palabras · {cur.blocks.length} {cur.blocks.length === 1 ? 'bloque' : 'bloques'}</p></Box></aside>
    </div>
  </Slide>;
}
