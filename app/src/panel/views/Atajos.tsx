// Atajos: botones del Stream Deck. Los de serie (/sd/…) y los personalizados (/sd/custom/<id>),
// que encadenan pasos: acciones de antena (marca, pausa, pregunta…) y de Meld (escena, capa, chat…).
import { useEffect, useRef, useState } from 'react';
import { ManualDraft } from '../../lib/manual-draft';
import { del, enc, get, post, put } from '../../lib/api';
import { live } from '../../lib/live';
import { confirmDelete, copy, cx, guard, IconBtn, Panel, toast } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { isSaving, registerDraft, useDraftVersion, useManualSave } from '../../lib/draft';
import { Box, ListPanel, NameCell, PageHead, SaveBar, Slide, Tags } from '../../lib/layout';
import { go } from '../router';
import { ACTIONS, ActionFields } from './Editor';

export const SD_HELP: Record<string, string> = {
  marca: 'Marca de short (con su minuto y marcador de Twitch)', pausa: 'Pausar / reanudar alertas', saltar: 'Saltar la alerta en pantalla',
  'siguiente-pregunta': 'Sacar la siguiente pregunta', 'ocultar-pregunta': 'Quitar la pregunta de pantalla', 'cerrar-votacion': 'Cerrar la votación de la tier list',
  'abrir-sorteo': 'Abrir el sorteo', 'cerrar-sorteo': 'Cerrar la inscripción', sortear: 'Sortear', agradecido: 'Marcar como agradecido el más antiguo pendiente',
};
const TAB_NAMES: Record<string, string> = { preguntas: 'Preguntas', tierlist: 'Tier list', sorteo: 'Sorteo', cronologia: 'Cronología' };
export const sdLabel = (a: string) => SD_HELP[a] || (a.startsWith('prompter/') ? `Prompter: pestaña ${TAB_NAMES[a.split('/')[1]] || a.split('/')[1]}` : a);
const COLORS = ['', '#FF3B5C', '#FF8FA6', '#00E0FF', '#7CFF6B', '#FFC94D', '#B58CFF'];

type Step = { kind: string; action?: string; arg?: string; [k: string]: any };
type Shortcut = { id: string; name: string; color?: string; steps: Step[]; path?: string };
type Info = { actions: string[]; custom: Shortcut[]; builtins: string[]; prompterTabs: string[] };

const stepValue = (st: Step) => (st.kind === 'builtin' ? `b:${st.action}` : st.kind);
export function stepText(st: Step) {
  if (st.kind === 'builtin') return st.action === 'prompter' ? `Prompter: ${TAB_NAMES[st.arg || ''] || st.arg}` : SD_HELP[st.action || ''] || st.action;
  const what = st.scene || st.layer || st.text || st.command?.replace('meld.', '') || st.event || st.effect || '';
  return `${ACTIONS[st.kind] || st.kind}${what ? ` · ${what}` : ''}`;
}

