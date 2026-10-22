// Atajos: botones del Stream Deck. Los de serie (/sd/…) y los personalizados (/sd/custom/<id>),
// que encadenan pasos: acciones de antena (marca, pausa, pregunta…) y de Meld (escena, capa, chat…).
import { useEffect, useState } from 'react';
import { del, enc, get, post, put } from '../../lib/api';
import { live } from '../../lib/live';
import { confirmDelete, copy, cx, EmptyState, guard, IconBtn, LazyInput, Modal, Panel, toast, ViewHead } from '../../lib/ui';
import { IC } from '../../lib/icons';
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

// Editor de un atajo (dentro del modal): nombre, dirección, color y pasos; los pasos se guardan con «Guardar pasos».
function ShortcutCard({ sc, info, base, onSaved, onDeleted, onDirty }: { sc: Shortcut; info: Info; base: string; onSaved: (s: Shortcut) => void; onDeleted: () => void; onDirty: (dirty: boolean) => void }) {
  const [steps, setSteps] = useState<Step[]>(sc.steps);
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (v: boolean) => { setDirtyState(v); onDirty(v); };
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  useEffect(() => { if (!dirty) setSteps(sc.steps); }, [sc.steps]);
  const url = `${base}/sd/custom/${sc.id}`;
  const save = async (patch: Partial<Shortcut>) => { const d = await put<{ shortcut: Shortcut }>('/api/shortcuts/' + enc(sc.id), patch); onSaved(d.shortcut); return d.shortcut; };
  const saveSteps = guard(async () => { await save({ steps }); setDirty(false); setMsg({ t: 'Guardado' }); });
  const run = guard(async () => {
    if (dirty) { await save({ steps }); setDirty(false); }
    const r = await post<{ errors?: string[]; results?: unknown[] }>(`/api/shortcuts/${enc(sc.id)}/run`);
    setMsg(r.errors?.length ? { t: `Hecho a medias: ${r.errors.join(' · ')}`, err: true } : { t: `Hecho: ${(r.results || []).length} ${(r.results || []).length === 1 ? 'paso' : 'pasos'}` });
  });
  return <article className="shortcut-card" style={{ ['--sc' as any]: sc.color || 'var(--eg-accent, #FF3B5C)' }}>
    <header>
      <span className="sc-swatch" aria-hidden="true" />
      <LazyInput className="title-input sm" aria-label="Nombre del atajo" value={sc.name} onCommit={v => save({ name: v }).catch(e => toast(e.message, true))} />
      <div className="row tight">
        <button className="eg-btn eg-btn--primary eg-btn--sm" onClick={run}>Probar</button>
        <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirmDelete(sc.name, 'este atajo')) return; await del('/api/shortcuts/' + enc(sc.id)); onDeleted(); })}>Borrar</button>
      </div>
    </header>
    <div className="overlay-url"><code>{url}</code><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(url)}>Copiar</button></div>
    <div className="row tight colors" role="radiogroup" aria-label="Color en el dock">
      {COLORS.map(c => <button key={c || 'none'} role="radio" aria-checked={(sc.color || '') === c} title={c || 'Sin color'} className={cx('color-dot', (sc.color || '') === c && 'on')} style={{ background: c || 'transparent' }} onClick={guard(() => save({ color: c }))} />)}
    </div>
    <StepsEditor steps={steps} info={info} onChange={l => { setSteps(l); setDirty(true); setMsg(null); }} />
    <div className="row middle mt-s">
      <button className="eg-btn eg-btn--ghost eg-btn--sm" disabled={steps.length >= 20} onClick={() => { setSteps([...steps, { kind: 'builtin', action: 'marca' }]); setDirty(true); }}>+ Añadir paso</button>
      {dirty && <button className="eg-btn eg-btn--primary eg-btn--sm" onClick={saveSteps}>Guardar pasos</button>}
      {msg && <span className={cx('hint', msg.err && 'err-inline')} aria-live="polite">{msg.t}</span>}
    </div>
  </article>;
}

