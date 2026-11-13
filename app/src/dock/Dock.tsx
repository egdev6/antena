// Dock del directo: todo el manejo del directo menos la vista previa (S1) y sin chat (S12).
// Desde 1024 px de ancho se ven las tres columnas Control | Audio | Interactivos, sin importar
// la orientación; por debajo, una pestaña por sección, con Control primero.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { post } from '../lib/api';
import { IC } from '../lib/icons';
import { live, useLive, useLiveVersion } from '../lib/live';
import { groupMeldScenes } from '../lib/meld-scenes';
import { ConnPill, cx, guard, Icon, mmss, toast, Toaster } from '../lib/ui';
import { DockQuestions } from './DockQuestions';
import { DockTierlist } from './DockTierlist';
import { DockGiveaway } from './DockGiveaway';
import type { MeldTrack, TeleprompterState, TimelineItem, ViewerPlatform, ViewerSettings } from '../lib/types';

const DOCK_TAB = 'egdev.dock.tab';
const INTERACTIVE_TAB = 'egdev.dock.interactive.tab';
/** Único punto de corte para renderizar las tres columnas y aplicar la clase dock-wide. */
const WIDE_MEDIA = '(min-width: 1024px)';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}

/** Forma de la ventana según su ancho; el listener de resize cubre motores que no emiten
 *  «change» al redimensionar la ventana de Tauri. */
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

function Status() {
  const s = useLive(x => x);
  const now = useNow();
  const tl = live.timeline;
  const st = s.status, meldOn = st.meld?.state === 'conectado' && !live.failed;
  const known = meldOn && st.meld?.streamingKnown === true;
  const streaming = known && st.meld?.streaming === true;
  const tracks = s.meld?.session?.tracks || [];
  const want = (s.config.prompter?.micTrack || '').toLowerCase();
  const mic = want ? tracks.find(t => t.name.toLowerCase() === want) : tracks.find(t => /mic/i.test(t.name));
  const pause = st.pause || {};
  return <header className="d-top">
    <div className={cx('d-live', streaming && 'on')}><i />{streaming ? 'En directo' : known ? 'Sin emitir' : 'Sesión'}<b>{tl.startedAt ? mmss((now - +new Date(tl.startedAt)) / 1000) : ''}</b></div>
    <div className="d-warns">
      {st.meld?.recordingWarning && <span className="d-warn soft" role="status">{st.meld.recordingWarning}</span>}
      {mic?.muted && <span className="d-warn big">🎙 Micro silenciado</span>}
      {pause.paused && <span className="d-warn">Alertas en pausa{pause.held ? ` · ${pause.held}` : ''}</span>}
      {!meldOn && !live.failed && <ConnPill platform="meld" state={st.meld?.state} />}
      {st.overlays === 0 && <span className="d-warn soft">Sin overlay</span>}
      {st.twitch && st.twitch.state !== 'conectado' && <ConnPill platform="twitch" state={st.twitch.state} />}
      {st.youtube?.state === 'en espera' && <ConnPill platform="youtube" state="en espera" label={st.youtube.notice || undefined} />}
    </div>
  </header>;
}

