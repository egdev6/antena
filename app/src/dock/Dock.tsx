// Dock del directo: módulos y zonas configurables, sin chat ni vídeo.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { normalizeDock, visibleDockZones } from '../../../src/dock-layout.mjs';
import { post, withKey } from '../lib/api';
import { IC } from '../lib/icons';
import { live, useLive, useLiveVersion } from '../lib/live';
import { countRender } from '../lib/render-count';
import { groupMeldScenes } from '../lib/meld-scenes';
import { ConnPill, cx, guard, Icon, mmss, PfIcon, toast, Toaster } from '../lib/ui';
import { DockQuestions } from './DockQuestions';
import { DockTierlist } from './DockTierlist';
import { DockGiveaway } from './DockGiveaway';
import { InterviewPad, useInterview } from '../lib/InterviewControls';
import { activateTheme, ThemeAvatar, useThemes, type ThemeLook } from '../lib/themes';
import type { DockConfig, DockModuleId, DockZone, MeldTrack, SavedThemeSummary, TeleprompterState, TimelineItem, ViewerPlatform, ViewerSettings } from '../lib/types';

const DOCK_TAB = 'egdev.dock.tab';
const INTERACTIVE_TAB = 'egdev.dock.interactive.tab';
/** Ambos cortes dependen solo del ancho de la ventana, no de su orientación. */
const WIDE_MEDIA = '(min-width: 768px)';
const FORCED_MEDIA = '(min-width: 480px)';
const storageGet = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const storageSet = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ } };
const params = new URLSearchParams(location.search);
const PREVIEW = params.has('preview');
function previewConfig(): unknown {
  try {
    const base64 = (params.get('preview') || '').replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return undefined; }
}
const PREVIEW_CONFIG = PREVIEW ? previewConfig() : undefined;

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}

/** Forma de la ventana según su ancho; el listener de resize cubre motores que no emiten
 *  «change» al redimensionar la ventana de Tauri. */
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    return () => { mq.removeEventListener('change', sync); window.removeEventListener('resize', sync); };
  }, [query]);
  return matches;
}

function Status({ active, look }: { active?: SavedThemeSummary; look?: ThemeLook }) {
  countRender('dock/Status');
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
    <div className="d-theme-active" data-dock-active-theme><ThemeAvatar theme={active} look={look} /><span>Tema activo: <b>{active?.name || 'Cargando…'}</b></span></div>
  </header>;
}

function ThemeChoices({ data }: { data: ReturnType<typeof useThemes> }) {
  return <div className="d-body d-themes" data-dock-theme-list>
    <h2 className="d-card-h">Cambiar tema <span className="d-meta">{data.themes.length} / 10</span></h2>
    <p className="d-muted">Se aplica al momento, también en directo.</p>
    {data.themes.map(theme => <button key={theme.id} type="button" className={cx('d-btn d-theme-choice', theme.active && 'is-active')} aria-pressed={theme.active} data-dock-theme-switch={theme.id} onClick={guard(() => activateTheme(theme))}>
      <ThemeAvatar theme={theme} look={data.looks[theme.id]} /><strong>{theme.name}</strong><small>{theme.active ? '✓ ACTIVO' : 'Activar'}</small>
    </button>)}
    <p className="d-card d-muted">Las alertas que ya están en pantalla terminan con su aspecto anterior. La cola continúa.</p>
  </div>;
}

