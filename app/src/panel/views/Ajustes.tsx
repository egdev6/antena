// Ajustes: Meld Studio, filtros y voz, y la vista del prompter.
import { useEffect, useState } from 'react';
import { post } from '../../lib/api';
import { isDesktop, listMonitors, openPrompter, type Monitor } from '../../lib/desktop';
import { live, useLive } from '../../lib/live';
import { codeTab, cx, guard, Icon, IconBtn, LazyInput, Panel, Range, Sec, Status, Switch, toast } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { stateClass } from './Conexiones';
import type { FiltersConfig, PrompterConfig, TtsConfig } from '../../lib/types';

// ---------- Meld ----------
const layerMeta = (l: { url?: string }) => {
  if (!l.url) return 'Capa';
  try { const u = new URL(l.url); return `Navegador · ${u.pathname}${u.search}`; } catch { return 'Navegador'; }
};
export function Meld() {
  const st = useLive(s => s.status.meld || {});
  const m = useLive(s => s.config.meld || {});
  const ses = useLive(s => s.meld?.session || { scenes: [], tracks: [] });
  const [url, setUrl] = useState(m.url || '');
  const on = st.state === 'conectado';
  const cmd = (command: string, ok?: string) => guard(() => post('/api/meld/command', { command }), ok);
  const evt = (event: string) => guard(() => post('/api/meld/event', { event }));
  const current = ses.scenes.find(x => x.current) || ses.scenes[0];
  const mic = ses.tracks.find(t => /mic/i.test(t.name));
  const connection = <Sec title="Conexión" id="h-con">
    <ol className="steps"><li>En Meld: <b>Ajustes › Avanzado › Allow remote connections</b>.</li><li>Pulsa <b>Conectar</b>. Se reconecta solo si cierras Meld.</li></ol>
    <div className="row2"><label>Dirección <input value={url} onChange={e => setUrl(e.target.value)} className="mono" /></label>
      <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!m.autoSession} onChange={e => live.patchConfig({ meld: { autoSession: e.target.checked } })} /> Empezar un directo nuevo en el panel al empezar a emitir</label></div>
    {st.error && <ul className="errors"><li>{st.error}</li></ul>}
    <div className="row tight"><button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(() => post('/api/meld/connect', { url: url.trim() }), 'Conectando con Meld…')}>{on ? 'Reconectar' : 'Conectar'}</button><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/meld/disconnect'))}>Desconectar</button></div>
  </Sec>;
  return <>
    <header className="view-head"><div><span className="crumb">Meld y Stream Deck › Meld Studio</span><h1>Meld Studio</h1><p className="hint">Cambia de escena, muestra capas y lanza efectos desde las alertas, el panel, los atajos o el MCP.</p></div>
      <div className="actions">
        {on ? <Status tone="success" icon={IC.check}>Conectado · {m.url || 'ws://127.0.0.1:13376'}</Status> : <Status tone={st.state === 'error' ? 'danger' : 'neutral'} icon={IC.plug}>{st.state || 'Sin conectar'}</Status>}
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/meld/connect', { url: (url || m.url || '').trim() }), 'Conectando con Meld…')}>{on ? 'Reconectar' : 'Conectar'}</button>
      </div></header>
    {!on ? connection : <>
      <section aria-label="Atajos" className="row tight meld-quick">
        <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={guard(async () => { await post('/api/meld/command', { command: 'meld.recordClip' }); await post('/api/markers', {}); }, 'Clip guardado y momento marcado')}><Icon d={IC.bookmark} className="eg-btn__icon" />Guardar clip y marcar</button>
        {mic && <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/meld/track', { track: mic.id, action: 'mute' }))}><Icon d={mic.muted ? IC.mic : IC.micOff} className="eg-btn__icon" />{mic.muted ? 'Activar micro' : 'Silenciar micro'}</button>}
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={evt('CONFETTIPOP_TRIGGER')}><Icon d={IC.sparkle} className="eg-btn__icon" />Confeti</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={evt('CONFETTIFALL_TRIGGER')}>Lluvia de confeti</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={evt('WHEELSPIN_SPIN')}>Girar ruleta</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={cmd('meld.screenshot', 'Captura guardada')}><Icon d={IC.camera} className="eg-btn__icon" />Captura</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={cmd('meld.toggleRecordingAction')}><Icon d={IC.record} className="eg-btn__icon" />{ses.recording ? 'Parar grabación' : 'Grabar'}</button>
        <span className="hint" style={{ marginLeft: 'auto' }}>{ses.streaming ? 'Emitiendo' : 'Sin emitir'}{ses.recording ? ' · grabando' : ''}</span>
      </section>
      <Sec flat title="Escenas" id="h-esc" aside={<span className="hint">Pulsa una escena para ponerla en directo</span>}>
        <div className="scene-tiles">{ses.scenes.map(sc => <button key={sc.id} type="button" className={cx('eg-tile', sc.current && 'eg-tile--live')} aria-pressed={!!sc.current} onClick={guard(() => post('/api/meld/scene', { scene: sc.id }))}>
          <span className="eg-tile__thumb"><span className="tile-scene">{sc.name}</span>{sc.current && <span className="eg-tile__badge"><span className="eg-tag eg-tag--solid">En directo</span></span>}</span>
          <span className="eg-tile__name">{sc.name}</span><span className="eg-tile__meta">{sc.layers.length} {sc.layers.length === 1 ? 'capa' : 'capas'}{sc.layers.some(l => l.url?.includes('/overlay') || l.url?.includes('/widget/')) ? ' · egdev' : ''}</span>
        </button>)}</div>
      </Sec>
      <div className="cols">
        <Sec flat title={<>Capas · {current?.name || '—'}</>} id="h-cap">
          <div className="rows">{(current?.layers || []).length ? current!.layers.map(l => <article key={l.id} className={cx('eg-post eg-post--row', !l.visible && 'is-off')}>
            <div className="eg-post__content"><b>{l.name}</b><span className="eg-post__meta">{layerMeta(l)}{l.visible ? '' : ' · oculta'}{(l.url?.includes('/overlay') || l.url?.includes('/widget/')) ? ' · antena' : ''}</span></div>
            <IconBtn icon={l.visible ? IC.eye : IC.eyeOff} label={`${l.visible ? 'Ocultar' : 'Mostrar'} ${l.name}`} pressed={!!l.visible} onClick={guard(() => post('/api/meld/layer', { scene: current!.id, layer: l.id }))} />
          </article>) : <p className="hint">Esta escena no tiene capas.</p>}</div>
        </Sec>
        <Sec title="Audio" id="h-aud">
          <div className="rows">{ses.tracks.length ? ses.tracks.map(t => <div key={t.id} className="track">
            <span className="grow"><b>{t.name}</b><span className="hint">{t.muted ? ' · silenciada' : ''}</span></span>
            <IconBtn icon={t.muted ? IC.volumeOff : /mic/i.test(t.name) ? IC.mic : IC.volume} label={`${t.muted ? 'Activar' : 'Silenciar'} ${t.name}`} pressed={!t.muted} className={cx(t.muted && 'is-muted')} onClick={guard(() => post('/api/meld/track', { track: t.id, action: 'mute' }))} />
          </div>) : <p className="hint">Meld no ha mandado pistas de audio.</p>}</div>
          <p className="hint">La ganancia de cada pista se cambia en Meld o con una acción del MCP; aquí, silenciar y activar.</p>
        </Sec>
      </div>
      {connection}
    </>}
  </>;
}

