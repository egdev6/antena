// Comandos de chat y mensajes programados (v2): listado → slide (Editor). «Nuevo» abre el mismo slide
// pidiendo solo lo mínimo y una plantilla; al crear, aparecen el resto de pestañas.
import { useEffect, useState, type ReactNode } from 'react';
import { enc, get, post } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { guard, PLATFORM_NAMES } from '../../lib/ui';
import { Box, Dot, Kpis, ListPanel, NameCell, PageHead, Slide, Tags, useListFilter } from '../../lib/layout';
import { go } from '../router';
import type { CommandConfig, TimerConfig } from '../../lib/types';
import { DESTINATIONS, Editor, fireTimer, PERMS } from './Editor';

function NewSlide({ crumb, title, back, children, create, canCreate, createLabel }: { crumb: ReactNode; title: string; back: string; children: ReactNode; create: () => void; canCreate: boolean; createLabel: string }) {
  return <Slide crumb={crumb} title={title} back={back} tabs={[{ id: 'min', label: 'Lo mínimo' }, { id: 'rest', label: 'El resto, al crear', locked: true }]} tab="min" onTab={() => {}}
    foot={<footer className="lv-sfoot sticky"><span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href={back}>Cancelar</a><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" disabled={!canCreate} onClick={create}>{createLabel}</button></footer>}>
    <div className="lv-cols aside"><div className="lv-col">{children}</div>
      <aside className="lv-col"><Box title="Crear"><p className="hint">Solo pide lo mínimo. Al crear se abren el resto de pestañas en este mismo panel, ya rellenas con la plantilla. Todo se puede cambiar después.</p></Box></aside></div>
  </Slide>;
}
function Tiles({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string, string][] }) {
  return <div className="lv-tiles" role="radiogroup" aria-label="Plantilla">{items.map(([id, t, d]) => <button key={id} type="button" role="radio" className="lv-tile" aria-pressed={value === id} aria-checked={value === id} onClick={() => onChange(id)}><b>{t}</b><span>{d}</span></button>)}</div>;
}