// ---------- Escenas (S7) ----------
function Scenes() {
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const meldOn = useLive(s => s.status.meld?.state === 'conectado');
  const [busy, setBusy] = useState<string | null>(null);
  if (!meldOn) return <p className="d-muted d-empty">El programa de emisión no está conectado. Conéctalo en Conexiones y sus escenas aparecerán aquí.</p>;
  if (!scenes.length) return <p className="d-muted d-empty">El programa de emisión todavía no informa de ninguna escena.</p>;
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
type Meter = { id: string; level: number; clipping: boolean };

/** The dedicated stream exists only while OBS audio is visible; no panel/overlay traffic. */
function useMeters(watching: boolean) {
  const [meters, setMeters] = useState<Record<string, Meter>>({});
  useEffect(() => {
    if (!watching) { setMeters({}); return; }
    let source: EventSource | null = null;
    const stop = () => { source?.close(); source = null; setMeters({}); };
    const sync = () => {
      if (document.hidden) { stop(); return; }
      if (source) return;
      source = new EventSource(withKey('/api/stream?client=dock-meters'));
      source.addEventListener('meters', (event: MessageEvent) => {
        try {
          const tracks = (JSON.parse(event.data) as { tracks: Meter[] }).tracks;
          if (Array.isArray(tracks)) setMeters(Object.fromEntries(tracks.map(t => [t.id, t])));
        } catch { /* ignore incomplete frames */ }
      });
      source.onerror = () => setMeters({});
    };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', stop); window.addEventListener('pageshow', sync);
    sync();
    return () => { document.removeEventListener('visibilitychange', sync); window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', sync); stop(); };
  }, [watching]);
  return meters;
}

function TrackRow({ t, meter, showMeter }: { t: MeldTrack; meter?: Meter; showMeter: boolean }) {
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
      title={unknown ? 'Volumen desconocido: el programa de emisión no lo informa de esta pista' : `Volumen de ${t.name}`}
      aria-label={`Volumen de ${t.name}`}
      onChange={e => { const v = Number(e.target.value); setDrag(v); send(v); }} />
    {showMeter && <div className={cx('d-meter', meter?.clipping && 'clip')} role="meter" aria-label={`Nivel de ${t.name}`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((meter?.level ?? 0) * 100)}>
      <div style={{ width: `${(meter?.level ?? 0) * 100}%` }} />
    </div>}
  </div>;
}

function Audio({ meters, showMeters }: { meters: Record<string, Meter>; showMeters: boolean }) {
  const tracks = useLive(s => s.meld?.session?.tracks || []);
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const meldOn = useLive(s => s.status.meld?.state === 'conectado');
  if (!meldOn) return <p className="d-muted d-empty">El programa de emisión no está conectado: sin pistas que mezclar.</p>;
  if (!tracks.length) return <p className="d-muted d-empty">El programa de emisión todavía no informa de pistas de audio.</p>;
  const air = scenes.filter(x => x.current);
  const parents = new Set(air.map(x => x.id));
  const globals = tracks.filter(t => !t.parent);
  const onAir = tracks.filter(t => !!t.parent && parents.has(t.parent));
  return <div className="d-mixer">
    {globals.length ? <><h3 className="d-sub">Globales</h3>{globals.map(t => <TrackRow key={t.id} t={t} meter={meters[t.id]} showMeter={showMeters} />)}</> : null}
    {onAir.length ? <><h3 className="d-sub">{`En esta escena · ${air.map(x => x.name).join(' · ')}`}</h3>{onAir.map(t => <TrackRow key={t.id} t={t} meter={meters[t.id]} showMeter={showMeters} />)}</> : null}
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
      setConfirmation(null); setNotice('El estado del programa de emisión ha cambiado. Compruébalo antes de volver a intentarlo.'); return;
    }
    setConfirmation(null); setNotice('');
    const active = { action, timer: 0 };
    active.timer = window.setTimeout(() => {
      if (op.current !== active) return;
      op.current = null; setPending(null);
      setNotice('El programa de emisión no confirmó la orden a tiempo. Comprueba si está emitiendo antes de volver a intentarlo.');
    }, STREAM_CONFIRM_MS);
    op.current = active; setPending(action);
    try { await post('/api/meld/stream', { action }); }
    catch (err) {
      if (op.current !== active) return;
      window.clearTimeout(active.timer); op.current = null; setPending(null);
      setNotice(err instanceof Error ? err.message : 'No se pudo solicitar la orden al programa de emisión.');
    }
  };
  const reason = !connected ? (offline ? 'Sin conexión con antena: no se conoce el estado del programa de emisión.' : 'El programa de emisión no está conectado. Conéctalo para controlar la emisión.')
    : !known ? 'El programa de emisión todavía no informa del estado de emisión.' : '';
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
      ? 'Esto inicia la emisión pública de verdad. Con la sesión automática activada, antena creará la sesión cuando el programa de emisión confirme que emite.'
      : 'Esto termina la emisión pública de verdad.'}</p>
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
      return <div key={platform} data-platform={platform} className={cx(value === null && 'is-empty')}>
        <PfIcon platform={platform} className="d-viewers-logo" />
        <b>{value === null ? 'sin dato' : value.toLocaleString('es-ES')}</b></div>;
    })}</div>
    <StreamDialog control={control} />
  </section>;
}

function AlertsModule() {
  const pause = useLive(s => s.status.pause || {});
  return <>
    <button className={cx('d-btn', pause.paused && 'on')} onClick={sd('pausa')} title={pause.paused ? 'Reanudar las alertas' : 'Pausar las alertas que lleguen'}>
      {pause.paused ? '▶ Reanudar' : '⏸ Pausar'}<small>alertas{pause.held ? ` · ${pause.held} en cola` : ''}</small></button>
    <button className="d-btn" onClick={sd('saltar', 'Saltada')} title="Quita la alerta que está en pantalla">⏭ Saltar<small>la alerta actual</small></button>
  </>;
}