function StepsEditor({ steps, info, onChange }: { steps: Step[]; info: Info; onChange: (s: Step[]) => void }) {
  const repl = (i: number, st: Step) => { const l = [...steps]; l[i] = st; onChange(l); };
  const setKind = (i: number, v: string) => {
    if (v.startsWith('b:')) { const action = v.slice(2); repl(i, action === 'prompter' ? { kind: 'builtin', action, arg: info.prompterTabs[0] } : { kind: 'builtin', action }); }
    else repl(i, { kind: v, delaySec: 0 });
  };
  const move = (i: number, d: number) => { const l = [...steps]; [l[i], l[i + d]] = [l[i + d], l[i]]; onChange(l); };
  return <div className="actions-list">
    {steps.map((st, i) => <div className="action" key={i}>
      <span className="step-n">{i + 1}</span>
      <select value={stepValue(st)} onChange={e => setKind(i, e.target.value)} aria-label="Qué hace">
        <optgroup label="antena">{info.builtins.map(b => <option key={b} value={`b:${b}`}>{SD_HELP[b] || b}</option>)}<option value="b:prompter">Cambiar la pestaña del prompter</option></optgroup>
        <optgroup label="Meld, chat y voz">{Object.entries(ACTIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</optgroup>
      </select>
      {st.kind === 'builtin'
        ? <div className="afields">{st.action === 'prompter' && <label>Pestaña<select value={st.arg} onChange={e => repl(i, { ...st, arg: e.target.value })}>{info.prompterTabs.map(t => <option key={t} value={t}>{TAB_NAMES[t] || t}</option>)}</select></label>}</div>
        : <ActionFields act={st} uid={'s' + i} onChange={a => repl(i, a)} />}
      <span className="vbtns">
        <IconBtn icon={IC.up} label="Subir" disabled={i === 0} onClick={() => move(i, -1)} />
        <IconBtn icon={IC.down} label="Bajar" disabled={i === steps.length - 1} onClick={() => move(i, 1)} />
        <IconBtn icon={IC.x} label="Quitar paso" onClick={() => onChange(steps.filter((_, j) => j !== i))} />
      </span>
    </div>)}
  </div>;
}

type Draft = { name: string; color?: string; steps: Step[] };
function ShortcutSlide({ sc, info, base, onSaved, onDeleted }: { sc: Shortcut; info: Info; base: string; onSaved: (s: Shortcut) => void; onDeleted: () => void }) {
  useManualSave();
  useDraftVersion();
  const [d, setD] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const savedRef = useRef(sc); savedRef.current = sc;
  const [buffer] = useState(() => new ManualDraft<Partial<Draft>, Shortcut>({
    empty: () => ({}), merge: (older, newer) => ({ ...older, ...newer }),
    take: () => savedRef.current,
    persist: async patch => (await put<{ shortcut: Shortcut }>('/api/shortcuts/' + enc(sc.id), patch)).shortcut,
    publish: (saved, newer) => { savedRef.current = saved; onSaved(saved); setD(Object.keys(newer).length ? { ...saved, ...newer } : null); },
    restore: saved => { onSaved(saved); setD(null); },
  }));
  const cur: Draft = d || { name: sc.name, color: sc.color, steps: sc.steps };
  const url = `${base}/sd/custom/${sc.id}`;
  useEffect(() => {
    const unregister = registerDraft('atajo:' + sc.id, buffer);
    return () => { unregister(); buffer.dispose(); };
  }, [buffer]);
  const set = (patch: Partial<Draft>) => { buffer.push(patch); setD({ ...cur, ...patch }); setMsg(null); };
  const run = guard(async () => {
    if (isSaving()) return;
    await buffer.save();
    if (!buffer.isActive()) return;
    const r = await post<{ errors?: string[]; results?: unknown[] }>(`/api/shortcuts/${enc(sc.id)}/run`);
    if (!buffer.isActive()) return;
    setMsg(r.errors?.length ? { t: `Hecho a medias: ${r.errors.join(' · ')}`, err: true } : { t: `Hecho: ${(r.results || []).length} ${(r.results || []).length === 1 ? 'paso' : 'pasos'}` });
  });
  return <Slide crumb={<><a href="#/atajos">Atajos y Stream Deck</a> › Atajo</>} back="#/atajos" wide
    title={<input className="lv-title-input" aria-label="Nombre del atajo" value={cur.name} onChange={e => set({ name: e.target.value })} />}
    foot={<SaveBar left={<button className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving()} onClick={guard(async () => { if (isSaving() || !confirmDelete(sc.name, 'este atajo')) return; buffer.discard(); go('#/atajos'); await del('/api/shortcuts/' + enc(sc.id)); onDeleted(); })}>Borrar atajo…</button>}
      right={<button type="button" className="eg-btn eg-btn--primary eg-btn--sm" disabled={isSaving()} onClick={run}>Guardar y probar</button>} />}>
    <div className="lv-cols aside">
      <div className="lv-col"><Box title={<>Pasos · {cur.steps.length}</>} aside={msg ? <span className={cx('hint', msg.err && 'err-inline')} aria-live="polite">{msg.t}</span> : null}>
        <StepsEditor steps={cur.steps} info={info} onChange={l => set({ steps: l })} />
        <div><button className="eg-btn eg-btn--ghost eg-btn--sm" disabled={cur.steps.length >= 20} onClick={() => set({ steps: [...cur.steps, { kind: 'builtin', action: 'marca' }] })}>+ Añadir paso</button></div>
      </Box></div>
      <aside className="lv-col">
        <Box title="Dirección para el Stream Deck"><div className="overlay-url"><code>{url}</code><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(url)}>Copiar</button></div><p className="hint">No cambia aunque cambies el nombre.</p></Box>
        <Box title="Color en el dock"><div className="row tight colors" role="radiogroup" aria-label="Color en el dock">
          {COLORS.map(c => <button key={c || 'none'} role="radio" aria-checked={(cur.color || '') === c} title={c || 'Sin color'} className={cx('color-dot', (cur.color || '') === c && 'on')} style={{ background: c || 'transparent' }} onClick={() => set({ color: c })} />)}
        </div></Box>
      </aside>
    </div>
  </Slide>;
}