export function Atajos() {
  const [info, setInfo] = useState<Info | null>(null);
  const [name, setName] = useState('');
  // modal: null cerrado, 'new' para crear, o el id del atajo que se edita
  const [modal, setModal] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const base = location.origin;
  const load = () => get<Info>('/api/shortcuts').then(setInfo).catch(e => toast(e.message, true));
  useEffect(() => { load(); }, []);
  // los atajos también viven en la configuración (el dock y la barra lateral los leen de ahí)
  const sync = (custom: Shortcut[]) => { setInfo(i => (i ? { ...i, custom } : i)); live.update(s => ({ config: { ...s.config, shortcuts: custom } })); };
  if (!info) return <p className="hint">Cargando…</p>;
  const close = () => { setModal(null); setDirty(false); setName(''); };
  const requestClose = () => { if (!dirty || confirm('Tienes pasos sin guardar. ¿Cerrar sin guardarlos?')) close(); };
  const create = guard(async () => {
    const d = await post<{ shortcut: Shortcut }>('/api/shortcuts', { name: name.trim() || `Atajo ${info.custom.length + 1}`, steps: [{ kind: 'builtin', action: 'marca' }] });
    sync([...info.custom, d.shortcut]); setName(''); setModal(d.shortcut.id);
  });
  const run = (sc: Shortcut) => guard(async () => {
    const r = await post<{ errors?: string[]; results?: unknown[] }>(`/api/shortcuts/${enc(sc.id)}/run`);
    const n = (r.results || []).length;
    if (r.errors?.length) toast(`Hecho a medias: ${r.errors.join(' · ')}`, true); else toast(`Hecho: ${n} ${n === 1 ? 'paso' : 'pasos'}`);
  })();
  const remove = (sc: Shortcut) => guard(async () => {
    if (!confirmDelete(sc.name, 'este atajo')) return;
    await del('/api/shortcuts/' + enc(sc.id));
    if (modal === sc.id) close();
    sync(info.custom.filter(x => x.id !== sc.id));
  })();
  const editing = modal && modal !== 'new' ? info.custom.find(x => x.id === modal) : undefined;
  return <>
    <ViewHead tour="atajos-head" crumb="Meld y Stream Deck › Atajos y Stream Deck" title="Atajos y Stream Deck" hint="Cada atajo es una dirección: un botón del Stream Deck la llama y se hacen sus pasos en orden. También salen como botones en el dock de Meld."
      actions={<button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={() => setModal('new')}>+ Nuevo atajo</button>} />
    <div className="grid2">
      <div className="stack">
        <Panel title="Cómo ponerlo en el Stream Deck" tour="atajos-streamdeck">
          <ol className="steps">
            <li>Instala un plugin de peticiones web (por ejemplo «API Ninja» o «Web Requests»).</li>
            <li>Arrastra su acción a un botón y pega la dirección del atajo. Vale GET o POST, sin cuerpo.</li>
            <li>Escenas, micro y efectos sueltos van más rápidos con el plugin oficial de Meld; usa los atajos para lo que combina varias cosas.</li>
          </ol>
          <p className="hint">Si cambias el nombre, la dirección sigue siendo la misma: usa el identificador, no el nombre.</p>
        </Panel>
        <Panel title={<>Mis atajos <span className="hint">{info.custom.length}</span></>} tour="atajos-list">
          {info.custom.length ? <div className="rows">{info.custom.map(sc => <article key={sc.id} className="eg-post eg-post--row shortcut-row" style={{ ['--sc' as any]: sc.color || 'var(--eg-accent, #FF3B5C)' }}>
            <span className="sc-swatch" aria-hidden="true" />
            <div className="eg-post__content"><b>{sc.name}</b>
              <span className="eg-post__meta"><code>/sd/custom/{sc.id}</code> · {sc.steps.length} {sc.steps.length === 1 ? 'paso' : 'pasos'}</span></div>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => run(sc)}>Probar</button>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => setModal(sc.id)}>Editar</button>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={() => remove(sc)}>Borrar</button>
          </article>)}</div>
            : <EmptyState>Aún no tienes atajos. Ideas: «Empezar» (escena de inicio + abrir preguntas + mensaje en el chat), «Pausa café» (escena de pausa + pausar alertas), «Sorteo» (abrir sorteo + prompter en la pestaña de sorteo).</EmptyState>}
        </Panel>
      </div>
      <Panel title="Atajos de serie">
        <ul className="sd-list">{info.actions.map(a => <li key={a}><code>/sd/{a}</code><span className="hint">{sdLabel(a)}</span><span className="vbtns"><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/sd/' + a), 'Hecho')}>Probar</button><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(`${base}/sd/${a}`)}>Copiar</button></span></li>)}</ul>
      </Panel>
    </div>
    {modal === 'new' && <Modal title="Nuevo atajo" onClose={requestClose}>
      <p className="hint">Ponle un nombre; después eliges sus pasos.</p>
      <div className="row tight"><input className="grow" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} placeholder="Empezar el directo" aria-label="Nombre del atajo nuevo" /><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={create}>Crear atajo</button></div>
    </Modal>}
    {editing && <Modal title="Editar atajo" onClose={requestClose} className="shortcut-modal">
      <ShortcutCard key={editing.id} sc={editing} info={info} base={base}
        onSaved={n => sync(info.custom.map(x => (x.id === n.id ? n : x)))}
        onDeleted={() => { close(); sync(info.custom.filter(x => x.id !== editing.id)); }}
        onDirty={setDirty} />
    </Modal>}
  </>;
}