function MarksModule() {
  useLiveVersion(); // la cronología vive fuera del snapshot de /api/state
  const pend = live.timeline.pending || 0;
  return <>
    <button className="d-btn pri" title="Marca este momento para un short"
      onClick={guard(async () => { const { marker } = await post<{ marker: TimelineItem }>('/api/markers', {}); toast(marker.twitchError ? `Marca local (Twitch: ${marker.twitchError})` : 'Marca creada'); })}>🎬 Marca<small>de short</small></button>
    <button className="d-btn" disabled={!pend} onClick={sd('agradecido')} title={pend ? `${pend} por agradecer` : 'Nada por agradecer todavía'}>✔ Agradecido<small>{pend} por agradecer</small></button>
  </>;
}

function TeleprompterModule() {
  const tp = useLive(s => s.teleprompter) as TeleprompterState | undefined;
  const script = tp?.script;
  const hasScript = !!script && (script.blocks?.length || 0) > 0;
  const playing = !!tp?.playback?.playing;
  const block = tp?.playback?.block ?? 0;
  const tpAct = (action: string) => guard(() => post('/api/teleprompter/control', { action }))();
  return <section className="d-card" aria-label="Teleprompter">
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
  </section>;
}

function CreditsModule() {
  const credits = useLive(s => (s.widgets?.credits as { names?: string[] }[] | undefined) || []);
  const names = credits.reduce((n, gr) => n + (gr.names?.length || 0), 0);
  return <section className="d-card" aria-label="Cierre">
    <div className="d-card-h">Cierre<span className="d-meta">{names ? `créditos con ${names} nombres` : 'sin nombres todavía'}</span></div>
    <div className="d-row">
      <button className="d-btn sm grow" onClick={guard(() => post('/api/credits/play'), 'Créditos en marcha')}>Lanzar créditos</button>
      <button className="d-btn sm" onClick={guard(() => post('/api/credits/stop'), 'Créditos parados')}>Parar</button>
    </div>
  </section>;
}

function ShortcutsModule() {
  const shortcuts = useLive(s => s.config.shortcuts || []);
  return <section className="d-sec" aria-label="Atajos"><h3 className="d-sub">Atajos</h3>
    {shortcuts.length ? <div className="d-grid">{shortcuts.map(sc => <button key={sc.id} type="button" className="d-btn sc"
      onClick={guard(() => post(`/sd/custom/${encodeURIComponent(sc.id)}`))}>{sc.name}</button>)}</div>
      : <p className="d-muted">No hay atajos configurados.</p>}
  </section>;
}

function InterviewModule() {
  return <InterviewPad variant="dock" cls={{ root: 'd-card d-interview', btn: 'd-btn sm', primary: 'd-btn sm pri grow', muted: 'd-muted', row: 'd-row', note: 'd-muted', title: 'd-sub' }} />;
}

type ModuleContext = { stream: ReturnType<typeof useStreamControl>; meters: Record<string, Meter>; isObs: boolean };
const MODULES: Record<DockModuleId, (context: ModuleContext) => ReactNode> = {
  stream: ({ stream }) => <StreamControl control={stream} />,
  alerts: () => <AlertsModule />,
  marks: () => <MarksModule />,
  scenes: () => <section className="d-sec" aria-label="Escenas"><h3 className="d-sub">Escenas</h3><Scenes /></section>,
  teleprompter: () => <TeleprompterModule />,
  credits: () => <CreditsModule />,
  audio: ({ meters, isObs }) => <Audio meters={meters} showMeters={isObs} />,
  questions: () => <DockQuestions />,
  tierlist: () => <DockTierlist />,
  giveaway: () => <DockGiveaway />,
  shortcuts: () => <ShortcutsModule />,
  interview: () => <InterviewModule />,
};
const INTERACTIVE = {
  questions: { id: 'preguntas', label: 'Preguntas' },
  tierlist: { id: 'tier', label: 'Tier list' },
  giveaway: { id: 'sorteo', label: 'Sorteo' },
  interview: { id: 'entrevista', label: 'Entrevista' },
} as const;
type InteractiveModule = keyof typeof INTERACTIVE;
const isInteractive = (id: DockModuleId): id is InteractiveModule => Object.hasOwn(INTERACTIVE, id);