const TEMPLATES: [string, string, string, Step[]][] = [
  ['vacio', 'Desde cero', 'Un paso: marcar un short', [{ kind: 'builtin', action: 'marca' }]],
  ['empezar', 'Empezar el directo', 'Escena de inicio + mensaje en el chat', [{ kind: 'scene', scene: '', delaySec: 0 }, { kind: 'chat', text: '¡Empezamos! Os esperamos en el chat', destination: 'both', delaySec: 0 }]],
  ['pausa', 'Pausa café', 'Pausar alertas + escena de pausa', [{ kind: 'builtin', action: 'pausa' }, { kind: 'scene', scene: '', delaySec: 0 }]],
  ['sorteo', 'Sorteo', 'Abrir sorteo + prompter en Sorteo', [{ kind: 'builtin', action: 'abrir-sorteo' }, { kind: 'builtin', action: 'prompter', arg: 'sorteo' }]],
];
function NuevoAtajo({ count, onCreated }: { count: number; onCreated: (s: Shortcut) => void }) {
  const [name, setName] = useState('');
  const [tpl, setTpl] = useState('vacio');
  const create = guard(async () => {
    const t = TEMPLATES.find(x => x[0] === tpl)!;
    const d = await post<{ shortcut: Shortcut }>('/api/shortcuts', { name: name.trim() || (tpl === 'vacio' ? `Atajo ${count + 1}` : t[1]), steps: t[3] });
    onCreated(d.shortcut); go(`#/atajos/${enc(d.shortcut.id)}`);
  });
  return <Slide crumb={<><a href="#/atajos">Atajos y Stream Deck</a> › Nuevo</>} title="Nuevo atajo" back="#/atajos"
    tabs={[{ id: 'min', label: 'Lo mínimo' }, { id: 'rest', label: 'Pasos, al crear', locked: true }]} tab="min" onTab={() => {}}
    foot={<footer className="lv-sfoot sticky"><span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/atajos">Cancelar</a><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={create}>Crear atajo</button></footer>}>
    <Box title="Lo mínimo"><label>Nombre <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} placeholder="Empezar el directo" /></label></Box>
    <Box title="Plantilla de partida"><div className="lv-tiles" role="radiogroup" aria-label="Plantilla">{TEMPLATES.map(([id, t, dsc]) => <button key={id} type="button" role="radio" className="lv-tile" aria-checked={tpl === id} aria-pressed={tpl === id} onClick={() => setTpl(id)}><b>{t}</b><span>{dsc}</span></button>)}</div></Box>
  </Slide>;
}

