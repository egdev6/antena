// Panel principal (ventana de la app de escritorio o http://localhost:4500/ en el navegador).
import { useEffect, useState } from 'react';
import { live, useLive } from '../lib/live';
import { flushAll } from '../lib/patch';
import { toast, Toaster } from '../lib/ui';
import { useHash } from './router';
import { Onboarding } from './Onboarding';
import { Sidebar } from './Sidebar';
import { Vistas } from './views/index';
import { platformsText } from './views/Editor';

function View({ parts }: { parts: string[] }) {
  const [a, b, c, d] = parts;
  const V = Vistas;
  switch (a) {
    case 'directo': return <V.Directo />;
    case 'chat': return <V.Chat />;
    case 'historial': return <V.Historial />;
    case 'alerta': return c === 'v' && d ? <V.Editor key={`v-${b}-${d}`} target={{ kind: 'variation', type: b, id: d }} /> : <V.Editor key={`a-${b}`} target={{ kind: 'alert', type: b }} />;
    case 'comandos': return <V.Comandos />;
    case 'comando': return <V.Editor key={`c-${b}`} target={{ kind: 'command', id: b }} />;
    case 'mensajes': return <V.Mensajes />;
    case 'mensaje': return <V.Editor key={`t-${b}`} target={{ kind: 'timer', id: b }} />;
    case 'widget':
      if (b === 'questions') return <V.Preguntas />;
      if (b === 'tierlist') return <V.TierList />;
      if (b === 'giveaway') return <V.Sorteo />;
      if (b === 'teleprompter') return <V.Teleprompter />;
      return <V.Widget key={b} name={b} />;
    case 'fuentes': return <V.Fuentes />;
    case 'meld': return <V.Meld />;
    case 'atajos': return <V.Atajos />;
    case 'prompter': return <V.PrompterAjustes />;
    case 'apariencia': return <V.Apariencia />;
    case 'filtros': return <V.Filtros />;
    case 'conexiones': return <V.Conexiones />;
    case 'general': return <V.General />;
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
    // al cambiar de vista o cerrar, se guarda lo pendiente
    const flush = () => { flushAll().catch(() => {}); };
    window.addEventListener('hashchange', flush);
    window.addEventListener('beforeunload', flush);
    return () => { off(); offChat(); window.removeEventListener('hashchange', flush); window.removeEventListener('beforeunload', flush); };
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
