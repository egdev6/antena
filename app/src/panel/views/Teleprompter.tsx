// Teleprompter (lienzo «antena — Rediseño» › Teleprompter): guion por bloques que avanza solo.
// La vista previa es el propio /widget/teleprompter (?embed) escalado: lo que ves aquí es lo que sale en la ventana.
import { useEffect, useState } from 'react';
import { del, enc, post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { confirmDelete, copy, cx, guard, Icon, IconBtn, ItemTabs, LazyInput, mmss, ScaledFrame, Sec, Seg, Switch } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { isDesktop, listMonitors, openTeleprompter, type Monitor } from '../../lib/desktop';
import type { TeleprompterState, TpBlock, TpCompiled, TpCompiledBlock } from '../../lib/types';
import { origin } from './Widgets';

const PREV = '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>';
const NEXT = '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>';
const KEYS: Record<string, string> = { ' ': 'toggle', ArrowUp: 'faster', ArrowDown: 'slower', ArrowLeft: 'prev', ArrowRight: 'next', Home: 'reset' };

const control = (action: string, arg?: unknown) => post<TeleprompterState>('/api/teleprompter/control', { action, arg }).then(d => live.update(() => ({ teleprompter: d })));
const settings = (patch: Record<string, unknown>) => put<TeleprompterState>('/api/teleprompter/settings', patch).then(d => live.update(() => ({ teleprompter: d })));
const saveScript = (sc: TpCompiled, patch: { title?: string; blocks?: Array<TpBlock | TpCompiledBlock> }) => put<TeleprompterState>(`/api/teleprompter/scripts/${enc(String(sc.id))}`, { title: patch.title ?? sc.title, blocks: patch.blocks ?? sc.blocks }).then(d => live.update(() => ({ teleprompter: d })));

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

export function Teleprompter() {
  const tp = useLive(s => s.teleprompter);
  const [editing, setEditing] = useState<string | null>(null);
  const [where, setWhere] = useState<'window' | 'meld'>('window');
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
  const editId = editing && script?.blocks.some(b => b.id === editing) ? editing : script?.blocks[cur]?.id || script?.blocks[0]?.id || null;
  const editIdx = script ? script.blocks.findIndex(b => b.id === editId) : -1;
  const edit = editIdx >= 0 ? script!.blocks[editIdx] : null;
  const url = origin() + '/widget/teleprompter';

  const setBlock = (id: string, patch: Partial<TpBlock>) => {
    guard(() => saveScript(script!, { blocks: script!.blocks.map(b => (b.id === id ? { ...b, ...patch } : b)) }))();
  };
  const moveBlock = (i: number, d: number) => {
    const blocks = [...script!.blocks]; const [b] = blocks.splice(i, 1); blocks.splice(i + d, 0, b);
    return saveScript(script!, { blocks });
  };
  const addBlock = guard(async () => {
    const id = 'b' + Date.now().toString(36);
    await saveScript(script!, { blocks: [...script!.blocks, { id, title: `Bloque ${script!.blocks.length + 1}`, text: '' }] });
    setEditing(id);
  });
  const pickScript = guard(async (id: string) => {
    const d = await post<TeleprompterState>('/api/teleprompter/select', { id }); live.update(() => ({ teleprompter: d })); setEditing(null);
  });
  const newScript = guard(async () => {
    const d = await post<TeleprompterState>('/api/teleprompter/scripts', { title: 'Nuevo guion' }); live.update(() => ({ teleprompter: d })); setEditing(null);
  });
  const openWindow = guard(async () => {
    if (desk) await openTeleprompter(st.monitor || null, true);
    else window.open('/widget/teleprompter', 'egdev-teleprompter', 'popup,width=1280,height=720');
  });
  const playBtn = (cls: string) => <button type="button" className={cls} onClick={guard(() => control('toggle'))}>
    <Icon d={pb.playing ? IC.pause : IC.play} className="eg-btn__icon" />{pb.playing ? 'Parar' : 'Empezar'}</button>;

  return <>
    <header className="view-head">
      <div><span className="crumb">Widgets › Teleprompter · solo lo ves tú</span><h1>Teleprompter</h1></div>
      <div className="actions">
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={openWindow}><Icon d={IC.external} className="eg-btn__icon" />Abrir en ventana</button>
        {playBtn('eg-btn eg-btn--primary eg-btn--sm')}
      </div>
    </header>
    <ItemTabs label="Guiones" items={tp.scripts.map(s => ({ id: s.id, label: s.title }))} selected={tp.activeId} onSelect={id => { if (id !== tp.activeId) pickScript(id); }} onNew={newScript} newLabel="+ Nuevo guion" />
    <div className="cols cols--q tp">
      <div className="stack">
        <figure className="eg-stage">
          <figcaption className="eg-stage__bar"><span className="eg-eyebrow" style={{ margin: 0 }}>Vista del teleprompter</span><span className="eg-stage__spacer" /><span aria-live="polite">{status}</span></figcaption>
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
        </figure>

        {script && <Sec flat title="Guion" id="h-guion" aside={<span className="hint">{mmss(sc.total / st.wpm * 60)} a {st.wpm} palabras/min</span>}>
          <div className="row tight">
            <label className="sr-only" htmlFor="tp-title">Título del guion</label>
            <LazyInput id="tp-title" className="grow" style={{ margin: 0 }} value={script.title} onCommit={v => guard(() => saveScript(script, { title: v }))()} />
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={tp.scripts.length < 2} title={tp.scripts.length < 2 ? 'Es el único guion' : undefined} onClick={guard(async () => {
              if (!confirmDelete(script.title, 'este guion')) return;
              const d = await del<TeleprompterState>(`/api/teleprompter/scripts/${enc(String(script.id))}`); live.update(() => ({ teleprompter: d })); setEditing(null);
            })}>Borrar guion</button>
          </div>
          <div className="rows">
            {script.blocks.map((b, i) => {
              const info = sc.blocks[i];
              return <article key={b.id} className={cx('eg-post eg-post--row', i === cur && 'is-active', b.id === editId && 'tp-editing')}>
                <div className="eg-post__content"><b>{b.title || `Bloque ${i + 1}`}</b><span className="eg-post__meta">{info?.words ?? 0} palabras · {mmss((info?.words ?? 0) / st.wpm * 60)}{i === cur ? ' · leyendo' : ''}</span></div>
                <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => control('block', b.id))}>Ir</button>
                <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" aria-pressed={b.id === editId} onClick={() => setEditing(b.id)}>Editar</button>
                <IconBtn icon={IC.up} label="Subir" disabled={i === 0} onClick={guard(() => moveBlock(i, -1))} />
                <IconBtn icon={IC.down} label="Bajar" disabled={i === script.blocks.length - 1} onClick={guard(() => moveBlock(i, 1))} />
                <IconBtn icon={IC.x} label="Quitar bloque" disabled={script.blocks.length < 2} onClick={guard(async () => {
                  if (b.text.trim() && !confirm(b.title?.trim() ? `¿Quitar «${b.title.trim()}»?` : '¿Quitar este bloque?')) return;
                  await saveScript(script, { blocks: script.blocks.filter(x => x.id !== b.id) });
                })} />
              </article>;
            })}
          </div>
          <div><button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={addBlock}><Icon d={IC.plus} className="eg-btn__icon" />Añadir bloque</button></div>
          {edit && <div className="tp-edit" key={edit.id}>
            <label>Bloque {editIdx + 1} · título <LazyInput value={edit.title} onCommit={v => setBlock(edit.id, { title: v })} /></label>
            <label>Texto <LazyInput as="textarea" className="tp-prose" spellCheck value={edit.text} onCommit={v => setBlock(edit.id, { text: v })} placeholder="Escribe aquí lo que vas a decir. Una línea en blanco separa párrafos." /></label>
            <p className="hint">Lo que va entre [corchetes] sale en amarillo y no se lee en voz alta: son notas para ti.</p>
          </div>}
        </Sec>}
      </div>

      <div className="stack">
        <section className="eg-module-card eg-module-card--banded tp-card" aria-labelledby="h-lec">
          <div className="eg-module-card__head"><h2 id="h-lec" className="eg-module-card__name">Lectura</h2><Switch checked={st.mirror} onChange={x => guard(() => settings({ mirror: x }))()}>Espejo</Switch></div>
          <div className="eg-module-card__body">
            <TpRange label="Velocidad" unit="palabras/min" value={st.wpm} min={80} max={220} step={10} onCommit={v => settings({ wpm: v })} />
            <TpRange label="Tamaño del texto" unit="px" value={st.size} min={18} max={44} step={2} onCommit={v => settings({ size: v })} />
            <Switch checked={st.line} onChange={x => guard(() => settings({ line: x }))()}>Línea de lectura</Switch>
            <Switch checked={st.pauseAtNotes} onChange={x => guard(() => settings({ pauseAtNotes: x }))()}>Pausar en los [corchetes]</Switch>
          </div>
          <div className="eg-module-card__foot">
            <label style={{ flex: '1 1 auto', margin: 0 }}>Cuenta atrás al empezar
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

        <Sec title="Dónde se ve" id="h-url">
          <Seg wide value={where} onChange={setWhere} options={[['window', 'Ventana propia'], ['meld', 'Capa de Meld']]} />
          {where === 'window' ? <>
            {desk && <label>Pantalla
              <select value={st.monitor || ''} onChange={e => guard(() => settings({ monitor: e.target.value }))()}>
                <option value="">La principal</option>
                {monitors.map(m => <option key={m.name} value={m.name}>{m.name} · {m.width}×{m.height}{m.primary ? ' · principal' : ''}</option>)}
              </select></label>}
            <div className="row tight"><button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={openWindow}><Icon d={IC.external} className="eg-btn__icon" />Abrir en ventana</button>
              <span className="hint">{desk ? 'Se abre a pantalla completa en esa pantalla; «La principal» es el monitor primario.' : 'Arrástrala al monitor de la cámara y pulsa F11.'}</span></div>
          </> : <div className="row tight"><label className="sr-only" htmlFor="tp-url">URL del teleprompter</label><input id="tp-url" className="grow mono" value={url} readOnly onFocus={e => e.target.select()} style={{ margin: 0 }} />
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(url)}>Copiar</button></div>}
          <div className="eg-notice eg-notice--info eg-notice--sm"><Icon d={IC.monitor} /><span className="eg-notice__text">No sale en el directo: ábrelo en el monitor que tienes junto a la cámara, o en una escena de Meld que no se emita.</span></div>
        </Sec>
      </div>
    </div>
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
