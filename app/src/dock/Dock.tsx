// Dock del directo: todo el manejo del directo menos la vista previa (S1) y sin chat (S12).
// En una ventana apaisada y ancha se ven las tres columnas Escenas | Audio | Control; en el
// resto (estrecha, retrato, tablet vertical) una pestaña por sección, con Control primero.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { enc, post } from '../lib/api';
import { IC } from '../lib/icons';
import { live, useLive, useLiveVersion } from '../lib/live';
import { patchIx } from '../lib/patch';
import { ConnPill, cx, guard, Icon, mmss, toast, Toaster } from '../lib/ui';
import type { MeldTrack, ShortcutConfig, TeleprompterState, TimelineItem } from '../lib/types';
import { stepText } from '../panel/views/Atajos';

const DOCK_TAB = 'egdev.dock.tab';
/** La misma regla que documenta el README: apaisado y ≥1000 px de ancho → tres columnas. */
const WIDE_MEDIA = '(orientation: landscape) and (min-width: 1000px)';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}

/** Forma de la ventana: tres columnas solo en apaisado ancho (S6/S8). matchMedia se ocupa de la
 *  orientación y del ancho; el listener de resize cubre motores que no emiten «change» al
 *  redimensionar la ventana de Tauri. */
function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_MEDIA).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_MEDIA);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    return () => { mq.removeEventListener('change', sync); window.removeEventListener('resize', sync); };
  }, []);
  return wide;
}

function Status({ wide }: { wide: boolean }) {
  const s = useLive(x => x);
  const now = useNow();
  const tl = live.timeline;
  const st = s.status, meldOn = st.meld?.state === 'conectado', streaming = !!st.meld?.streaming;
  const tracks = s.meld?.session?.tracks || [];
  const want = (s.config.prompter?.micTrack || '').toLowerCase();
  const mic = want ? tracks.find(t => t.name.toLowerCase() === want) : tracks.find(t => /mic/i.test(t.name));
  const pause = st.pause || {};
  return <header className="d-top">
    <div className={cx('d-live', streaming && 'on')}><i />{streaming ? 'En directo' : meldOn ? 'Sin emitir' : 'Sesión'}<b>{tl.startedAt ? mmss((now - +new Date(tl.startedAt)) / 1000) : ''}</b></div>
    <div className="d-warns">
      {mic?.muted && <span className="d-warn big">🎙 Micro silenciado</span>}
      {pause.paused && <span className="d-warn">Alertas en pausa{pause.held ? ` · ${pause.held}` : ''}</span>}
      {!meldOn && <ConnPill platform="meld" state={st.meld?.state} />}
      {st.overlays === 0 && <span className="d-warn soft">Sin overlay</span>}
      {st.twitch && st.twitch.state !== 'conectado' && <ConnPill platform="twitch" state={st.twitch.state} />}
      {st.youtube?.state === 'en espera' && <ConnPill platform="youtube" state="en espera" label={st.youtube.notice || undefined} />}
    </div>
    {wide && <a className="d-open" href="/" target="_blank" rel="noopener" title="Abrir el panel completo">Panel ↗</a>}
  </header>;
}

// ---------- Escenas (S9) ----------
const isVertical = (name: string) => /\[vertical\]\s*$/i.test(String(name || '').trim());

