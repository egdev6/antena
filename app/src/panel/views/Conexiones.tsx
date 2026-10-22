import { post } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { cx, fmtTime, guard, LazyInput, toast, ViewHead } from '../../lib/ui';

export function stateClass(s?: string) {
  if (s && ['conectado', 'escuchando'].includes(s)) return 'ok';
  if (s === 'error') return 'err';
  if (!s || ['desconectado', 'parado'].includes(s)) return '';
  return 'warn';
}

export function Conexiones() {
  const c = useLive(s => s.config);
  const st = useLive(s => s.status);
  const tw = st.twitch || {}, yt = st.youtube || {};
  const yset = (k: string) => (v: string) => live.patchConfig({ youtube: { [k]: v.trim() } });
  return <>
    <ViewHead tour="conexiones-head" crumb="Ajustes › Conexiones" title="Conexiones" hint="Conecta tus cuentas una vez; la sesión se guarda en tu PC." />
    <div className="grid2">
      <article className="panel" id="twitch" data-tour="conexiones-twitch">
        <header><h2>Twitch</h2><span className={cx('state', stateClass(tw.state))}>{tw.state}</span></header>
        <label>Client ID de tu app<LazyInput value={c.twitch.clientId} spellCheck={false} placeholder="p. ej. abc123…" onCommit={(v: string) => live.patchConfig({ twitch: { clientId: v.trim() } })} /></label>
        <details className="help"><summary>Cómo crear la app de Twitch (una vez)</summary><ol>
          <li>Entra en <a href="https://dev.twitch.tv/console/apps/create" target="_blank" rel="noopener">dev.twitch.tv › Registrar aplicación</a>.</li>
          <li>Nombre: <code>antena</code> · URL de redirección: <code>http://localhost</code> · Categoría: <em>Broadcaster Suite</em>.</li>
          <li>Tipo de cliente: <b>Público</b>. No hace falta secreto.</li>
          <li>Copia el <b>Client ID</b> aquí arriba y pulsa «Conectar».</li></ol></details>
        {tw.device && <div className="device"><p>Abre <a href={tw.device.url} target="_blank" rel="noopener">{String(tw.device.url).replace(/^https?:\/\//, '')}</a> e introduce el código:</p><code className="code">{tw.device.code}</code></div>}
        {tw.user && <p className="who">Cuenta: <b>{tw.user}</b>{st.chat?.channel ? <> · chat de <b>{st.chat.channel}</b> ({st.chat.state})</> : null}</p>}
        {!!tw.subscriptions?.length && <ul className="chips">{tw.subscriptions.map((x: string) => <li key={x}>{x.replace('channel.', '')}</li>)}</ul>}
        {!!tw.errors?.length && <ul className="errors">{tw.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
        <div className="row">
          <button className="eg-btn eg-btn--primary" onClick={guard(async () => { await live.flushConfig(); await post('/api/twitch/connect'); })}>{tw.user ? 'Volver a conectar' : 'Conectar'}</button>
          <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/twitch/restart'))}>Reconectar</button>
          <button className="eg-btn eg-btn--ghost danger" onClick={guard(() => post('/api/twitch/disconnect'))}>Cerrar sesión</button>
        </div>
      </article>
      <article className="panel" id="youtube" data-tour="conexiones-youtube">
        <header><h2>YouTube</h2><span className={cx('state', stateClass(yt.state))}>{yt.state}</span></header>
        <label>API key (YouTube Data API v3)<LazyInput type="password" spellCheck={false} placeholder="AIza…" value={c.youtube.apiKey} onCommit={yset('apiKey')} /></label>
        <div className="row2">
          <label>ID del canal <LazyInput spellCheck={false} placeholder="UC…" value={c.youtube.channelId} onCommit={yset('channelId')} /></label>
          <label>Segundos entre lecturas <input type="number" min={5} max={60} value={c.youtube.pollSeconds || 8} onChange={e => live.patchConfig({ youtube: { pollSeconds: Math.max(5, Number(e.target.value) || 8) } })} /></label>
        </div>
        <label>Enlace del directo <small>(si lo dejas vacío, lo busca en tu canal)</small><LazyInput spellCheck={false} placeholder="https://www.youtube.com/live/…" value={c.youtube.video} onCommit={yset('video')} /></label>
        {yt.title && <p className="who">Directo: <b>{yt.title}</b> · {yt.polls || 0} lecturas</p>}
        {/* Aviso de espera (cuota/permisos): el motivo llega por SSE, sin estado de error */}
        {yt.notice && <p className="hint">{yt.notice}{yt.retryAt ? ` · reintento a las ${fmtTime(yt.retryAt)}` : ''}</p>}
        {!!yt.errors?.length && <ul className="errors">{yt.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
        <div className="row">
          <button className="eg-btn eg-btn--primary" onClick={guard(async () => { await live.flushConfig(); await post('/api/youtube/start', { video: c.youtube.video || undefined }); })}>Escuchar el chat</button>
          <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/youtube/stop'))}>Parar</button>
        </div>
        <h3 className="sub-h mt">Tu cuenta, para escribir en el chat</h3>
        <p className="who">{yt.account ? <>Conectada: <b>{yt.account}</b>{yt.liveChatId ? ' · puedes escribir en el chat' : ' · pon a escuchar el chat para poder escribir'}</> : 'Sin conectar: solo se lee el chat.'}</p>
        <div className="row2">
          <label>Client ID <LazyInput spellCheck={false} placeholder="….apps.googleusercontent.com" value={c.youtube.clientId} onCommit={yset('clientId')} /></label>
          <label>Client secret <LazyInput type="password" spellCheck={false} placeholder="GOCSPX-…" value={c.youtube.clientSecret} onCommit={yset('clientSecret')} /></label>
        </div>
        <details className="help"><summary>Cómo crear la app de Google (una vez)</summary><ol>
          <li>En <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud</a>, en el proyecto de tu API key, activa la <b>YouTube Data API v3</b>.</li>
          <li>Pantalla de consentimiento de OAuth: tipo externo, y añádete como usuario de prueba con la cuenta de tu canal.</li>
          <li>Credenciales › Crear ID de cliente de OAuth › tipo <b>App de escritorio</b>. Copia aquí el Client ID y el Client secret.</li>
          <li>Pulsa «Conectar cuenta», elige la cuenta del canal y acepta. Escribir un mensaje gasta unas 50 unidades de cuota.</li></ol></details>
        <div className="row">
          <button className="eg-btn eg-btn--primary" onClick={guard(async () => { await live.flushConfig(); const { url } = await post<{ url: string }>('/api/youtube/auth'); window.open(url, '_blank', 'noopener'); toast('Acepta el permiso en la pestaña de Google'); })}>{yt.account ? 'Volver a conectar' : 'Conectar cuenta'}</button>
          {yt.account && <button className="eg-btn eg-btn--ghost danger" onClick={guard(() => post('/api/youtube/logout'), 'Permiso de YouTube quitado')}>Quitar permiso</button>}
        </div>
      </article>
    </div>
  </>;
}
