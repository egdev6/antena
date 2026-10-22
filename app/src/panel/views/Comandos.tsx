// Listas de comandos de chat y de mensajes programados (el detalle se edita en Editor).
import { useState } from 'react';
import { enc, get, post } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { cx, EmptyState, guard, Panel, PLATFORM_NAMES, Sec, toast, ViewHead } from '../../lib/ui';
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
    <ViewHead crumb="Chat › Comandos de chat" title="Comandos de chat" hint="Cuando alguien escribe el comando en Twitch o YouTube, sale su alerta en el overlay." actions={<><input value={trigger} onChange={e => setTrigger(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} placeholder="!engram" aria-label="Nuevo comando" /><button className="eg-btn eg-btn--primary" onClick={create}>Crear comando</button></>} />
    <Panel>
      {list.length ? <div className="rows cmd-rows">{list.map(c => <article key={c.id} className={cx('eg-post eg-post--row', c.enabled === false && 'is-off')}>
        <div className="eg-post__content"><b><a href={`#/comando/${enc(c.id)}`}><code>{c.trigger}</code></a></b>
          <span className="eg-post__meta">{PERMS.find(p => p[0] === c.permission)?.[1] || ''} · espera {c.cooldownSec}s · {(c.platforms || []).map(p => PLATFORM_NAMES[p] || p).join(' y ')}</span></div>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/test', { commandId: c.id }))}>Probar</button><a className="eg-btn eg-btn--ghost eg-btn--sm" href={`#/comando/${enc(c.id)}`}>Editar</a>
      </article>)}</div> : <EmptyState>Todavía no hay comandos. Prueba con <code>!engram</code> o <code>!web</code>.</EmptyState>}
    </Panel>
    <Panel title="Probar sin estar en directo">
      <div className="row2"><label>Usuario <input value={sim.user} onChange={e => setSim({ ...sim, user: e.target.value })} /></label><label>Mensaje <input value={sim.text} placeholder="!engram memoria" onChange={e => setSim({ ...sim, text: e.target.value })} /></label></div>
      <div className="row"><label className="check"><input type="checkbox" checked={sim.mod} onChange={e => setSim({ ...sim, mod: e.target.checked })} /> Es moderador</label>
        <button className="eg-btn eg-btn--ghost push" onClick={guard(() => post('/api/chat/simulate', sim), 'Mensaje simulado enviado')}>Enviar al chat simulado</button></div>
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
    <ViewHead crumb="Chat › Mensajes programados" title="Mensajes programados" hint="Se publican solos en tu chat de Twitch, de YouTube o en los dos cada cierto tiempo y, si quieres, también salen como alerta en pantalla." actions={<><button className="eg-btn eg-btn--primary" onClick={create}>+ Nuevo mensaje</button></>} />
    <Sec title="Lista de mensajes" foot={<>Cada 15 s se mira si toca publicar alguno. Si varios coinciden, salen en el mismo repaso. El botón de pausa los detiene, también «Enviar ahora»; al reanudar, cada uno vuelve a contar su intervalo completo. Lo que escribes tú en el chat no se pausa.</>} footRight={<>{list.length === 1 ? '1 mensaje' : `${list.length} mensajes`}</>}>
      {list.length ? <div className="rows cmd-rows">{list.map(t => <article key={t.id} className={cx('eg-post eg-post--row', t.enabled === false && 'is-off')}>
        <div className="eg-post__content"><b><a href={`#/mensaje/${enc(t.id)}`}>{t.name}</a></b>
          <span className="eg-post__meta">cada {t.intervalMin} min · {t.destination === 'both' ? 'Twitch y YouTube' : PLATFORM_NAMES[t.destination ?? 'twitch'] || 'Twitch'}{t.minChatLines ? ` · si hay ${t.minChatLines}+ mensajes` : ''}{t.announce ? ' · anuncio' : ''}{t.showAlert ? ' · en pantalla' : ''}</span>
          <span className="tmsg">{t.message}</span>
          <span className="eg-post__meta"><TimerState id={t.id} /></span></div>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => fireTimer(t.id))}>Enviar ahora</button><a className="eg-btn eg-btn--ghost eg-btn--sm" href={`#/mensaje/${enc(t.id)}`}>Editar</a>
      </article>)}</div> : <EmptyState>Todavía no hay mensajes. Por ejemplo: «¿Ya sigues el canal? Directos cada miércoles a las 19:00 · egdev.es».</EmptyState>}
    </Sec>
  </>;
}
void toast;
