// Listas de comandos de chat y de mensajes programados (el detalle se edita en Editor).
import { useState } from 'react';
import { enc, get, post } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { EmptyState, guard, Panel, PLATFORM_NAMES, Sec, toast } from '../../lib/ui';
import { go } from '../router';
import type { CommandConfig, TimerConfig } from '../../lib/types';
import { fireTimer, PERMS, TimerState } from './Editor';
import { useEffect } from 'react';

export function Comandos() {
  const list = useLive(s => s.config.commands || []);
  const [trigger, setTrigger] = useState('');
  const [sim, setSim] = useState({ user: 'espectador', text: '', mod: false });
  const create = guard(async () => {
    const t = trigger.trim() || '!nuevo';
    const d = await post<{ command: CommandConfig }>('/api/commands', { trigger: t, title: t.replace(/^!/, ''), text: '{user}', sub: '{args}' });
    live.update(s => ({ config: { ...s.config, commands: [...(s.config.commands || []), d.command] } }));
    go(`#/comando/${enc(d.command.id)}`);
  });
  return <>
    <header className="view-head"><div><span className="crumb">Chat › Comandos</span><h1>Comandos de chat</h1><p className="hint">Cuando alguien escribe el comando en Twitch o YouTube, sale su alerta en el overlay.</p></div>
      <div className="actions"><input value={trigger} onChange={e => setTrigger(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} placeholder="!engram" style={{ width: 180, margin: 0 }} aria-label="Nuevo comando" /><button className="btn" onClick={create}>Crear comando</button></div></header>
    <Panel>
      {list.length ? <ul className="cmdlist">{list.map(c => <li key={c.id} className={c.enabled === false ? 'off' : ''}>
        <a href={`#/comando/${enc(c.id)}`}><code>{c.trigger}</code></a>
        <span className="vcond">{PERMS.find(p => p[0] === c.permission)?.[1] || ''} · espera {c.cooldownSec}s · {(c.platforms || []).map(p => PLATFORM_NAMES[p] || p).join(' y ')}</span>
        <span className="vbtns"><button className="btn ghost sm" onClick={guard(() => post('/api/test', { commandId: c.id }))}>Probar</button><a className="btn ghost sm" href={`#/comando/${enc(c.id)}`}>Editar</a></span>
      </li>)}</ul> : <EmptyState>Todavía no hay comandos. Prueba con <code>!engram</code> o <code>!web</code>.</EmptyState>}
    </Panel>
    <Panel title="Probar sin estar en directo">
      <div className="row2"><label>Usuario <input value={sim.user} onChange={e => setSim({ ...sim, user: e.target.value })} /></label><label>Mensaje <input value={sim.text} placeholder="!engram memoria" onChange={e => setSim({ ...sim, text: e.target.value })} /></label></div>
      <div className="row"><label className="check"><input type="checkbox" checked={sim.mod} onChange={e => setSim({ ...sim, mod: e.target.checked })} /> Es moderador</label>
        <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={guard(() => post('/api/chat/simulate', sim), 'Mensaje simulado enviado')}>Enviar al chat simulado</button></div>
    </Panel>
  </>;
}

export function Mensajes() {
  const list = useLive(s => s.timers || []);
  useEffect(() => {
    const h = setInterval(guard(async () => { const t = await get<{ timers?: TimerConfig[] }>('/api/timers'); live.update(() => ({ timers: t.timers ?? (t as unknown as TimerConfig[]) })); }), 5000);
    return () => clearInterval(h);
  }, []);
  const create = guard(async () => {
    const d = await post<{ timer: TimerConfig }>('/api/timers', { name: `Mensaje ${list.length + 1}` });
    const t = await get<{ timers?: TimerConfig[] }>('/api/timers');
    live.update(s => ({ config: { ...s.config, timers: [...(s.config.timers || []), d.timer] }, timers: t.timers ?? (t as unknown as TimerConfig[]) }));
    go(`#/mensaje/${enc(d.timer.id)}`);
  });
  return <>
    <header className="view-head"><div><span className="crumb">Chat › Mensajes programados</span><h1>Mensajes programados</h1><p className="hint">Se publican solos en tu chat de Twitch, de YouTube o en los dos cada cierto tiempo y, si quieres, también salen como alerta en pantalla.</p></div>
      <div className="actions"><button className="btn" onClick={create}>+ Nuevo mensaje</button></div></header>
    <Sec title="Lista de mensajes" foot={<>Cada 15 s se mira si toca publicar alguno. Si varios coinciden, salen en el mismo repaso. El botón de pausa los detiene, también «Enviar ahora»; al reanudar, cada uno vuelve a contar su intervalo completo. Lo que escribes tú en el chat no se pausa.</>} footRight={<>{list.length === 1 ? '1 mensaje' : `${list.length} mensajes`}</>}>
      {list.length ? <ul className="cmdlist timerlist">{list.map(t => <li key={t.id} className={t.enabled === false ? 'off' : ''}>
        <a href={`#/mensaje/${enc(t.id)}`} className="tname">{t.name}</a>
        <span className="vcond">cada {t.intervalMin} min · {t.destination === 'both' ? 'Twitch y YouTube' : PLATFORM_NAMES[t.destination ?? 'twitch'] || 'Twitch'}{t.minChatLines ? ` · si hay ${t.minChatLines}+ mensajes` : ''}{t.announce ? ' · anuncio' : ''}{t.showAlert ? ' · en pantalla' : ''}</span>
        <span className="tmsg">{t.message}</span>
        <span className="tstate"><TimerState id={t.id} /></span>
        <span className="vbtns"><button className="btn ghost sm" onClick={guard(() => fireTimer(t.id))}>Enviar ahora</button><a className="btn ghost sm" href={`#/mensaje/${enc(t.id)}`}>Editar</a></span>
      </li>)}</ul> : <EmptyState>Todavía no hay mensajes. Por ejemplo: «¿Ya sigues el canal? Directos cada miércoles a las 19:00 · egdev.es».</EmptyState>}
    </Sec>
  </>;
}
void toast;