export function Atajos({ parts }: { parts: string[] }) {
  const [info, setInfo] = useState<Info | null>(null);
  const base = location.origin;
  const load = () => get<Info>('/api/shortcuts').then(setInfo).catch(e => toast(e.message, true));
  useEffect(() => { load(); }, []);
  const tab = parts[1] === 'serie' ? 'serie' : parts[1] === 'streamdeck' ? 'streamdeck' : 'mios';
  const open = tab === 'mios' ? parts[1] : undefined;
  const sync = (custom: Shortcut[]) => { setInfo(i => (i ? { ...i, custom } : i)); live.update(s => ({ config: { ...s.config, shortcuts: custom } })); };
  if (!info) return <p className="hint">Cargando…</p>;
  const sc = info.custom.find(x => x.id === open);
  return <>
    <PageHead tour="atajos-head" crumb={`Configurar · ${info.custom.length} atajos propios`} title="Atajos y Stream Deck"
      desc="Cada atajo es una dirección: un botón del Stream Deck la llama y se hacen sus pasos en orden. También salen como botones en el dock de Meld."
      actions={<a className="eg-btn eg-btn--primary eg-btn--sm" href="#/atajos/nuevo">+ Nuevo atajo</a>}
      tabs={[{ id: 'mios', label: 'Mis atajos', count: info.custom.length }, { id: 'serie', label: 'De serie', count: info.actions.length }, { id: 'streamdeck', label: 'Cómo ponerlo en el Stream Deck' }]} tab={tab}
      onTab={t => go(t === 'mios' ? '#/atajos' : `#/atajos/${t}`)} />
    {tab === 'mios' && <ListPanel tour="atajos-list" title="Mis atajos" note="Ideas: «Empezar», «Pausa café», «Sorteo». Hay plantillas al crear."
      cols={[{ key: 'name', label: 'Atajo' }, { key: 'steps', label: 'Pasos' }, { key: 'url', label: 'Dirección', hide: true }, { key: 'run', label: '' }]}
      rows={info.custom.map(x => { const href = `#/atajos/${enc(x.id)}`; return { id: x.id, href, open: open === x.id, cells: {
        name: <NameCell href={href} name={x.name} lead={<span className="lv-swatch" style={{ background: x.color || 'var(--eg-accent, #FF3B5C)' }} />} />,
        steps: <Tags items={x.steps.slice(0, 3).map(st => ({ t: stepText(st) })).concat(x.steps.length > 3 ? [{ t: `+${x.steps.length - 3}` }] : [])} />,
        url: <span className="lv-mono">/sd/custom/{x.id}</span>,
        run: <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post(`/api/shortcuts/${enc(x.id)}/run`), 'Hecho')}>Probar</button>,
      } }; })} empty="Aún no tienes atajos." />}
    {tab === 'serie' && <ListPanel title="Atajos de serie" note="Ya existen: solo hay que copiar la dirección."
      cols={[{ key: 'path', label: 'Dirección' }, { key: 'what', label: 'Qué hace' }, { key: 'btns', label: '' }]}
      rows={info.actions.map(a => ({ id: a, cells: { path: <span className="lv-mono">/sd/{a}</span>, what: sdLabel(a),
        btns: <div className="row tight"><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/sd/' + a), 'Hecho')}>Probar</button><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(`${base}/sd/${a}`)}>Copiar</button></div> } }))} empty="—" />}
    {tab === 'streamdeck' && <Panel title="Cómo ponerlo en el Stream Deck" tour="atajos-streamdeck">
      <ol className="steps">
        <li>Instala un plugin de peticiones web (por ejemplo «API Ninja» o «Web Requests»).</li>
        <li>Arrastra su acción a un botón y pega la dirección del atajo. Vale GET o POST, sin cuerpo.</li>
        <li>Escenas, micro y efectos sueltos van más rápidos con el plugin oficial de Meld; usa los atajos para lo que combina varias cosas.</li>
      </ol>
      <p className="hint">Si cambias el nombre, la dirección sigue siendo la misma: usa el identificador, no el nombre.</p>
    </Panel>}
    {open === 'nuevo' ? <NuevoAtajo count={info.custom.length} onCreated={n => sync([...info.custom, n])} />
      : sc ? <ShortcutSlide key={sc.id} sc={sc} info={info} base={base} onSaved={n => sync(info.custom.map(x => (x.id === n.id ? n : x)))} onDeleted={() => sync(info.custom.filter(x => x.id !== sc.id))} /> : null}
  </>;
}