// ---------- Filtros y voz ----------
export function Filtros() {
  const f = useLive(s => s.config.filters);
  const t = useLive(s => s.config.tts);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => ('speechSynthesis' in window ? speechSynthesis.getVoices() : []));
  const [say, setSay] = useState('Gracias por el apoyo, construimos criterio juntos');
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const h = () => setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', h);
    return () => speechSynthesis.removeEventListener('voiceschanged', h);
  }, []);
  const F = (patch: Partial<FiltersConfig>) => live.patchConfig({ filters: patch });
  const T = (patch: Partial<TtsConfig>) => live.patchConfig({ tts: patch });
  const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean);
  const sorted = [...voices.filter(v => /^es/i.test(v.lang)), ...voices.filter(v => !/^es/i.test(v.lang))];
  return <>
    <header className="view-head"><div><span className="crumb">Ajustes › Filtros y voz</span><h1>Filtros y voz</h1></div></header>
    <div className="grid2">
      <Panel title="Filtro" aside={<Switch checked={!!f.enabled} onChange={x => F({ enabled: x })}>Activado</Switch>}>
        <p className="hint" style={{ marginBottom: 12 }}>Se aplica a las alertas, la voz y el chat en pantalla. Sin distinguir mayúsculas ni tildes, y solo palabras completas.</p>
        <label>Palabras prohibidas (una por línea) <LazyInput as="textarea" style={{ minHeight: 120 }} value={(f.blockedWords || []).join('\n')} onCommit={v => F({ blockedWords: lines(v) })} /></label>
        <label>Sustituir por <input value={f.replaceWith} onChange={e => F({ replaceWith: e.target.value })} /></label>
        <label>Usuarios bloqueados (uno por línea): no generan alertas ni salen en el chat <LazyInput as="textarea" style={{ minHeight: 90 }} value={(f.blockedUsers || []).join('\n')} onCommit={v => F({ blockedUsers: lines(v) })} /></label>
        <div className="row2">
          <label className="check"><input type="checkbox" checked={f.blockLinks} onChange={e => F({ blockLinks: e.target.checked })} /> Cambiar enlaces por «[enlace]»</label>
          <label>Largo máximo de los mensajes <input type="number" min={20} value={f.maxMessageLength} onChange={e => F({ maxMessageLength: Number(e.target.value) })} /></label>
        </div>
      </Panel>
      <Panel title="Voz" aside={<Switch checked={!!t.enabled} onChange={x => T({ enabled: x })}>Activada</Switch>}>
        <p className="hint" style={{ marginBottom: 12 }}>Lee en el overlay los mensajes de las alertas que tengan la voz activada (bits, Super Chats, resubs…). Usa las voces de Windows.</p>
        <label>Voz <select value={t.voice || ''} onChange={e => T({ voice: e.target.value })}><option value="">Automática (español)</option>{sorted.map(v => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}</select></label>
        <div className="row3">
          <Range label="Velocidad" value={t.rate ?? 1} min={0.5} max={2} step={0.05} onChange={x => T({ rate: x })} />
          <Range label="Tono" value={t.pitch ?? 1} min={0} max={2} step={0.05} onChange={x => T({ pitch: x })} />
          <Range label="Volumen" value={t.volume ?? 1} min={0} max={1} step={0.05} onChange={x => T({ volume: x })} />
        </div>
        <label>Máximo de caracteres <input type="number" min={20} value={t.maxChars} onChange={e => T({ maxChars: Number(e.target.value) })} /></label>
        <div className="row"><input value={say} onChange={e => setSay(e.target.value)} style={{ flex: 1, margin: 0 }} /><button className="btn" onClick={guard(async () => { await live.flushConfig(); await post('/api/say', { text: say }); }, 'Enviado al overlay')}>Probar en el overlay</button></div>
      </Panel>
    </div>
  </>;
}