function Interactivos({ ids, context }: { ids: InteractiveModule[]; context: ModuleContext }) {
  const I = useLive(s => s.interactive);
  const interview = useInterview();
  const [tab, setTab] = useState(() => storageGet(INTERACTIVE_TAB) || 'preguntas');
  const tabs = ids.map(module => ({ module, ...INTERACTIVE[module] }));
  const selected = tabs.some(item => item.id === tab) ? tab : tabs[0]?.id;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { if (!PREVIEW && selected) storageSet(INTERACTIVE_TAB, selected); }, [selected]);
  const go = (index: number) => {
    const i = (index + tabs.length) % tabs.length;
    setTab(tabs[i].id); refs.current[i]?.focus();
  };
  return <div className="d-inter">
    <nav className="d-itabs" role="tablist" aria-label="Interactivos">
      {tabs.map(({ id, label }, i) => <button key={id} type="button" role="tab" id={`d-i-${id}`} aria-controls={`d-ip-${id}`}
        aria-selected={selected === id} tabIndex={selected === id ? 0 : -1} ref={el => { refs.current[i] = el; }} onClick={() => setTab(id)}
        onKeyDown={e => {
          if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
          else if (e.key === 'Home') { e.preventDefault(); go(0); }
          else if (e.key === 'End') { e.preventDefault(); go(tabs.length - 1); }
        }}>{label}{id === 'preguntas' && <span className="d-badge">{I?.questions?.pending || 0}</span>}
        {id === 'tier' && I?.vote && <span className="d-dot vote" role="img" aria-label="Votación abierta" />}
        {id === 'sorteo' && <span className="d-badge">{I?.giveaway?.count || 0}</span>}
        {id === 'entrevista' && interview?.active && <span className="d-badge" aria-label={`Progreso: ${interview.progress.index} de ${interview.progress.total}`}>{interview.progress.index}/{interview.progress.total}</span>}
      </button>)}
    </nav>
    {tabs.map(({ module, id }) => <div key={id} className="d-body" role="tabpanel" id={`d-ip-${id}`} aria-labelledby={`d-i-${id}`} hidden={selected !== id}>
      {MODULES[module](context)}
    </div>)}
  </div>;
}

function ZoneContent({ zone, context }: { zone: DockZone; context: ModuleContext }) {
  const interactives = zone.modules.filter(isInteractive);
  const output: ReactNode[] = [];
  for (let i = 0; i < zone.modules.length; i++) {
    const id = zone.modules[i];
    if (isInteractive(id) && interactives.length >= 2) {
      if (id === interactives[0]) output.push(<Interactivos key="interactive" ids={interactives} context={context} />);
    } else if (id === 'alerts' || id === 'marks') {
      const group: DockModuleId[] = [id];
      while (zone.modules[i + 1] === 'alerts' || zone.modules[i + 1] === 'marks') group.push(zone.modules[++i]);
      output.push(<div className="d-grid" key={id}>{group.map(item => <Fragment key={item}>{MODULES[item](context)}</Fragment>)}</div>);
    } else output.push(<Fragment key={id}>{MODULES[id](context)}</Fragment>);
  }
  return <>{output}</>;
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

function Tabs({ zones, tab, onTab }: { zones: DockZone[]; tab: string; onTab: (t: string) => void }) {
  const tracks = useLive(s => s.meld?.session?.tracks || []);
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const onAir = new Set(scenes.filter(s => s.current).map(s => s.id));
  const meldOn = useLive(s => s.status.meld?.state === 'conectado');
  const muted = meldOn ? tracks.filter(t => t.muted && (!t.parent || onAir.has(t.parent))).length : 0;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (index: number) => {
    const i = (index + zones.length) % zones.length;
    onTab(zones[i].id); refs.current[i]?.focus();
  };
  return <nav className="d-tabs" role="tablist" aria-label="Secciones del dock">
    {zones.map(({ id, label, modules }, i) => <button key={id} type="button" role="tab" id={`d-t-${id}`} aria-controls={`d-p-${id}`}
      aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} ref={el => { refs.current[i] = el; }}
      data-dock-theme-tab={id === 'saved-theme' ? '' : undefined} onClick={() => onTab(id)}
      onKeyDown={e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); go(0); }
        else if (e.key === 'End') { e.preventDefault(); go(zones.length - 1); }
      }}>{label}{modules.includes('audio') && muted > 0 && <span className="d-dot" role="img" aria-label={`${muted} ${muted === 1 ? 'pista desactivada' : 'pistas desactivadas'}`} />}</button>)}
  </nav>;
}

const onlyInteractive = (zone: DockZone) => zone.modules.length >= 2 && zone.modules.every(isInteractive);