// ---------- comandos ----------
const CMD_TEMPLATES: [string, string, string][] = [
  ['alerta', 'Alerta en pantalla', 'Saca su alerta con quién lo escribe y lo que va detrás'],
  ['chat', 'Alerta y respuesta', 'Además contesta en el chat (Twitch y YouTube)'],
  ['meld', 'Alerta y escena', 'Además cambia de escena en Meld unos segundos'],
];
function NuevoComando() {
  const [trigger, setTrigger] = useState('!');
  const [perm, setPerm] = useState('everyone');
  const [tpl, setTpl] = useState('alerta');
  const ok = /^[!¡?.#]\S+$/.test(trigger.trim());
  const create = guard(async () => {
    const t = trigger.trim();
    const actions = tpl === 'chat' ? [{ kind: 'chat', text: 'Escribe aquí la respuesta para {user}', destination: 'both', delaySec: 0 }]
      : tpl === 'meld' ? [{ kind: 'scene', scene: '', returnAfterSec: 10, delaySec: 0 }] : [];
    const d = await post<{ command: CommandConfig }>('/api/commands', { trigger: t, permission: perm, title: t.replace(/^[!¡?.#]/, ''), text: '{user}', sub: '{args}', actions });
    live.update(s => ({ config: { ...s.config, commands: [...(s.config.commands || []), d.command] } }));
    go(`#/comandos/${enc(d.command.id)}`);
  });
  return <NewSlide crumb={<><a href="#/comandos">Comandos de chat</a> › Nuevo</>} title="Nuevo comando" back="#/comandos" create={create} canCreate={ok} createLabel="Crear comando">
    <Box title="Lo mínimo"><div className="row2">
      <label>Disparador <input value={trigger} autoFocus onChange={e => setTrigger(e.target.value.replace(/\s/g, ''))} onKeyDown={e => { if (e.key === 'Enter' && ok) create(); }} placeholder="!discord" className="mono" /><span className="hint">Lo que escribe el chat. Empieza por ! o ¡.</span></label>
      <label>Quién puede usarlo <select value={perm} onChange={e => setPerm(e.target.value)}>{PERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    </div></Box>
    <Box title="Plantilla de partida"><Tiles value={tpl} onChange={setTpl} items={CMD_TEMPLATES} /></Box>
  </NewSlide>;
}

export function Comandos({ parts }: { parts: string[] }) {
  const list = useLive(s => s.config.commands || []);
  const f = useListFilter();
  const [sim, setSim] = useState({ user: 'espectador', text: '', mod: false });
  const open = parts[1];
  const rows = list.filter(c => f.chip === 'all' || (f.chip === 'off' ? c.enabled === false : f.chip === 'actions' ? (c.actions || []).length > 0 : c.permission !== 'everyone'))
    .filter(c => f.match(c.trigger, c.title))
    .map(c => {
      const href = `#/comandos/${enc(c.id)}`;
      return { id: c.id, href, open: open === c.id, cls: c.enabled === false ? 'is-off' : undefined, cells: {
        name: <NameCell href={href} name={<span className="mono">{c.trigger}</span>} sub={[c.title, c.sub].filter(Boolean).join(' · ')} />,
        state: <Dot tone={c.enabled === false ? 'off' : 'ok'}>{c.enabled === false ? 'Apagado' : 'Activo'}</Dot>,
        perm: PERMS.find(p => p[0] === c.permission)?.[1] || 'Todo el mundo',
        tags: <Tags items={[...(c.platforms || ['twitch', 'youtube']).map(p => ({ t: PLATFORM_NAMES[p] || p })), ...((c.actions || []).length ? [{ t: `${c.actions!.length} ${c.actions!.length === 1 ? 'acción' : 'acciones'}`, on: true }] : []), ...(c.ttsEnabled ? [{ t: 'Voz', on: true }] : [])]} />,
        wait: <span className="lv-mono">{c.cooldownSec ? `${c.cooldownSec} s` : 'sin espera'}{c.userCooldownSec ? ` · ${c.userCooldownSec} s/persona` : ''}</span>,
        test: <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/test', { commandId: c.id }), 'Enviado al directo')}>Probar</button>,
      } };
    });
  const n = (fn: (c: CommandConfig) => boolean) => list.filter(fn).length;
  return <>
    <PageHead crumb={`Configurar · ${list.length} ${list.length === 1 ? 'comando' : 'comandos'}`} title="Comandos de chat"
      desc="Cuando alguien escribe el comando en Twitch o YouTube, sale su alerta y se lanzan sus acciones."
      actions={<a className="eg-btn eg-btn--primary eg-btn--sm" href="#/comandos/nuevo">+ Nuevo comando</a>} />
    <Kpis items={[
      { value: list.length, label: `comandos · ${n(c => c.enabled !== false)} activos` },
      { value: n(c => (c.actions || []).length > 0), label: 'con acciones (chat, Meld…)' },
      { value: n(c => c.permission !== 'everyone' && !!c.permission), label: 'solo para algunos' },
      { value: n(c => !!c.ttsEnabled), label: 'leídos en voz alta' },
    ]} />
    <ListPanel title="Comandos" note="Lo que el chat escribe con ! o ¡ y lo que pasa." search={f.q} onSearch={f.setQ} placeholder="Buscar !comando"
      chips={[['all', 'Todos'], ['actions', 'Con acciones'], ['perm', 'Con permiso'], ['off', 'Apagados']]} chip={f.chip} onChip={f.setChip}
      cols={[{ key: 'name', label: 'Comando' }, { key: 'state', label: 'Estado' }, { key: 'perm', label: 'Quién' }, { key: 'tags', label: 'Lleva' }, { key: 'wait', label: 'Espera', hide: true }, { key: 'test', label: '' }]}
      rows={rows} empty={list.length ? 'Ningún comando coincide.' : <>Todavía no hay comandos. Prueba con <code>!discord</code> o <code>!web</code>. <a href="#/comandos/nuevo">Crear el primero</a></>} />
    <section className="lv-panel lv-gap" aria-labelledby="cm-sim">
      <div className="lv-panel-h"><h2 id="cm-sim">Probar sin estar en directo</h2><p>Simula un mensaje del chat para ver qué comando salta.</p></div>
      <div className="lv-panel-b">
        <div className="row2"><label>Usuario <input value={sim.user} onChange={e => setSim({ ...sim, user: e.target.value })} /></label><label>Mensaje <input value={sim.text} placeholder="!discord" onChange={e => setSim({ ...sim, text: e.target.value })} /></label></div>
        <div className="row"><label className="check"><input type="checkbox" checked={sim.mod} onChange={e => setSim({ ...sim, mod: e.target.checked })} /> Es moderador</label>
          <button className="eg-btn eg-btn--ghost eg-btn--sm push" onClick={guard(() => post('/api/chat/simulate', sim), 'Mensaje simulado enviado')}>Enviar al chat simulado</button></div>
      </div>
    </section>
    {open === 'nuevo' ? <NuevoComando /> : open && list.some(c => c.id === open) ? <Editor key={`c-${open}`} target={{ kind: 'command', id: open }} /> : null}
  </>;
}

// ---------- mensajes programados ----------
const fmtNext = (sec: number) => { if (sec <= 0) return 'ya'; const m = Math.floor(sec / 60), s2 = sec % 60; return m ? `${m} min${s2 ? ` ${s2} s` : ''}` : `${s2} s`; };
const MSG_TEMPLATES: [string, string, string][] = [
  ['chat', 'Recordatorio', 'Un mensaje normal en el chat'],
  ['announce', 'Anuncio destacado', 'Resaltado en Twitch (en YouTube, mensaje normal)'],
  ['alert', 'Chat y pantalla', 'Además sale como alerta en el overlay'],
];
function NuevoMensaje() {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [every, setEvery] = useState(15);
  const [dest, setDest] = useState('twitch');
  const [tpl, setTpl] = useState('chat');
  const ok = !!message.trim();
  const create = guard(async () => {
    const d = await post<{ timer: TimerConfig }>('/api/timers', { name: name.trim() || message.trim().slice(0, 40), message: message.trim(), intervalMin: every, destination: dest, announce: tpl === 'announce', showAlert: tpl === 'alert' });
    const t = await get<{ timers?: TimerConfig[] }>('/api/timers');
    live.update(s => ({ config: { ...s.config, timers: [...(s.config.timers || []), d.timer] }, timers: t.timers ?? (t as unknown as TimerConfig[]) }));
    go(`#/mensajes/${enc(d.timer.id)}`);
  });
  return <NewSlide crumb={<><a href="#/mensajes">Mensajes programados</a> › Nuevo</>} title="Nuevo mensaje" back="#/mensajes" create={create} canCreate={ok} createLabel="Crear mensaje">
    <Box title="Lo mínimo">
      <label>Mensaje <textarea value={message} autoFocus onChange={e => setMessage(e.target.value)} style={{ minHeight: 70, fontFamily: 'var(--f-body)', fontSize: 14 }} placeholder="¿Ya sigues el canal? Directos cada miércoles a las 19:00 · egdev.es" /></label>
      <div className="row3">
        <label>Nombre <input value={name} onChange={e => setName(e.target.value)} placeholder="Recordatorio de redes" /></label>
        <label>Cada (minutos) <input type="number" min={1} value={every} onChange={e => setEvery(Math.max(1, Number(e.target.value) || 1))} /></label>
        <label>Dónde <select value={dest} onChange={e => setDest(e.target.value)}>{DESTINATIONS.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></label>
      </div>
    </Box>
    <Box title="Plantilla de partida"><Tiles value={tpl} onChange={setTpl} items={MSG_TEMPLATES} /></Box>
  </NewSlide>;
}

export function Mensajes({ parts }: { parts: string[] }) {
  const list = useLive(s => s.timers || []);
  const f = useListFilter();
  const open = parts[1];
  useEffect(() => {
    const h = setInterval(guard(async () => { const t = await get<{ timers?: TimerConfig[] }>('/api/timers'); live.update(() => ({ timers: t.timers ?? (t as unknown as TimerConfig[]) })); }), 5000);
    return () => clearInterval(h);
  }, []);
  const dest = (d?: string) => (d === 'both' ? 'Twitch y YouTube' : PLATFORM_NAMES[d ?? 'twitch'] || 'Twitch');
  const rows = list.filter(t => f.chip === 'all' || (f.chip === 'off' ? t.enabled === false : f.chip === 'alert' ? !!t.showAlert : !!t.runtime?.lastError))
    .filter(t => f.match(t.name, t.message))
    .map(t => {
      const r = t.runtime || {};
      const href = `#/mensajes/${enc(t.id)}`;
      const state = t.enabled === false ? <Dot tone="off">Apagado</Dot> : r.lastError ? <Dot tone="warn">Error al enviar</Dot> : r.blockedBy ? <Dot tone="warn">Esperando: {r.blockedBy}</Dot> : <Dot tone="ok">{(r.nextInSec || 0) > 0 ? `Sale en ${fmtNext(r.nextInSec || 0)}` : 'Sale en el próximo repaso'}</Dot>;
      return { id: t.id, href, open: open === t.id, cls: t.enabled === false ? 'is-off' : undefined, cells: {
        name: <NameCell href={href} name={t.name} sub={t.message} />,
        state,
        every: <span className="lv-mono">cada {t.intervalMin} min</span>,
        dest: dest(t.destination),
        tags: <Tags items={[...(t.announce ? [{ t: 'Anuncio', on: true }] : []), ...(t.showAlert ? [{ t: 'En pantalla', on: true }] : []), ...(t.minChatLines ? [{ t: `si hay ${t.minChatLines}+ mensajes` }] : [])]} />,
        send: <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => fireTimer(t.id))}>Enviar ahora</button>,
      } };
    });
  const n = (fn: (t: TimerConfig) => boolean) => list.filter(fn).length;
  return <>
    <PageHead crumb={`Configurar · ${list.length} ${list.length === 1 ? 'mensaje' : 'mensajes'}`} title="Mensajes programados"
      desc="Se publican solos en tu chat de Twitch, de YouTube o en los dos cada cierto tiempo y, si quieres, también salen como alerta en pantalla."
      actions={<a className="eg-btn eg-btn--primary eg-btn--sm" href="#/mensajes/nuevo">+ Nuevo mensaje</a>} />
    <Kpis items={[
      { value: list.length, label: `mensajes · ${n(t => t.enabled !== false)} activos` },
      { value: n(t => !!t.announce), label: 'como anuncio destacado' },
      { value: n(t => !!t.showAlert), label: 'también en pantalla' },
      { value: n(t => !!t.runtime?.lastError), label: 'con error en el último envío', warn: n(t => !!t.runtime?.lastError) > 0 },
    ]} />
    <ListPanel title="Mensajes" note="Pulsa una fila para editarlo." foot={<>Cada 15 s se mira si toca publicar alguno; si varios coinciden, salen en el mismo repaso. El botón de pausa los detiene, también «Enviar ahora»; al reanudar, cada uno vuelve a contar su intervalo completo. Lo que escribes tú en el chat no se pausa.</>} search={f.q} onSearch={f.setQ} placeholder="Buscar mensaje"
      chips={[['all', 'Todos'], ['alert', 'En pantalla'], ['error', 'Con error'], ['off', 'Apagados']]} chip={f.chip} onChip={f.setChip}
      cols={[{ key: 'name', label: 'Mensaje' }, { key: 'state', label: 'Estado' }, { key: 'every', label: 'Frecuencia' }, { key: 'dest', label: 'Dónde', hide: true }, { key: 'tags', label: 'Lleva', hide: true }, { key: 'send', label: '' }]}
      rows={rows} empty={list.length ? 'Ningún mensaje coincide.' : <>Todavía no hay mensajes. Por ejemplo: «¿Ya sigues el canal? Directos cada miércoles a las 19:00 · egdev.es». <a href="#/mensajes/nuevo">Crear el primero</a></>} />
    {open === 'nuevo' ? <NuevoMensaje /> : open && list.some(t => t.id === open) ? <Editor key={`t-${open}`} target={{ kind: 'timer', id: open }} /> : null}
  </>;
}
