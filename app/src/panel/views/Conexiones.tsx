import { post } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { cx, fmtTime, guard, LazyInput, toast } from '../../lib/ui';
import { saveAll, useManualSave } from '../../lib/draft';
import { Card, CardGroup, CardSwitch, Dot, PageHead, SaveBar, Slide } from '../../lib/layout';
import { Icon, PfIcon } from '../../lib/ui';
import { IC, type IconData } from '../../lib/icons';

export function stateClass(s?: string) {
  if (s && ['conectado', 'escuchando'].includes(s)) return 'ok';
  if (s === 'error') return 'err';
  if (!s || ['desconectado', 'parado'].includes(s)) return '';
  return 'warn';
}

const tone = (state?: string): 'ok' | 'warn' | 'off' => (stateClass(state) === 'ok' ? 'ok' : stateClass(state) ? 'warn' : 'off');
const cap = (x?: string) => (x ? x[0].toUpperCase() + x.slice(1) : 'Sin conectar');
const PHONE: IconData = [['rect', { x: '7', y: '2', width: '10', height: '20', rx: '2' }], ['path', { d: 'M11 18h2' }]];
/** Conexiones (v3): el catálogo de servicios en tarjetas, por grupos. Si la app suma uno, entra en su grupo. */
export function Conexiones({ parts }: { parts: string[] }) {
  const st = useLive(s => s.status);
  const c = useLive(s => s.config);
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const access = useLive(s => s.access || { lan: false, urls: [] });
  const tw = st.twitch || {}, yt = st.youtube || {}, md = st.meld || {};
  const open = parts[1];
  const twOk = stateClass(tw.state) === 'ok', ytOk = stateClass(yt.state) === 'ok', mdOk = md.state === 'conectado';
  const nOk = [twOk, ytOk, mdOk, !!access.lan].filter(Boolean).length;
  const ytWrite = !!yt.account && !!yt.liveChatId;
  const meldUrl = c.meld?.url || 'ws://127.0.0.1:13376';
  const scene = scenes.find((x: any) => x.current);
  return <>
    <PageHead tour="conexiones-head" crumb={`Ajustes · ${nOk} de 4 conectadas`} title="Conexiones" desc="Conecta tus cuentas una vez; la sesión se guarda en tu PC. Pulsa una tarjeta para ver sus ajustes." />
    <div className="lv-groups">
      <CardGroup title="Plataformas" count={2} note="De donde llegan las alertas y el chat" wide>
        <Card tour="conexiones-twitch" className="lv-conn" href="#/conexiones/twitch" label="Abrir Twitch" open={open === 'twitch'} warn={tw.state === 'error' || !!tw.errors?.length}
          title={<span className="lv-conn-h"><span className="lv-logo"><PfIcon platform="twitch" /></span><span><b>Twitch</b><small>Alertas, chat y marcas</small></span></span>}
          foot={<><span className="lv-cnote">{tw.device ? 'Esperando el código…' : twOk ? 'Se reconecta solo' : 'Necesita el Client ID'}</span><span className="sp" />
            {tw.user ? <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/twitch/restart'), 'Reconectando con Twitch…')}>Reconectar</button>
              : <a className="eg-btn eg-btn--secondary eg-btn--sm" href="#/conexiones/twitch">Conectar</a>}</>}>
          <Dot tone={tone(tw.state)}>{cap(tw.state)}</Dot>
          <dl className="lv-kv"><dt>Cuenta</dt><dd>{tw.user || '—'}</dd><dt>Chat</dt><dd>{st.chat?.channel ? `#${st.chat.channel} · ${st.chat.state}` : '—'}</dd><dt>Eventos</dt><dd>{tw.subscriptions?.length ? `${tw.subscriptions.length} suscripciones de EventSub` : '—'}</dd></dl>
          {tw.errors?.length ? <p className="lv-cnote is-warn">{tw.errors[0]}</p> : null}
        </Card>
        <Card tour="conexiones-youtube" className="lv-conn" href="#/conexiones/youtube" label="Abrir YouTube" open={open === 'youtube'} warn={yt.state === 'error' || (ytOk && !ytWrite)}
          title={<span className="lv-conn-h"><span className="lv-logo"><PfIcon platform="youtube" /></span><span><b>YouTube</b><small>Chat, Super Chats y miembros</small></span></span>}
          foot={<><span className={cx('lv-cnote', ytOk && !yt.account && 'is-warn')}>{yt.account ? (ytWrite ? 'Puedes escribir en el chat' : 'Pon a escuchar el chat para escribir') : 'Sin cuenta: solo se lee el chat'}</span><span className="sp" />
            {yt.account ? null : <a className="eg-btn eg-btn--secondary eg-btn--sm" href="#/conexiones/youtube">Conectar cuenta</a>}</>}>
          <Dot tone={tone(yt.state)}>{cap(yt.state)}{ytOk && !yt.account ? ' · sin permiso para escribir' : ''}</Dot>
          <dl className="lv-kv"><dt>Canal</dt><dd>{c.youtube?.channelId || '—'}</dd><dt>Directo</dt><dd>{yt.title || (c.youtube?.video ? 'El del enlace' : 'Lo busca en tu canal')}</dd><dt>Lecturas</dt><dd>cada {c.youtube?.pollSeconds || 8} s{yt.polls ? ` · ${yt.polls} hechas` : ''}</dd></dl>
          {yt.notice ? <p className="lv-cnote">{yt.notice}</p> : null}
        </Card>
      </CardGroup>
      <CardGroup title="Producción y acceso" count={2} note="Lo que controla la app y desde dónde la manejas" wide>
        <Card className="lv-conn" href="#/meld/conexion" label="Abrir Meld Studio"
          title={<span className="lv-conn-h"><span className="lv-logo"><Icon d={IC.monitor} /></span><span><b>Meld Studio</b><small>Escenas, capas y efectos</small></span></span>}
          foot={<><span className="lv-cnote">{mdOk ? 'Se reconecta solo si cierras Meld' : 'Activa «Allow remote connections» en Meld'}</span><span className="sp" />
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/meld/connect', { url: meldUrl }), 'Conectando con Meld…')}>{mdOk ? 'Reconectar' : 'Conectar'}</button></>}>
          <Dot tone={mdOk ? 'ok' : md.state === 'error' ? 'warn' : 'off'}>{cap(md.state)}</Dot>
          <dl className="lv-kv"><dt>Dirección</dt><dd>{meldUrl}</dd><dt>Escenas</dt><dd>{scenes.length ? `${scenes.length}${scene ? ` · en directo «${scene.name}»` : ''}` : '—'}</dd><dt>Al emitir</dt><dd>{c.meld?.autoSession ? 'Empieza un directo nuevo' : 'Sigue el directo actual'}</dd></dl>
          {md.error ? <p className="lv-cnote is-warn">{md.error}</p> : null}
        </Card>
        <Card className="lv-conn" href="#/general/movil" label="Abrir acceso desde el móvil"
          title={<span className="lv-conn-h"><span className="lv-logo"><Icon d={PHONE} /></span><span><b>Acceso desde el móvil</b><small>El panel en la misma wifi, con clave</small></span></span>}
          foot={<><span className="lv-cnote">Se aplica al momento</span><span className="sp" />
            <CardSwitch checked={!!access.lan} label="Acceso desde el móvil" on="Activado" off="Apagado" onChange={v => guard(async () => { const a = await post<any>('/api/access', { lan: v }); live.update(() => ({ access: a })); })()} /></>}>
          <Dot tone={access.lan ? 'ok' : 'off'}>{access.lan ? 'Activado' : 'Apagado'}</Dot>
          <dl className="lv-kv"><dt>Enlace</dt><dd>{access.lan ? (access.urls?.[0] || 'Sin red local') : 'Solo desde este PC'}</dd></dl>
        </Card>
      </CardGroup>
    </div>
    {open === 'twitch' || open === 'youtube' ? <ConexionSlide key={open} which={open} /> : null}
  </>;
}
function ConexionSlide({ which }: { which: 'twitch' | 'youtube' }) {
  useManualSave();
  const c = useLive(s => s.config);
  const st = useLive(s => s.status);
  const tw = st.twitch || {}, yt = st.youtube || {};
  const yset = (k: string) => (v: string) => live.patchConfig({ youtube: { [k]: v.trim() } });
  return <Slide crumb={<><a href="#/conexiones">Conexiones</a> › {which === 'twitch' ? 'Twitch' : 'YouTube'}</>} title={which === 'twitch' ? 'Twitch' : 'YouTube'} back="#/conexiones"
    head={<span className={cx('state', stateClass(which === 'twitch' ? tw.state : yt.state))}>{which === 'twitch' ? tw.state : yt.state}</span>}
    foot={<SaveBar right={<span className="hint">«Conectar» guarda antes los cambios.</span>} />}>
    <div className="lv-page">
      {which === 'twitch' && <article className="panel" id="twitch">
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
          <button className="eg-btn eg-btn--primary" onClick={guard(async () => { await saveAll(); await post('/api/twitch/connect'); })}>{tw.user ? 'Volver a conectar' : 'Conectar'}</button>
          <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/twitch/restart'))}>Reconectar</button>
          <button className="eg-btn eg-btn--ghost danger" onClick={guard(() => post('/api/twitch/disconnect'))}>Cerrar sesión</button>
        </div>
      </article>}
      {which === 'youtube' && <article className="panel" id="youtube">
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
          <button className="eg-btn eg-btn--primary" onClick={guard(async () => { await saveAll(); await post('/api/youtube/start', { video: c.youtube.video || undefined }); })}>Escuchar el chat</button>
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
          <button className="eg-btn eg-btn--primary" onClick={guard(async () => { await saveAll(); const { url } = await post<{ url: string }>('/api/youtube/auth'); window.open(url, '_blank', 'noopener'); toast('Acepta el permiso en la pestaña de Google'); })}>{yt.account ? 'Volver a conectar' : 'Conectar cuenta'}</button>
          {yt.account && <button className="eg-btn eg-btn--ghost danger" onClick={guard(() => post('/api/youtube/logout'), 'Permiso de YouTube quitado')}>Quitar permiso</button>}
        </div>
      </article>}
    </div>
  </Slide>;
}