export function Dock() {
  const ready = useLive(s => !!s);
  const offline = useLive(() => live.failed);
  const saved = useLive(s => s?.config?.dock);
  const themeData = useThemes();
  const activeTheme = themeData.themes.find(item => item.id === themeData.activeId);
  const isObs = useLive(s => s?.config?.program?.kind === 'obs');
  const wide = useMedia(WIDE_MEDIA), forced = useMedia(FORCED_MEDIA);
  const stream = useStreamControl();
  const [tab, setTab] = useState(() => storageGet(DOCK_TAB) || 'control');
  const dock = normalizeDock(PREVIEW ? PREVIEW_CONFIG : saved) as DockConfig;
  const layout = dock.layout === 'auto' ? (wide ? 'columns' : 'tabs') : (!forced ? 'tabs' : dock.layout);
  const zones = visibleDockZones(dock.zones, layout);
  const selected = tab === 'saved-theme' || zones.some(zone => zone.id === tab) ? tab : zones[0]?.id || '';
  const tabs = [...zones, { id: 'saved-theme', label: 'Tema', modules: [] }];
  const watching = selected !== 'saved-theme' && zones.some(zone => zone.modules.includes('audio') && (layout !== 'tabs' || zone.id === selected));
  const meters = useMeters(ready && !PREVIEW && isObs && watching);
  useEffect(() => { live.load().then(() => live.connect('panel')).catch(e => toast(e.message, true)); }, []);
  useEffect(() => { if (ready && !PREVIEW && selected) storageSet(DOCK_TAB, selected); }, [ready, selected]);
  if (!ready) return <div className="d-boot">Conectando con antena…</div>;
  const context = { stream, meters, isObs };
  const block = (event: { preventDefault: () => void; stopPropagation: () => void }) => { event.preventDefault(); event.stopPropagation(); };
  const defaultColumns = layout === 'columns' && zones.map(z => z.id).join(',') === 'control,audio,interactivos';
  const gridStyle: CSSProperties = layout === 'split-v'
    ? { gridTemplateRows: `repeat(${Math.max(1, zones.length)}, minmax(0, 1fr))` }
    : defaultColumns ? {} : { gridTemplateColumns: `repeat(${Math.max(1, zones.length)}, minmax(0, 1fr))` };
  return <div className={cx('dock', layout !== 'tabs' && 'dock-wide')} inert={PREVIEW || undefined}
    onClickCapture={PREVIEW ? block : undefined} onSubmitCapture={PREVIEW ? block : undefined}
    onChangeCapture={PREVIEW ? block : undefined} onInputCapture={PREVIEW ? block : undefined} onKeyDownCapture={PREVIEW ? block : undefined}>
    <Status active={activeTheme} look={activeTheme && themeData.looks[activeTheme.id]} />
    {layout !== 'tabs'
      ? <><nav className="d-wide-tabs" role="tablist" aria-label="Secciones del dock">
          <button type="button" role="tab" aria-selected={selected !== 'saved-theme'} onClick={() => setTab(zones[0]?.id || '')}>Control</button>
          <button type="button" role="tab" data-dock-theme-tab aria-selected={selected === 'saved-theme'} onClick={() => setTab('saved-theme')}>Tema</button>
        </nav>
        {selected === 'saved-theme' ? <ThemeChoices data={themeData} /> : <div className={cx('d-cols', layout === 'split-v' && 'd-split-v')} style={gridStyle}>
        {zones.map(zone => <section key={zone.id} className={cx('d-col', onlyInteractive(zone) && 'd-col-inter')} aria-labelledby={`d-h-${zone.id}`}>
          <h2 className="d-col-h" id={`d-h-${zone.id}`}>{zone.label}{zone.id === 'control' && zone.modules.includes('stream') ? <span><ControlMeta /></span> : zone.id === 'audio' && zone.modules.includes('audio') ? <span><AudioMeta /></span> : null}</h2>
          {onlyInteractive(zone) ? <ZoneContent zone={zone} context={context} /> : <div className="d-body"><ZoneContent zone={zone} context={context} /></div>}
        </section>)}
      </div>}</>
      : <>
        <Tabs zones={tabs} tab={selected} onTab={setTab} />
        <div className="d-panels">
          {zones.map(zone => <main key={zone.id} className={onlyInteractive(zone) ? 'd-inter-panel' : 'd-body'} role="tabpanel"
            id={`d-p-${zone.id}`} aria-labelledby={`d-t-${zone.id}`} hidden={selected !== zone.id}><ZoneContent zone={zone} context={context} /></main>)}
          <main role="tabpanel" id="d-p-saved-theme" aria-labelledby="d-t-saved-theme" hidden={selected !== 'saved-theme'}><ThemeChoices data={themeData} /></main>
        </div>
      </>}
    {offline && <div className="d-off">Sin conexión con antena. Reintentando…</div>}
    <Toaster />
  </div>;
}
