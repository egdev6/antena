import { useEffect, useRef, useState } from 'react';
import { get, post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { cx, fmtTime, guard, LazyInput, SegField, Switch, toast } from '../../lib/ui';
import { isSaving, saveAll, useDraftVersion, useManualSave } from '../../lib/draft';
import { Card, CardGroup, CardSwitch, Dot, PageHead, SaveBar, Slide, usePageTab } from '../../lib/layout';
import { Icon, PfIcon } from '../../lib/ui';
import { IC, type IconData } from '../../lib/icons';
import type { Config } from '../../lib/types';

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
  const draftVersion = useDraftVersion();
  const st = useLive(s => s.status);
  const c = useLive(s => s.config);
  const kind = c.program?.kind || 'meld';
  const [activeKind, setActiveKind] = useState<'meld' | 'obs' | null>(kind);
  const password = useRef<HTMLInputElement>(null);
  const wasSaving = useRef(false), savedLoad = useRef(0);
  const saving = isSaving();
  const switching = saving && !!live.programSource.keys?.().includes('program');
  // A draft may differ from the active program, including edits made during a save.
  // Never restore the password input from either the public config or the draft.
  const passwordPending = typeof c.obs?.password === 'string';
  useEffect(() => {
    if (saving) { wasSaving.current = true; savedLoad.current++; }
    else {
      const finished = wasSaving.current; wasSaving.current = false;
      if (!live.programSource.dirty()) { savedLoad.current++; setActiveKind(kind); }
      else if (finished) {
        const request = ++savedLoad.current;
        setActiveKind(null);
        get<Config>('/api/config').then(saved => {
          if (request === savedLoad.current) setActiveKind(saved.program?.kind || 'meld');
        }).catch(() => {});
      }
    }
    if (!passwordPending && password.current) password.current.value = '';
  }, [kind, passwordPending, draftVersion, saving]);
  // Config events, unlike status churn, identify external changes to the selector.
  useEffect(() => {
    let active = true;
    const off = live.on('config', saved => {
      if (!saved.program) return;
      savedLoad.current++;
      setActiveKind(saved.program.kind || 'meld');
    });
    const request = ++savedLoad.current;
    get<Config>('/api/config').then(saved => {
      if (!active || request !== savedLoad.current || isSaving()) return;
      setActiveKind(saved.program?.kind || 'meld');
      const current = live.state?.config;
      if (!live.programSource.dirty() && current && (current.program?.kind !== saved.program?.kind ||
          current.obs?.url !== saved.obs?.url || current.obs?.passwordSet !== saved.obs?.passwordSet)) {
        live.update(s => ({ config: { ...s.config, program: saved.program, obs: saved.obs } }));
      }
    }).catch(() => {});
    return () => { active = false; savedLoad.current++; off(); live.programSource.discard(); };
  }, []);
  const scenes = useLive(s => s.meld?.session?.scenes || []);
  const access = useLive(s => s.access || { lan: false, urls: [] });
  const tw = st.twitch || {}, yt = st.youtube || {}, md = st.meld || {};
  const open = parts[1];
  // «Cuentas» holds the platforms, the broadcast program and access; «Webhooks» the outgoing notices.
  const [tab, setTab] = usePageTab(parts, 'conexiones', ['cuentas', 'webhooks']);
  const twOk = stateClass(tw.state) === 'ok', ytOk = stateClass(yt.state) === 'ok', mdOk = md.state === 'conectado';
  const nOk = [twOk, ytOk, mdOk, !!access.lan].filter(Boolean).length;
  const ytWrite = !!yt.account && !!yt.liveChatId;
  const meldUrl = c.meld?.url || 'ws://127.0.0.1:13376';
  const obsUrl = c.obs?.url || 'ws://127.0.0.1:4455';
  // The selected tab may be a draft. Never label or control the active program as the other one.
  const selectedActive = !switching && activeKind === kind && st.program?.kind === kind;
  const selectedStatus = selectedActive ? md : {};
  const selectedOk = selectedStatus.state === 'conectado';
  const obsActionsEnabled = selectedActive && !live.programSource.dirty();
  const scene = scenes.find((x: any) => x.current);
  return <>
    <PageHead tour="conexiones-head" crumb={`Ajustes · ${nOk} de 4 conectadas`} title="Conexiones" desc="Conecta tus cuentas una vez; la sesión se guarda en tu PC. Pulsa una tarjeta para ver sus ajustes."
      tabs={[{ id: 'cuentas', label: 'Cuentas' }, { id: 'webhooks', label: 'Webhooks' }]} tab={tab} onTab={setTab} />
    {tab === 'webhooks' ? <div className="lv-groups"><DiscordConnection /></div> : <div className="lv-groups">
      <article className="panel" id="programa-emision">
        <header><h2>Programa de emisión</h2><span className="lv-tag">Experimental</span></header>
        <SegField label="Programa de emisión" value={kind} options={[[ 'meld', 'Meld' ], [ 'obs', 'OBS' ]]}
          onChange={value => live.patchProgram({ program: { kind: value } })} />
        {kind === 'obs' && <>
          <label>URL de OBS<input id="obs-url" value={c.obs?.url ?? 'ws://127.0.0.1:4455'} spellCheck={false}
            onChange={e => live.patchProgram({ obs: { url: e.target.value } })} /></label>
          <label>Contraseña de OBS<input id="obs-password" ref={password} type="password" autoComplete="new-password" spellCheck={false}
            onChange={e => live.patchProgram({ obs: { password: e.target.value || undefined } })} /></label>
          {c.obs?.passwordSet && <p className="hint">Contraseña guardada</p>}
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => {
            if (password.current) password.current.value = '';
            live.patchProgram({ obs: { password: '' } });
          }}>Quitar contraseña</button>
        </>}
        {passwordPending && <p className="hint">La contraseña de OBS cambiará al guardar.</p>}
      </article>
      <CardGroup title="Plataformas" count={2} note="De donde llegan las alertas y el chat" wide>
        <Card tour="conexiones-twitch" className="lv-conn" href="#/conexiones/twitch" label="Abrir Twitch" open={open === 'twitch'} warn={tw.state === 'error' || !!tw.errors?.length || !!tw.streakWarning}
          title={<span className="lv-conn-h"><span className="lv-logo"><PfIcon platform="twitch" /></span><span><b>Twitch</b><small>Alertas, chat y marcas</small></span></span>}
          foot={<><span className="lv-cnote">{tw.device ? 'Esperando el código…' : twOk ? 'Se reconecta solo' : 'Necesita el Client ID'}</span><span className="sp" />
            {tw.user ? <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/twitch/restart'), 'Reconectando con Twitch…')}>Reconectar</button>
              : <a className="eg-btn eg-btn--secondary eg-btn--sm" href="#/conexiones/twitch">Conectar</a>}</>}>
          <Dot tone={tone(tw.state)}>{cap(tw.state)}</Dot>
          <dl className="lv-kv"><dt>Cuenta</dt><dd>{tw.user || '—'}</dd><dt>Chat</dt><dd>{st.chat?.channel ? `#${st.chat.channel} · ${st.chat.state}` : '—'}</dd><dt>Eventos</dt><dd>{tw.subscriptions?.length ? `${tw.subscriptions.length} suscripciones de EventSub` : '—'}</dd></dl>
          {tw.streakWarning && <p className="lv-cnote is-warn">{tw.streakWarning}</p>}
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
        {kind === 'meld' ? <Card className="lv-conn" href="#/meld/conexion" label="Abrir Meld Studio"
          title={<span className="lv-conn-h"><span className="lv-logo"><Icon d={IC.monitor} /></span><span><b>Meld Studio</b><small>Escenas, capas y efectos</small></span></span>}
          foot={<><span className="lv-cnote">{!selectedActive ? 'Guarda el programa seleccionado para conectarlo' : selectedOk ? 'Se reconecta solo si cierras Meld' : 'Activa «Allow remote connections» en Meld'}</span><span className="sp" />
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!selectedActive} onClick={guard(() => post('/api/meld/connect', { url: meldUrl }), 'Conectando con Meld…')}>{selectedOk ? 'Reconectar' : 'Conectar'}</button></>}>
          <Dot tone={selectedOk ? 'ok' : selectedStatus.state === 'error' ? 'warn' : 'off'}>{selectedActive ? cap(selectedStatus.state) : 'Pendiente de guardar'}</Dot>
          <dl className="lv-kv"><dt>Dirección</dt><dd>{meldUrl}</dd><dt>Escenas</dt><dd>{selectedActive && scenes.length ? `${scenes.length}${scene ? ` · en directo «${scene.name}»` : ''}` : '—'}</dd><dt>Al emitir</dt><dd>{c.program?.autoSession ? 'Empieza un directo nuevo' : 'Sigue el directo actual'}</dd></dl>
          {selectedStatus.error ? <p className="lv-cnote is-warn">{selectedStatus.error}</p> : null}
        </Card> : <Card className="lv-conn" label="Estado de OBS Studio"
          title={<span className="lv-conn-h"><span className="lv-logo"><Icon d={IC.monitor} /></span><span><b>OBS Studio</b><small>Conexión experimental</small></span></span>}
          foot={<><span className="lv-cnote">{obsActionsEnabled ? 'Usa la conexión guardada de OBS' : 'Guarda los cambios para conectar OBS'}</span><span className="sp" />
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!obsActionsEnabled} onClick={guard(() => post('/api/program/connect'), 'Conectando con OBS…')}>Conectar</button>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!obsActionsEnabled} onClick={guard(() => post('/api/program/disconnect'), 'OBS desconectado')}>Desconectar</button></>}>
          <Dot tone={tone(selectedStatus.state)}>{selectedActive ? cap(selectedStatus.state) : 'Pendiente de guardar'}</Dot>
          <dl className="lv-kv"><dt>Dirección</dt><dd>{obsUrl}</dd></dl>
          {selectedStatus.error ? <p className="lv-cnote is-warn">{selectedStatus.error}</p> : null}
        </Card>}
        <Card className="lv-conn" href="#/general/movil" label="Abrir acceso desde el móvil"
          title={<span className="lv-conn-h"><span className="lv-logo"><Icon d={PHONE} /></span><span><b>Acceso desde el móvil</b><small>El panel en la misma wifi, con clave</small></span></span>}
          foot={<><span className="lv-cnote">Se aplica al momento</span><span className="sp" />
            <CardSwitch checked={!!access.lan} label="Acceso desde el móvil" on="Activado" off="Apagado" onChange={v => guard(async () => { const a = await post<any>('/api/access', { lan: v }); live.update(() => ({ access: a })); })()} /></>}>
          <Dot tone={access.lan ? 'ok' : 'off'}>{access.lan ? 'Activado' : 'Apagado'}</Dot>
          <dl className="lv-kv"><dt>Enlace</dt><dd>{access.lan ? (access.urls?.[0] || 'Sin red local') : 'Solo desde este PC'}</dd></dl>
        </Card>
      </CardGroup>
    </div>}
    {open === 'twitch' || open === 'youtube' ? <ConexionSlide key={open} which={open} /> : <SaveBar />}
  </>;
}
function DiscordConnection() {
  const config = useLive(s => s.config.discord);
  const status = useLive(s => s.status.discord);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const update = async (patch: Record<string, unknown>) => {
    const saved = await put<{ config: Config }>('/api/config', { discord: patch });
    live.update(s => ({ config: { ...s.config, discord: saved.config.discord } }));
  };
  const action = (fn: () => Promise<void>) => guard(async () => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  })();
  return <article className="panel" id="discord">
    <header><h2>Discord</h2></header>
    <p className="hint">Publica un aviso del directo y lo actualiza al terminar. El webhook es privado.</p>
    <label>URL del webhook de Discord<input ref={input} type="password" autoComplete="new-password" spellCheck={false}
      placeholder={config?.webhookUrlSet ? '••••••••' : 'https://discord.com/api/webhooks/…'} /></label>
    {config?.webhookUrlSet && <p className="hint">Webhook guardado</p>}
    <div className="row">
      <button type="button" className="eg-btn eg-btn--secondary" disabled={busy} onClick={() => action(async () => {
        const value = input.current?.value || '';
        if (!value) throw new Error('Introduce la URL del webhook.');
        await update({ webhookUrl: value });
        if (input.current) input.current.value = '';
        setResult('Webhook guardado.');
      })}>Guardar webhook</button>
      <button type="button" className="eg-btn eg-btn--ghost" disabled={busy || !config?.webhookUrlSet} onClick={() => action(async () => {
        setResult('Enviando prueba…');
        try { await post('/api/discord/test'); setResult('Prueba enviada a Discord.'); }
        catch (error) { setResult('No se pudo enviar la prueba a Discord.'); throw error; }
      })}>Probar</button>
    </div>
    <fieldset className="discord-emojis">
      <legend>Iconos de plataforma (opcional)</legend>
      <p className="hint">Usa emojis de tu servidor junto a cada enlace. En Discord escribe <code>\:nombre:</code> y envíalo: pega aquí lo que responde, como <code>&lt;:twitch:123…&gt;</code>. Sin emoji se usa 🟪 o 🟥. El webhook debe publicar en el mismo servidor.</p>
      <div className="row2">
        <label>Emoji de Twitch<input data-discord-emoji="twitch" defaultValue={config?.emojiTwitch || ''} key={'tw' + (config?.emojiTwitch || '')} spellCheck={false} placeholder="<:twitch:123456789012345678>" /></label>
        <label>Emoji de YouTube<input data-discord-emoji="youtube" defaultValue={config?.emojiYoutube || ''} key={'yt' + (config?.emojiYoutube || '')} spellCheck={false} placeholder="<:youtube:123456789012345678>" /></label>
      </div>
      <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" data-discord-emoji-save disabled={busy} onClick={() => action(async () => {
        const read = (p: string) => (document.querySelector<HTMLInputElement>(`[data-discord-emoji="${p}"]`)?.value || '').trim();
        await update({ emojiTwitch: read('twitch'), emojiYoutube: read('youtube') });
        setResult('Iconos guardados.');
      })}>Guardar iconos</button>
    </fieldset>
    <Switch checked={!!config?.enabled} disabled={busy || !config?.webhookUrlSet}
      onChange={enabled => { void action(() => update({ enabled })); }}>Avisar en Discord al empezar el directo</Switch>
    {result && <p role="status" className="hint">{result}</p>}
    <p className="hint" aria-live="polite">Estado del aviso: {status?.state || 'sin avisos'}</p>
    {status?.state === 'sin confirmar' && <button type="button" className="eg-btn eg-btn--secondary" disabled={busy || !status.sessionId}
      onClick={() => { if (confirm('¿Volver a publicar? El aviso anterior podría haberse publicado ya.')) void action(async () => {
        await post('/api/discord/republish', { sessionId: status.sessionId, confirm: true });
      }); }}>Volver a publicar</button>}
  </article>;
}
function ConexionSlide({ which }: { which: 'twitch' | 'youtube' }) {
  useManualSave();
  const c = useLive(s => s.config);
  const st = useLive(s => s.status);
  const tw = st.twitch || {}, yt = st.youtube || {};
  const yset = (k: string) => (v: string) => live.patchConfig({ youtube: { [k]: v.trim() } });
  return <Slide crumb={<><a href="#/conexiones">Conexiones</a> › {which === 'twitch' ? 'Twitch' : 'YouTube'}</>} title={which === 'twitch' ? 'Twitch' : 'YouTube'} back="#/conexiones"
    head={<span className={cx('state', stateClass(which === 'twitch' ? tw.state : yt.state))}>{which === 'twitch' ? tw.state : yt.state}</span>}
    foot={<SaveBar />}>
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
        {tw.streakWarning && <p className="lv-cnote is-warn">{tw.streakWarning}</p>}
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
        <label>Segundos entre consultas de suscriptores <input type="number" min={0} step={1} value={c.youtube.subscriberPollSeconds ?? 120} onChange={e => live.patchConfig({ youtube: { subscriberPollSeconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })} /></label>
        <Switch checked={c.youtube.subscriberCountAlert !== false} onChange={v => live.patchConfig({ youtube: { subscriberCountAlert: v } })}>Avisar de suscriptores sin nombre («+N suscriptores»)</Switch>
        <p className="hint">Requiere conectar tu cuenta. Solo las suscripciones públicas tienen nombre; la alerta sin nombre usa totales exactos por debajo de 1000. La alerta llega con el retraso del intervalo y la API puede limitar los resultados. Usa cuota diaria compartida con el chat. Mínimo 60 s; 0 desactiva el sondeo.</p>
        <Switch checked={c.youtube.streakAlert !== false} onChange={v => live.patchConfig({ youtube: { streakAlert: v } })}>Avisar de rachas de chat en YouTube</Switch>
        <label>Directos seguidos mínimos (incluido el actual) <input type="number" min={1} step={1} value={c.youtube.streakMinSessions ?? 3} onChange={e => live.patchConfig({ youtube: { streakMinSessions: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })} /></label>
        <p className="hint">Cuenta los directos archivados por antena con estadísticas de chat de YouTube, no todos los de YouTube. Si hay racha, sustituye la bienvenida. La alerta se activa y edita en Alertas › Racha.</p>
        {st.followers?.youtube?.status === 'quota' && <p className="hint">Sondeo de suscriptores detenido por cuota agotada hasta volver a escuchar el chat. {st.followers.youtube.error}</p>}
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