// ---------- Prompter ----------
export function PrompterAjustes() {
  const pr = useLive(s => s.config.prompter || {});
  const tracks = useLive(s => s.meld?.session?.tracks || []);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const desk = isDesktop();
  useEffect(() => { if (desk) listMonitors().then(items => setMonitors(items ?? [])).catch(e => toast(e.message, true)); }, [desk]);
  const P = (patch: Partial<PrompterConfig>) => live.patchConfig({ prompter: patch });
  const elgato = monitors.find(m => m.prompterLike);
  const open = guard(async () => {
    if (desk) { await live.flushConfig(); await openPrompter(pr.monitor || elgato?.name || '', true); }
    else window.open('/prompter', 'egdev-prompter', 'popup,width=1024,height=600');
  });
  return <>
    <header className="view-head"><div><span className="crumb">Meld y Stream Deck › Prompter</span><h1>Prompter</h1><p className="hint">Vista de 1024×600 para el Elgato Prompter: lees el chat y manejas los widgets mirando a cámara. Lo de un solo botón va al Stream Deck.</p></div>
      <div className="actions"><button className="btn" onClick={open}>{desk ? 'Abrir en el Prompter' : 'Abrir la vista'}</button></div></header>
    <div className="grid2">
      <Panel title="Pantalla">
        {desk ? <>
          <label>Monitor del Prompter
            <select value={pr.monitor || ''} onChange={e => P({ monitor: e.target.value })}>
              <option value="">{elgato ? `Automático: ${elgato.name} (${elgato.width}×${elgato.height})` : 'Automático (el de 1024×600)'}</option>
              {monitors.map(m => <option key={m.name} value={m.name}>{m.name} · {m.width}×{m.height}{m.primary ? ' · principal' : ''}{m.prompterLike ? ' · Elgato' : ''}</option>)}
            </select></label>
          <p className="hint">La app abre el prompter a pantalla completa en ese monitor. {elgato ? 'Se ha detectado una pantalla de 1024×600.' : 'No se ve ninguna pantalla de 1024×600: conecta el Prompter por USB-C.'}</p>
        </> : <ol className="steps">
          <li>Conecta el Prompter por USB-C: Windows lo ve como otra pantalla.</li>
          <li>Con la app de escritorio, «Abrir en el Prompter» la coloca sola. Desde el navegador: abre <code>{location.origin}/prompter</code> como ventana de app y arrástrala a esa pantalla.</li>
          <li>Pulsa <b>F11</b> para pantalla completa.</li>
        </ol>}
        <p className="hint">El Prompter da la vuelta a la imagen solo; si la ves al revés, activa «Espejo».</p>
      </Panel>
      <Panel title="Vista">
        <div className="row2">
          <Range label="Tamaño de letra" value={pr.fontSize ?? 22} min={16} max={32} unit="px" onChange={x => P({ fontSize: x })} />
          <label>Mensajes de chat en la vista <input type="number" min={20} max={200} value={pr.chatLines ?? 60} onChange={e => P({ chatLines: Number(e.target.value) })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={pr.hideCommands !== false} onChange={e => P({ hideCommands: e.target.checked })} /> Ocultar comandos y votos del chat (<code>!sorteo</code>, «S»…)</label>
        <label className="check"><input type="checkbox" checked={pr.autoSwitch !== false} onChange={e => P({ autoSwitch: e.target.checked })} /> Saltar solo al widget que se pone en marcha (votación, sorteo)</label>
        <label className="check"><input type="checkbox" checked={!!pr.mirror} onChange={e => P({ mirror: e.target.checked })} /> Espejo (solo si la imagen sale al revés)</label>
        <label>Pista del micro en Meld (avisa en grande si está silenciado)
          <select value={pr.micTrack || ''} onChange={e => P({ micTrack: e.target.value })}><option value="">Automática (la que se llame «mic…»)</option>{tracks.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}</select></label>
        <label>CSS propio de la vista <textarea className="code" spellCheck={false} value={pr.css || ''} onKeyDown={codeTab} onChange={e => P({ css: e.target.value })} placeholder=":root { --fs: 24px; --red: #00E0FF; }" /></label>
        <p className="hint">Los botones del Stream Deck para el prompter (cambiar de pestaña, marcar…) están en <a href="#/atajos">Atajos y Stream Deck</a>.</p>
      </Panel>
    </div>
  </>;
}