function Scenes() {
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const meldOn = useLive(s => s.status.meld?.state === 'conectado');
  const [busy, setBusy] = useState<string | null>(null);
  if (!meldOn) return <p className="d-muted d-empty">Meld no está conectado. Conéctalo en Meld Studio y sus escenas aparecerán aquí.</p>;
  if (!scenes.length) return <p className="d-muted d-empty">Meld todavía no informa de ninguna escena.</p>;
  const vertical = scenes.filter(x => isVertical(x.name));
  const horizontal = scenes.filter(x => !isVertical(x.name));
  // Sin escenas verticales hay un solo grupo, sin encabezados que lo partan (S9).
  const groups = vertical.length ? [{ title: 'Horizontal', list: horizontal }, { title: 'Vertical', list: vertical }] : [{ title: '', list: scenes }];
  const show = (id: string) => guard(async () => {
    setBusy(id);
    try { const r = await post<{ scene: string }>('/api/meld/scene', { scene: id }); toast(`Escena «${r.scene}»`); }
    finally { setBusy(null); }
  })();
  return <div className="d-groups">{groups.map(g => {
    const air = g.list.find(x => x.current);
    return <section className="d-group" key={g.title || 'todas'} aria-label={g.title || 'Escenas'}>
      {g.title ? <h3 className="d-sub">{g.title}{air ? <span>al aire: {air.name}</span> : null}</h3> : null}
      <div className="d-scenes">{g.list.map(sc => <button key={sc.id} type="button"
        className={cx('d-btn d-scene', sc.current && 'on', busy === sc.id && 'busy')}
        aria-pressed={!!sc.current} title={sc.name} onClick={() => show(sc.id)}>
        <span className="d-scene-n">{sc.name}</span>
        {sc.current ? <span className="d-air">AL AIRE</span> : null}
      </button>)}</div>
    </section>;
  })}</div>;
}

// ---------- Audio (S10) ----------

const isKnownGain = (gain: unknown): gain is number => typeof gain === 'number' && Number.isFinite(gain);

function TrackRow({ t }: { t: MeldTrack }) {
  const muted = !!t.muted;
  const gain = isKnownGain(t.gain) ? t.gain : null;
  const [drag, setDrag] = useState<number | null>(null);
  const lastSent = useRef(0);
  const queued = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // En cuanto el volumen que confirma Meld coincide con el que se arrastró, manda el servidor.
  useEffect(() => { if (drag !== null && gain !== null && Math.round(gain * 100) === drag) setDrag(null); }, [gain, drag]);
  // Arrastrar manda como mucho una orden cada 150 ms, con el último valor (S10).
  const send = (pct: number) => {
    const wait = 150 - (Date.now() - lastSent.current);
    if (wait <= 0) {
      lastSent.current = Date.now();
      guard(() => post('/api/meld/track', { track: t.id, action: 'gain', gain: pct / 100 }))();
      return;
    }
    queued.current = pct;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const value = queued.current; queued.current = null;
      if (value === null) return;
      lastSent.current = Date.now();
      guard(() => post('/api/meld/track', { track: t.id, action: 'gain', gain: value / 100 }))();
    }, wait);
  };
  const unknown = gain === null;
  const value = drag ?? (unknown ? 0 : Math.round(gain * 100));
  return <div className={cx('d-trk', muted && 'off')}>
    <button type="button" className="d-sw" role="switch" aria-checked={!muted}
      aria-label={`${muted ? 'Activar' : 'Desactivar'} ${t.name}`} title={`${muted ? 'Activar' : 'Desactivar'} ${t.name}`}
      onClick={guard(() => post('/api/meld/track', { track: t.id, action: 'mute' }))} />
    <span className="d-trk-n" title={t.name}>{t.name}</span>
    <span className="d-trk-v" aria-hidden="true">{unknown ? '—' : `${value}%`}</span>
    <input className="d-trk-f" type="range" min={0} max={100} step={1} value={value} disabled={unknown}
      title={unknown ? 'Volumen desconocido: Meld no lo informa de esta pista' : `Volumen de ${t.name}`}
      aria-label={`Volumen de ${t.name}`}
      onChange={e => { const v = Number(e.target.value); setDrag(v); send(v); }} />
  </div>;
}

function Audio() {
  const tracks = useLive(s => s.meld?.session?.tracks || []);
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const meldOn = useLive(s => s.status.meld?.state === 'conectado');
  if (!meldOn) return <p className="d-muted d-empty">Meld no está conectado: sin pistas que mezclar.</p>;
  if (!tracks.length) return <p className="d-muted d-empty">Meld todavía no informa de pistas de audio.</p>;
  const air = scenes.filter(x => x.current);
  const parents = new Set(air.map(x => x.id));
  const globals = tracks.filter(t => !t.parent);
  const onAir = tracks.filter(t => !!t.parent && parents.has(t.parent));
  return <div className="d-mixer">
    {globals.length ? <><h3 className="d-sub">Globales</h3>{globals.map(t => <TrackRow key={t.id} t={t} />)}</> : null}
    {onAir.length ? <><h3 className="d-sub">{`En esta escena · ${air.map(x => x.name).join(' · ')}`}</h3>{onAir.map(t => <TrackRow key={t.id} t={t} />)}</> : null}
  </div>;
}

