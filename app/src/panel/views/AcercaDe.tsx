// Ajustes › Acerca de: versión instalada, actualizaciones (solo en la app de escritorio) y créditos.
import { useEffect, useState } from 'react';
import { checkUpdate, desktopInfo, isDesktop, type AppUpdate } from '../../lib/desktop';
import { Panel, Progress } from '../../lib/ui';
// la versión del panel sale de package.json al compilar; en la app manda la de Tauri (desktop_info)
import { version as BUILD_VERSION } from '../../../../package.json';

export const LINKS = {
  repo: 'https://github.com/egdev6/antena',
  releases: 'https://github.com/egdev6/antena/releases',
  web: 'https://egdev.es',
};

type Phase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'none' }
  | { phase: 'available'; update: AppUpdate }
  | { phase: 'installing'; update: AppUpdate; progress: number | null }
  | { phase: 'error'; message: string };

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e || 'error desconocido'));

function Updates() {
  const [st, setSt] = useState<Phase>({ phase: 'idle' });
  const busy = st.phase === 'checking' || st.phase === 'installing';
  const check = async () => {
    setSt({ phase: 'checking' });
    try {
      const update = await checkUpdate();
      setSt(update ? { phase: 'available', update } : { phase: 'none' });
    } catch (e) { setSt({ phase: 'error', message: `No se pudo buscar: ${errorText(e)}` }); }
  };
  const install = async (update: AppUpdate) => {
    setSt({ phase: 'installing', update, progress: null });
    try {
      await update.install(progress => setSt({ phase: 'installing', update, progress }));
    } catch (e) { setSt({ phase: 'error', message: `No se pudo instalar: ${errorText(e)}` }); }
  };
  return <div className="acerca-updates">
    <div className="acerca-row">
      <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={busy} onClick={check}>
        {st.phase === 'checking' ? 'Buscando…' : 'Buscar actualizaciones'}
      </button>
      {st.phase === 'none' && <span className="hint" role="status">Tienes la última versión.</span>}
    </div>
    {(st.phase === 'available' || st.phase === 'installing') && <div className="eg-notice eg-notice--info acerca-notice" role="status">
      <span className="eg-notice__text"><b>Hay una versión nueva: {st.update.version}.</b> Se descarga, se comprueba su firma y antena se reinicia. Las alertas se paran unos segundos.</span>
      <span className="eg-notice__actions">
        <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" disabled={st.phase === 'installing'} onClick={() => install(st.update)}>
          {st.phase === 'installing' ? `Instalando${st.progress != null ? ` · ${Math.round(st.progress * 100)} %` : '…'}` : 'Descargar y reiniciar'}
        </button>
      </span>
    </div>}
    {st.phase === 'installing' && <Progress p={st.progress ?? 0} label="Descarga de la actualización" />}
    {(st.phase === 'available' || st.phase === 'installing') && st.update.notes && <details className="acerca-notes"><summary>Novedades</summary><pre>{st.update.notes}</pre></details>}
    {st.phase === 'error' && <div className="eg-notice eg-notice--warning eg-notice--sm" role="alert"><span className="eg-notice__text">{st.message}</span></div>}
    <p className="hint">Las actualizaciones llegan firmadas desde <a href={LINKS.releases} {...ext}>GitHub Releases</a>; si la firma no coincide, no se instalan.</p>
  </div>;
}

export function AcercaDe() {
  const desktop = isDesktop();
  const [version, setVersion] = useState<string>(BUILD_VERSION);
  useEffect(() => {
    if (!desktop) return;
    let on = true;
    desktopInfo().then(i => { if (on && i?.version) setVersion(i.version); }).catch(() => {});
    return () => { on = false; };
  }, [desktop]);
  return <>
    <header className="view-head"><div><span className="crumb">Ajustes › Acerca de</span><h1>Acerca de</h1></div></header>
    <Panel title="Versión" className="acerca">
      <div className="acerca-app">
        <img className="acerca-logo" src="/brand/logo.png" alt="" aria-hidden="true" />
        <div>
          <p className="acerca-name"><b>antena</b> <span className="acerca-version" data-version={version}>v{version}</span></p>
          <p className="hint">Alertas, chat, widgets y control de Meld Studio para los directos de EGDEV.</p>
        </div>
      </div>
      {desktop
        ? <Updates />
        : <p className="hint acerca-browser">Las actualizaciones se buscan desde la app de escritorio. Para descargar la última versión, ve a <a href={LINKS.releases} {...ext}>las releases en GitHub</a>.</p>}
    </Panel>
    <Panel title="Créditos" className="acerca">
      <p>Hecho por Enrique Gómez Navarro (EGDEV). antena es código abierto: el código, las incidencias y las versiones están en el repositorio.</p>
      <ul className="acerca-links">
        <li><a className="eg-btn eg-btn--ghost eg-btn--sm" href={LINKS.repo} {...ext}>Repositorio en GitHub</a></li>
        <li><a className="eg-btn eg-btn--ghost eg-btn--sm" href={LINKS.web} {...ext}>egdev.es</a></li>
      </ul>
    </Panel>
  </>;
}
