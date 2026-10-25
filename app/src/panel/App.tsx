// Panel principal (ventana de la app de escritorio o http://localhost:4500/ en el navegador).
import { useEffect, useState } from 'react';
import { live, useLive } from '../lib/live';
import { flushAll } from '../lib/patch';
import { holding } from '../lib/draft';
import { toast, Toaster } from '../lib/ui';
import { useHash } from './router';
import { Onboarding } from './Onboarding';
import { Sidebar } from './Sidebar';
import { Vistas } from './views/index';
import { platformsText } from './views/Editor';

function View({ parts }: { parts: string[] }) {
  const V = Vistas;
  switch (parts[0]) {
    case 'directo': return <V.Directo />;
    case 'chat': return <V.Chat />;
    case 'preguntas': return <V.Preguntas parts={parts} />;
    case 'tierlist': return <V.TierList parts={parts} />;
    case 'sorteo': return <V.Sorteo parts={parts} />;
    case 'teleprompter': return <V.Teleprompter parts={parts} />;
    case 'alertas': return <V.Alertas parts={parts} />;
    case 'comandos': return <V.Comandos parts={parts} />;
    case 'mensajes': return <V.Mensajes parts={parts} />;
    case 'widgets': return <V.Widgets parts={parts} />;
    case 'atajos': return <V.Atajos parts={parts} />;
    case 'fuentes': return <V.Fuentes parts={parts} />;
    case 'meld': return <V.Meld parts={parts} />;
    case 'prompter': return <V.PrompterAjustes parts={parts} />;
    case 'historial': return <V.Historial />;
    case 'directos': return <V.Directos parts={parts} />;
    case 'archivos': return <V.Archivos parts={parts} />;
    case 'apariencia': return <V.Apariencia parts={parts} />;
    case 'conexiones': return <V.Conexiones parts={parts} />;
    case 'filtros': return <V.Filtros parts={parts} />;
    case 'general': return <V.General parts={parts} />;
    case 'acerca': return <V.AcercaDe />;
    default: return <V.Directo />;
  }
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
    <Toaster />
  </div>;
}