// ---------- Control (S11) ----------
const sd = (a: string, ok?: string) => guard(() => post('/sd/' + a), ok);

function Control() {
  useLiveVersion(); // la cronología (pendientes) vive fuera del snapshot de /api/state
  const I = useLive(s => s.interactive);
  const pause = useLive(s => s.status.pause || {});
  const tp = useLive(s => s.teleprompter) as TeleprompterState | undefined;
  const credits = useLive(s => (s.widgets?.credits as { names?: string[] }[] | undefined) || []);
  const q = I?.questions;
  const qc = (I?.config?.questions || {}) as { enabled?: unknown; command?: unknown };
  const g = I?.giveaway;
  const vote = I?.vote;
  const pend = live.timeline.pending || 0;
  const names = credits.reduce((n, gr) => n + (gr.names?.length || 0), 0);
  const script = tp?.script;
  const hasScript = !!script && (script.blocks?.length || 0) > 0;
  const playing = !!tp?.playback?.playing;
  const block = tp?.playback?.block ?? 0;
  const tpAct = (action: string) => guard(() => post('/api/teleprompter/control', { action }))();
  return <>
    <div className="d-grid">
      <button className={cx('d-btn', pause.paused && 'on')} onClick={sd('pausa')} title={pause.paused ? 'Reanudar las alertas' : 'Pausar las alertas que lleguen'}>
        {pause.paused ? '▶ Reanudar' : '⏸ Pausar'}<small>alertas{pause.held ? ` · ${pause.held} en cola` : ''}</small></button>
      <button className="d-btn" onClick={sd('saltar', 'Saltada')} title="Quita la alerta que está en pantalla">⏭ Saltar<small>la alerta actual</small></button>
      <button className="d-btn pri" title="Marca este momento para un short"
        onClick={guard(async () => { const { marker } = await post<{ marker: TimelineItem }>('/api/markers', {}); toast(marker.twitchError ? `Marca local (Twitch: ${marker.twitchError})` : 'Marca creada'); })}>🎬 Marca<small>de short</small></button>
      <button className="d-btn" disabled={!pend} onClick={sd('agradecido')} title={pend ? `${pend} por agradecer` : 'Nada por agradecer todavía'}>✔ Agradecido<small>{pend} por agradecer</small></button>
    </div>

    {q && <section className="d-card" aria-label="Preguntas">
      <div className="d-card-h">
        <button type="button" className="d-sw" role="switch" aria-checked={!!qc.enabled} aria-label="Preguntas del chat"
          title={qc.enabled ? 'El comando del chat está activo' : 'El comando del chat está desactivado'}
          onClick={() => patchIx('questions', { enabled: !qc.enabled })} />
        Preguntas<span className="d-meta">{qc.command ? `${qc.command} · ` : ''}{q.pending || 0} en cola</span>
      </div>
      {q.current ? <p className="d-q"><b>{q.current.user}</b> {q.current.text}</p> : <p className="d-muted">Ninguna en pantalla</p>}
      <div className="d-row">
        <button className="d-btn sm grow" disabled={!q.pending} title={q.pending ? 'Pasa a la siguiente pregunta de la cola' : 'No hay preguntas en cola'}
          onClick={guard(() => post('/api/questions/next'))}>Siguiente</button>
        <button className="d-btn sm" disabled={!q.current} title={q.current ? 'Quita la pregunta de la pantalla' : 'No hay ninguna pregunta en pantalla'}
          onClick={guard(() => post('/api/questions/hide'), 'Pregunta oculta')}>Ocultar</button>
      </div>
    </section>}

    {vote && <section className="d-card" aria-label="Tier list">
      <div className="d-card-h">Tier list<span className="d-meta">{vote.item?.label ? `Votando ${vote.item.label} · ` : ''}{vote.total} votos</span></div>
      <div className="d-row">
        <button className="d-btn sm grow" onClick={guard(() => post('/api/vote/close', { apply: true }), 'Votación colocada')}>Cerrar y colocar</button>
        <button className="d-btn sm" onClick={guard(() => post('/api/vote/cancel'), 'Votación cancelada')}>Cancelar</button>
      </div>
    </section>}

    {g && <section className="d-card" aria-label="Sorteo">
      <div className="d-card-h">Sorteo<span className="d-meta">{g.open ? 'abierto' : 'cerrado'} · {g.count === 1 ? '1 participante' : `${g.count || 0} participantes`}</span></div>
      <div className="d-row">
        {g.open
          ? <button className="d-btn sm grow" onClick={guard(() => post('/api/giveaway/close'), 'Sorteo cerrado')}>Cerrar</button>
          : <button className="d-btn sm grow" onClick={guard(() => post('/api/giveaway/open', { reset: true }), 'Sorteo abierto')}>Abrir</button>}
        <button className="d-btn sm grow pri" disabled={!g.count} title={g.count ? 'Elige un ganador' : 'Todavía no hay participantes'}
          onClick={guard(() => post('/api/giveaway/draw'), 'Sorteado')}>Sortear</button>
      </div>
    </section>}

    <section className="d-card" aria-label="Teleprompter">
      <div className="d-card-h">Teleprompter<span className="d-meta">{hasScript ? `«${script!.title}» · ${block + 1}/${script!.blocks.length}` : 'sin guion'}</span></div>
      <div className="d-row">
        <button className="d-btn sm" aria-label="Bloque anterior" disabled={!hasScript}
          title={hasScript ? 'Vuelve al bloque anterior' : 'Necesita un guion cargado en el teleprompter'}
          onClick={() => tpAct('prev')}><Icon d={IC.arrowLeft} /></button>
        <button className={cx('d-btn sm grow d-tp-play', playing && 'on')} disabled={!hasScript}
          title={hasScript ? (playing ? 'Pausa el teleprompter' : 'Pone en marcha el teleprompter') : 'Necesita un guion cargado en el teleprompter'}
          onClick={() => tpAct('toggle')}>{playing ? '⏸ Pausar' : '▶ Reproducir'}</button>
        <button className="d-btn sm" aria-label="Bloque siguiente" disabled={!hasScript}
          title={hasScript ? 'Pasa al bloque siguiente' : 'Necesita un guion cargado en el teleprompter'}
          onClick={() => tpAct('next')}><Icon d={IC.arrowRight} /></button>
        <button className="d-btn sm" disabled={!hasScript} title={hasScript ? 'Vuelve al principio del guion' : 'Necesita un guion cargado en el teleprompter'}
          onClick={() => tpAct('reset')}>Inicio</button>
      </div>
    </section>

    <section className="d-card" aria-label="Cierre">
      <div className="d-card-h">Cierre<span className="d-meta">{names ? `créditos con ${names} nombres` : 'sin nombres todavía'}</span></div>
      <div className="d-row">
        <button className="d-btn sm grow" onClick={guard(() => post('/api/credits/play'), 'Créditos en marcha')}>Lanzar créditos</button>
        <button className="d-btn sm" onClick={guard(() => post('/api/credits/stop'), 'Créditos parados')}>Parar</button>
      </div>
    </section>
  </>;
}