// ---------- Escenas (S7) ----------
function Scenes() {
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const meldOn = useLive(s => s.status.meld?.state === 'conectado');
  const [busy, setBusy] = useState<string | null>(null);
  if (!meldOn) return <p className="d-muted d-empty">Meld no está conectado. Conéctalo en Meld Studio y sus escenas aparecerán aquí.</p>;
  if (!scenes.length) return <p className="d-muted d-empty">Meld todavía no informa de ninguna escena.</p>;
  const entries = groupMeldScenes(scenes);
  const show = (id: string, verticalId?: string) => guard(async () => {
    setBusy(id);
    try {
      const r = await post<{ scene: string }>('/api/meld/scene', { scene: id });
      if (verticalId) await post('/api/meld/scene', { scene: verticalId });
      toast(`Escena «${r.scene}»`);
    } finally { setBusy(null); }
  })();
  return <div className="d-scenes">{entries.map(({ scene: sc, vertical, air }) => {
    return <button key={sc.id} type="button" className={cx('d-btn d-scene', air && 'on', busy === sc.id && 'busy')}
      aria-pressed={!!air} aria-label={sc.name} title={sc.name} onClick={() => show(sc.id, vertical?.id)}>
      <span className="d-scene-n">{sc.name}</span>{air ? <span className="d-air">AL AIRE · {air}</span> : null}
    </button>;
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

// ---------- Control (S11 y #158) ----------
const sd = (a: string, ok?: string) => guard(() => post('/sd/' + a), ok);
type StreamAction = 'start' | 'stop';
const STREAM_CONFIRM_MS = 20000;

/** El estado y el plazo viven en Dock para sobrevivir al cambio entre pestañas y columnas. */
function useStreamControl() {
  const meld = useLive(s => s?.status?.meld);
  const offline = useLive(() => live.failed);
  const connected = meld?.state === 'conectado' && !offline;
  const known = connected && meld?.streamingKnown === true && typeof meld.streaming === 'boolean';
  const streaming = known ? meld.streaming === true : null;
  const [confirmation, setConfirmation] = useState<StreamAction | null>(null);
  const [pending, setPending] = useState<StreamAction | null>(null);
  const [notice, setNotice] = useState('');
  const op = useRef<{ action: StreamAction; timer: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const active = op.current;
    if (!active || streaming === null || streaming !== (active.action === 'start')) return;
    window.clearTimeout(active.timer); op.current = null; setPending(null); setNotice('');
  }, [streaming, pending]);
  useEffect(() => () => {
    if (op.current) window.clearTimeout(op.current.timer);
    op.current = null;
  }, []);
  const dismiss = () => { setConfirmation(null); trigger.current?.focus(); };
  const request = async (action: StreamAction) => {
    const current = live.state?.status?.meld;
    // La conexión o el estado pueden cambiar mientras está abierto el diálogo.
    if (op.current || live.failed || current?.state !== 'conectado' || current.streamingKnown !== true ||
      typeof current.streaming !== 'boolean' || current.streaming === (action === 'start')) {
      setConfirmation(null); setNotice('El estado de Meld ha cambiado. Compruébalo antes de volver a intentarlo.'); return;
    }
    setConfirmation(null); setNotice('');
    const active = { action, timer: 0 };
    active.timer = window.setTimeout(() => {
      if (op.current !== active) return;
      op.current = null; setPending(null);
      setNotice('Meld no confirmó la orden a tiempo. Comprueba si está emitiendo antes de volver a intentarlo.');
    }, STREAM_CONFIRM_MS);
    op.current = active; setPending(action);
    try { await post('/api/meld/stream', { action }); }
    catch (err) {
      if (op.current !== active) return;
      window.clearTimeout(active.timer); op.current = null; setPending(null);
      setNotice(err instanceof Error ? err.message : 'No se pudo solicitar la orden a Meld.');
    }
  };
  const reason = !connected ? (offline ? 'Sin conexión con antena: no se conoce el estado de Meld.' : 'Meld no está conectado. Conéctalo para controlar la emisión.')
    : !known ? 'Meld todavía no informa del estado de emisión.' : '';
  return { streaming, confirmation, setConfirmation, pending, notice, trigger, dismiss, request, reason };
}

/** Igual que la lectura watcher-only de Directo: nunca sustituir ausencia por cero. */
function currentViewers(watcher: ViewerPlatform | undefined, settings: ViewerSettings | undefined, now: number): number | null {
  if (!settings?.enabled || !watcher?.live || watcher.off || watcher.error || watcher.current == null || !Number.isFinite(watcher.current)) return null;
  const at = Date.parse(watcher.updatedAt || '');
  const interval = Math.min(600, Math.max(20, Number.isFinite(settings.pollSec) ? settings.pollSec : 60));
  return Number.isFinite(at) && at <= now && now < at + interval * 1000 ? watcher.current : null;
}

function StreamDialog({ control }: { control: ReturnType<typeof useStreamControl> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const action = control.confirmation;
  useEffect(() => {
    if (!action || !dialog.current) return;
    dialog.current.showModal(); cancel.current?.focus();
  }, [action]);
  if (!action) return null;
  const valid = control.streaming === (action === 'stop') && !control.pending;
  const dismiss = () => { dialog.current?.close(); control.dismiss(); };
  return <dialog ref={dialog} className="d-confirm" aria-labelledby="d-confirm-title" aria-describedby="d-confirm-description"
    onCancel={e => { e.preventDefault(); dismiss(); }}>
    <h2 id="d-confirm-title">{action === 'start' ? '¿Iniciar directo?' : '¿Terminar directo?'}</h2>
    <p id="d-confirm-description">{action === 'start'
      ? 'Esto inicia la emisión pública de Meld de verdad. Con la sesión automática activada, antena creará la sesión cuando Meld confirme que emite.'
      : 'Esto termina la emisión pública de Meld de verdad.'}</p>
    {!valid && <p className="d-muted">{control.reason || 'El estado de emisión ha cambiado. Cancela y compruébalo.'}</p>}
    <div className="d-row d-confirm-actions">
      <button ref={cancel} type="button" className="d-btn sm" data-cancel-stream onClick={dismiss}>Cancelar</button>
      <button type="button" className="d-btn sm pri" data-confirm-stream disabled={!valid} onClick={() => void control.request(action)}>{action === 'start' ? 'Sí, iniciar directo' : 'Sí, terminar directo'}</button>
    </div>
  </dialog>;
}

function StreamControl({ control }: { control: ReturnType<typeof useStreamControl> }) {
  const viewers = useLive(s => s.viewers);
  const offline = useLive(() => live.failed);
  useNow(); // actualiza también cuando una lectura vigente caduca sin recibir eventos
  const now = Date.now();
  const action: StreamAction = control.streaming ? 'stop' : 'start';
  const label = control.pending ? (control.pending === 'start' ? 'Iniciando…' : 'Terminando…') : action === 'start' ? 'Iniciar directo' : 'Terminar directo';
  return <section className="d-card d-stream" aria-label="Control de emisión">
    <div className="d-card-h">Emisión <span className="d-meta">{control.streaming === null ? 'estado desconocido' : control.streaming ? 'En directo' : 'Sin emitir'}</span></div>
    <button ref={control.trigger} type="button" className={cx('d-btn', action === 'start' && 'pri')} disabled={!!control.reason || !!control.pending}
      title={control.reason || (action === 'start' ? 'Solicitar el inicio de la emisión pública' : 'Solicitar el fin de la emisión pública')}
      onClick={() => control.setConfirmation(action)}>{label}</button>
    {control.reason && <p className="d-muted">{control.reason}</p>}
    <p className="d-stream-notice" role="status">{control.notice}</p>
    <div className="d-viewers" aria-label="Espectadores por plataforma">{(['twitch', 'youtube'] as const).map(platform => {
      const value = offline ? null : currentViewers(viewers?.platforms?.[platform], viewers?.settings, now);
      return <div key={platform} data-platform={platform}><span>{platform === 'twitch' ? 'Twitch' : 'YouTube'}</span><b>{value === null ? 'sin dato' : value.toLocaleString('es-ES')}</b></div>;
    })}</div>
    <StreamDialog control={control} />
  </section>;
}

function Control({ stream }: { stream: ReturnType<typeof useStreamControl> }) {
  useLiveVersion(); // la cronología (pendientes) vive fuera del snapshot de /api/state
  const pause = useLive(s => s.status.pause || {});
  const tp = useLive(s => s.teleprompter) as TeleprompterState | undefined;
  const credits = useLive(s => (s.widgets?.credits as { names?: string[] }[] | undefined) || []);
  const pend = live.timeline.pending || 0;
  const names = credits.reduce((n, gr) => n + (gr.names?.length || 0), 0);
  const script = tp?.script;
  const hasScript = !!script && (script.blocks?.length || 0) > 0;
  const playing = !!tp?.playback?.playing;
  const block = tp?.playback?.block ?? 0;
  const tpAct = (action: string) => guard(() => post('/api/teleprompter/control', { action }))();
  return <>
    <StreamControl control={stream} />
    <div className="d-grid">
      <button className={cx('d-btn', pause.paused && 'on')} onClick={sd('pausa')} title={pause.paused ? 'Reanudar las alertas' : 'Pausar las alertas que lleguen'}>
        {pause.paused ? '▶ Reanudar' : '⏸ Pausar'}<small>alertas{pause.held ? ` · ${pause.held} en cola` : ''}</small></button>
      <button className="d-btn" onClick={sd('saltar', 'Saltada')} title="Quita la alerta que está en pantalla">⏭ Saltar<small>la alerta actual</small></button>
      <button className="d-btn pri" title="Marca este momento para un short"
        onClick={guard(async () => { const { marker } = await post<{ marker: TimelineItem }>('/api/markers', {}); toast(marker.twitchError ? `Marca local (Twitch: ${marker.twitchError})` : 'Marca creada'); })}>🎬 Marca<small>de short</small></button>
      <button className="d-btn" disabled={!pend} onClick={sd('agradecido')} title={pend ? `${pend} por agradecer` : 'Nada por agradecer todavía'}>✔ Agradecido<small>{pend} por agradecer</small></button>
    </div>

    <section className="d-sec" aria-label="Escenas"><h3 className="d-sub">Escenas</h3><Scenes /></section>

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

const INTERACTIVE_TABS = [['preguntas', 'Preguntas'], ['tier', 'Tier list'], ['sorteo', 'Sorteo']] as const;
type InteractiveTab = (typeof INTERACTIVE_TABS)[number][0];

function Interactivos() {
  const I = useLive(s => s.interactive);
  const q = I?.questions, g = I?.giveaway, vote = I?.vote;
  const [tab, setTab] = useState<InteractiveTab>(() => {
    const saved = localStorage.getItem(INTERACTIVE_TAB);
    return saved === 'tier' || saved === 'sorteo' ? saved : 'preguntas';
  });
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { try { localStorage.setItem(INTERACTIVE_TAB, tab); } catch { /* sin almacenamiento */ } }, [tab]);
  const go = (index: number) => {
    const i = (index + INTERACTIVE_TABS.length) % INTERACTIVE_TABS.length;
    setTab(INTERACTIVE_TABS[i][0]); refs.current[i]?.focus();
  };
  return <div className="d-inter">
    <nav className="d-itabs" role="tablist" aria-label="Interactivos">
      {INTERACTIVE_TABS.map(([id, label], i) => <button key={id} type="button" role="tab" id={`d-i-${id}`} aria-controls={`d-ip-${id}`}
        aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} ref={el => { refs.current[i] = el; }} onClick={() => setTab(id)}
        onKeyDown={e => {
          if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
          else if (e.key === 'Home') { e.preventDefault(); go(0); }
          else if (e.key === 'End') { e.preventDefault(); go(INTERACTIVE_TABS.length - 1); }
        }}>{label}{id === 'preguntas' && <span className="d-badge">{q?.pending || 0}</span>}
        {id === 'tier' && vote && <span className="d-dot vote" role="img" aria-label="Votación abierta" />}
        {id === 'sorteo' && <span className="d-badge">{g?.count || 0}</span>}
      </button>)}
    </nav>
    <div className="d-body" role="tabpanel" id="d-ip-preguntas" aria-labelledby="d-i-preguntas" hidden={tab !== 'preguntas'}>
      <DockQuestions />
    </div>
    <div className="d-body" role="tabpanel" id="d-ip-tier" aria-labelledby="d-i-tier" hidden={tab !== 'tier'}>
      <DockTierlist />
    </div>
    <div className="d-body" role="tabpanel" id="d-ip-sorteo" aria-labelledby="d-i-sorteo" hidden={tab !== 'sorteo'}>
      <DockGiveaway />
    </div>
  </div>;
}

// ---------- forma de la ventana ----------
const TABS = [['control', 'Control'], ['audio', 'Audio'], ['interactivos', 'Interactivos']] as const;
type Tab = (typeof TABS)[number][0];
const tabOf = (value: string | null): Tab => (value === 'interactivos' || value === 'audio' ? value : 'control');

function Col({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children?: ReactNode }) {
  return <section className="d-col" aria-labelledby={`d-h-${id}`}>
    <h2 className="d-col-h" id={`d-h-${id}`}>{title}{meta ? <span>{meta}</span> : null}</h2>
    <div className="d-body">{children}</div>
  </section>;
}

function AudioMeta() {
  const tracks = useLive(s => s.meld?.session?.tracks || []);
  const muted = tracks.filter(t => t.muted).length;
  return <>{tracks.length} pistas · {muted} desactivadas</>;
}

function ControlMeta() {
  const meld = useLive(s => s.status.meld);
  const offline = useLive(() => live.failed);
  const known = !offline && meld?.state === 'conectado' && meld.streamingKnown === true;
  return <>{!known ? 'estado desconocido' : meld.streaming ? 'en directo' : 'sin emitir'}</>;
}

function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const tracks = useLive(s => s.meld?.session?.tracks || []);
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const onAir = new Set(scenes.filter(s => s.current).map(s => s.id));
  const meldOn = useLive(s => s.status.meld?.state === 'conectado');
  const muted = meldOn ? tracks.filter(t => t.muted && (!t.parent || onAir.has(t.parent))).length : 0;
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
      }}>{label}{id === 'audio' && muted > 0 && <span className="d-dot" role="img" aria-label={`${muted} ${muted === 1 ? 'pista desactivada' : 'pistas desactivadas'}`} />}</button>)}
  </nav>;
}

