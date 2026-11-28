// Panel principal (ventana de la app de escritorio o http://localhost:4500/ en el navegador).
import { Component, Suspense, useEffect, useState, type ReactNode } from 'react';
import { live, useLive } from '../lib/live';
import { flushAll } from '../lib/patch';
import { holding } from '../lib/draft';
import { EmptyState, toast, Toaster } from '../lib/ui';
import { useHash } from './router';
import { Onboarding } from './Onboarding';
import { PlatformWarning } from './PlatformWarning';
import { Sidebar } from './Sidebar';
import { platformsText } from './components/chat';
import { Directo } from './views/Directo';
import { getLazyRoute, type LazyRoute } from './views/index';

class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    // A new document clears failed module imports and fetches the current entry point.
    return <EmptyState action={<button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={() => location.reload()}>Recargar panel</button>}>
      <span role="alert">No se pudo cargar esta vista.</span>
    </EmptyState>;
  }
}

function LazyPage({ route, parts }: { route: LazyRoute; parts: string[] }) {
  // Use a completed preload without suspending. Keep that choice across subroutes.
  const [Page] = useState(() => route.loaded ?? route.Lazy);
  return <Page parts={parts} />;
}

function View({ parts }: { parts: string[] }) {
  const route = getLazyRoute(parts[0]);
  if (!route) return <Directo />;
  return <ViewBoundary key={parts[0]}>
    <Suspense fallback={<p className="hint" role="status">Cargando vista…</p>}>
      <LazyPage route={route} parts={parts} />
    </Suspense>
  </ViewBoundary>;
}

const PERSIST_KIND: Record<string, string> = { config: 'la configuración', secrets: 'los secretos' };
function PersistBar() {
  const st = useLive(s => s.status?.persistence);
  const dirty = Object.keys(PERSIST_KIND).filter(k => st?.dirty?.[k]);
  const pending = Object.keys(PERSIST_KIND).filter(k => Number(st?.pending?.[k] || 0) > 0);
  if (!dirty.length && !pending.length) return null;
  const err = dirty.length > 0;   // el error manda aunque queden reintentos pendientes
  const text = err ? `No se pudo guardar ${dirty.map(k => PERSIST_KIND[k]).join(' y ')}; los cambios siguen pendientes en memoria` : `Guardando ${pending.map(k => PERSIST_KIND[k]).join(' y ')}…`;
  return <div className="persist" role="status" aria-live="polite" data-state={err ? 'error' : 'pending'}><span>{text}</span></div>;
}

export function App() {
  const parts = useHash();
  const ready = useLive(s => !!s);
  const offline = useLive(() => live.failed);
  const [error, setError] = useState('');
  useEffect(() => {
    live.load().then(() => live.connect('panel')).catch(e => setError(e.message));
    const off = live.on('error', (e: any) => toast(e?.message || String(e), true));
    // a chat action from an alert or command that did not fully go out: what fired it and each platform's result
    const offChat = live.on('chatResult', ({ origin, platforms }: any) => {
      const from = origin?.kind === 'command' ? `del comando ${origin.trigger || ''}`.trim() : origin ? `de la alerta «${live.state?.types?.[origin.type]?.label || origin.type}»` : '';
      toast(`Fallo en la acción de chat ${from}: ${platformsText(platforms)}`);
    });
    // fuera del guardado manual (Directo, Chat…) lo que quede pendiente se guarda al cerrar
    const flush = () => { if (!holding()) flushAll().catch(() => {}); };
    window.addEventListener('beforeunload', flush);
    return () => { off(); offChat(); window.removeEventListener('beforeunload', flush); };
  }, []);
  if (error) return <div className="boot err"><h1>No se puede conectar con antena</h1><p>{error}</p><button className="btn" onClick={() => location.reload()}>Reintentar</button></div>;
  if (!ready) return <div className="boot"><img className="brand-mark" src="/brand/logo.png" alt="" /><p>Cargando…</p></div>;
  return <div className="app">
    <Sidebar current={'#/' + parts.join('/')} />
    <main id="main">{offline && <div className="offline" role="status">Sin conexión con el servidor. Reintentando…</div>}<View parts={parts} /></main>
    <PersistBar />
    <Onboarding />
    <PlatformWarning />
    <Toaster />
  </div>;
}