function Shortcuts() {
  const list: ShortcutConfig[] = useLive(s => s.config.shortcuts || []);
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.length) return <section className="d-sec"><p className="d-muted">Crea tus atajos en el panel (Meld y Stream Deck › Atajos) y salen aquí como botones.</p></section>;
  return <section className="d-sec">
    <div className="d-card-h">Mis atajos<span className="d-meta">{list.length}</span></div>
    <div className="d-grid">{list.map(sc => <button key={sc.id} className={cx('d-btn sc', busy === sc.id && 'busy')} style={{ ['--sc' as any]: sc.color || 'var(--line2)' }} title={(sc.steps || []).map(stepText).join(' → ')}
      onClick={guard(async () => {
        setBusy(sc.id);
        try { const r = await post<{ errors?: string[] }>(`/api/shortcuts/${enc(sc.id)}/run`); toast(r.errors?.length ? `${sc.name}: ${r.errors.join(' · ')}` : sc.name, !!r.errors?.length); }
        finally { setBusy(null); }
      })}>{sc.name}<small>{(sc.steps || []).length} {(sc.steps || []).length === 1 ? 'paso' : 'pasos'}</small></button>)}</div>
  </section>;
}

// ---------- forma de la ventana ----------
const TABS = [['control', 'Control'], ['escenas', 'Escenas'], ['audio', 'Audio']] as const;
type Tab = (typeof TABS)[number][0];
const tabOf = (value: string | null): Tab => (value === 'escenas' || value === 'audio' ? value : 'control');