export function Dock() {
  const ready = useLive(s => !!s);
  const offline = useLive(() => live.failed);
  const wide = useWide();
  const stream = useStreamControl();
  const [tab, setTab] = useState<Tab>(() => tabOf(localStorage.getItem(DOCK_TAB)));
  useEffect(() => { live.load().then(() => live.connect('panel')).catch(e => toast(e.message, true)); }, []);
  useEffect(() => { try { localStorage.setItem(DOCK_TAB, tab); } catch { /* almacenamiento no disponible: se ignora */ } }, [tab]);
  if (!ready) return <div className="d-boot">Conectando con antena…</div>;
  return <div className={cx('dock', wide && 'dock-wide')}>
    <Status />
    {wide
      ? <div className="d-cols">
        <Col id="control" title="Control" meta={<ControlMeta />}><Control stream={stream} /></Col>
        <Col id="audio" title="Audio" meta={<AudioMeta />}><Audio /></Col>
        <section className="d-col d-col-inter" aria-labelledby="d-h-interactivos"><h2 className="d-col-h" id="d-h-interactivos">Interactivos</h2><Interactivos /></section>
      </div>
      : <>
        <Tabs tab={tab} onTab={setTab} />
        <div className="d-panels">
          <main className="d-body" role="tabpanel" id="d-p-control" aria-labelledby="d-t-control" hidden={tab !== 'control'}><Control stream={stream} /></main>
          <main className="d-body" role="tabpanel" id="d-p-audio" aria-labelledby="d-t-audio" hidden={tab !== 'audio'}><Audio /></main>
          <main className="d-inter-panel" role="tabpanel" id="d-p-interactivos" aria-labelledby="d-t-interactivos" hidden={tab !== 'interactivos'}><Interactivos /></main>
        </div>
      </>}
    {offline && <div className="d-off">Sin conexión con antena. Reintentando…</div>}
    <Toaster />
  </div>;
}