function Col({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children?: ReactNode }) {
  return <section className="d-col" aria-labelledby={`d-h-${id}`}>
    <h2 className="d-col-h" id={`d-h-${id}`}>{title}{meta ? <span>{meta}</span> : null}</h2>
    <div className="d-body">{children}</div>
  </section>;
}

function ScenesMeta() {
  const n = useLive(s => s.meld?.session?.scenes?.length || 0);
  return <>{n}</>;
}

function AudioMeta() {
  const tracks = useLive(s => s.meld?.session?.tracks || []);
  const muted = tracks.filter(t => t.muted).length;
  return <>{tracks.length} pistas · {muted} desactivadas</>;
}

function ControlMeta() {
  const streaming = useLive(s => !!s.status.meld?.streaming);
  return <>{streaming ? 'en directo' : 'sin emitir'}</>;
}

function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (index: number, focus: boolean) => {
    const next = TABS[(index + TABS.length) % TABS.length][0];
    onTab(next);
    if (focus) refs.current[(index + TABS.length) % TABS.length]?.focus();
  };
  return <nav className="d-tabs" role="tablist" aria-label="Secciones del dock">
    {TABS.map(([id, label], i) => <button key={id} type="button" role="tab" id={`d-t-${id}`} aria-controls={`d-p-${id}`}
      aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} ref={el => { refs.current[i] = el; }}
      onClick={() => onTab(id)}
      onKeyDown={e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1, true); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1, true); }
        else if (e.key === 'Home') { e.preventDefault(); go(0, true); }
        else if (e.key === 'End') { e.preventDefault(); go(TABS.length - 1, true); }
      }}>{label}</button>)}
    <a className="d-open" href="/" target="_blank" rel="noopener" title="Abrir el panel completo">Panel ↗</a>
  </nav>;
}

export function Dock() {
  const ready = useLive(s => !!s);
  const offline = useLive(() => live.failed);
  const wide = useWide();
  const [tab, setTab] = useState<Tab>(() => tabOf(localStorage.getItem(DOCK_TAB)));
  useEffect(() => { live.load().then(() => live.connect('panel')).catch(e => toast(e.message, true)); }, []);
  useEffect(() => { try { localStorage.setItem(DOCK_TAB, tab); } catch { /* almacenamiento no disponible: se ignora */ } }, [tab]);
  if (!ready) return <div className="d-boot">Conectando con antena…</div>;
  return <div className={cx('dock', wide && 'dock-wide')}>
    <Status wide={wide} />
    {wide
      ? <div className="d-cols">
        <Col id="escenas" title="Escenas" meta={<ScenesMeta />}><Scenes /></Col>
        <Col id="audio" title="Audio" meta={<AudioMeta />}><Audio /></Col>
        <Col id="control" title="Control" meta={<ControlMeta />}><Control /><Shortcuts /></Col>
      </div>
      : <>
        <Tabs tab={tab} onTab={setTab} />
        <div className="d-panels">
          <main className="d-body" role="tabpanel" id="d-p-control" aria-labelledby="d-t-control" hidden={tab !== 'control'}><Control /><Shortcuts /></main>
          <main className="d-body" role="tabpanel" id="d-p-escenas" aria-labelledby="d-t-escenas" hidden={tab !== 'escenas'}><Scenes /></main>
          <main className="d-body" role="tabpanel" id="d-p-audio" aria-labelledby="d-t-audio" hidden={tab !== 'audio'}><Audio /></main>
        </div>
      </>}
    {offline && <div className="d-off">Sin conexión con antena. Reintentando…</div>}
    <Toaster />
  </div>;
}
