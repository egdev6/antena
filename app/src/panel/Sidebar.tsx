import { useState } from 'react';
import { IC } from '../lib/icons';
import { useLive } from '../lib/live';
import { post } from '../lib/api';
import { guard, Icon, cx } from '../lib/ui';
import { isDesktop, openDock, openPrompter } from '../lib/desktop';
import type { IconData } from '../lib/icons';
import { alertWarnings } from './views/Alertas';

const P = (d: string) => ['path', { d }] as const;
// iconos del menú lateral del lienzo (v2 · jerarquía): uno por entrada
const ICONS = {
  directo: [P('M4.9 19.1C1 15.2 1 8.8 4.9 4.9'), P('M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5'), ['circle', { cx: '12', cy: '12', r: '2' }], P('M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5'), P('M19.1 4.9C23 8.8 23 15.1 19.1 19')],
  chat: [P('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  preguntas: [['circle', { cx: '12', cy: '12', r: '10' }], P('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3'), P('M12 17h.01')],
  tierlist: [P('M3 5h18M3 12h12M3 19h6')],
  sorteo: [['rect', { x: '3', y: '8', width: '18', height: '4', rx: '1' }], P('M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7')],
  teleprompter: [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }], P('M7 9h10M7 13h10M7 17h6')],
  alertas: [P('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'), P('M10.3 21a1.94 1.94 0 0 0 3.4 0')],
  comandos: [P('m4 17 6-6-6-6'), P('M12 19h8')],
  mensajes: [['circle', { cx: '12', cy: '12', r: '9' }], P('M12 7v5l3 2')],
  widgets: [['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }], ['rect', { x: '14', y: '14', width: '7', height: '7', rx: '1' }]],
  atajos: [['rect', { x: '2', y: '6', width: '20', height: '12', rx: '2' }], P('M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10')],
  fuentes: [['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }], P('M8 21h8M12 17v4')],
  meld: [P('m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z'), P('m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65')],
  prompter: [P('M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z'), ['circle', { cx: '12', cy: '13', r: '3' }]],
  historial: [P('M8 6h13M8 12h13M8 18h13'), P('M3 6h.01M3 12h.01M3 18h.01')],
  directos: [P('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'), P('M3 3v5h5'), P('M12 7v5l4 2')],
  archivos: [P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')],
  apariencia: [['circle', { cx: '13.5', cy: '6.5', r: '1.5' }], ['circle', { cx: '17.5', cy: '10.5', r: '1.5' }], ['circle', { cx: '8.5', cy: '7.5', r: '1.5' }], ['circle', { cx: '6.5', cy: '12.5', r: '1.5' }], P('M12 2a10 10 0 0 0 0 20c1 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7h2a5.5 5.5 0 0 0 5.5-5.5C22 6 17.5 2 12 2z')],
  conexiones: [P('M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z')],
  filtros: [P('M22 3H2l8 9.46V19l4 2v-8.54L22 3z')],
  general: [['circle', { cx: '12', cy: '12', r: '3' }], P('M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z')],
  acerca: [['circle', { cx: '12', cy: '12', r: '10' }], P('M12 16v-4'), P('M12 8h.01')],
  pause: [['rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }], ['rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' }]],
  play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
} satisfies Record<string, IconData>;

type Item = { href: string; label: string; tail?: any };

export function Sidebar({ current }: { current: string }) {
  const s = useLive(x => x);
  const I = s.interactive || {};
  const meldOn = s.status?.meld?.state === 'conectado';
  // a la derecha de cada entrada, como en el lienzo: un número (en rojo si es algo en marcha) o un punto de aviso
  const num = (v: number | undefined) => (v ? <span className="nav-n">{v}</span> : null);
  const live = (t: string, label?: string) => <span className="nav-n is-live" aria-label={label}>{t}</span>;
  const warns = alertWarnings(s).length;
  const groups: [string, string, Item[]][] = [
    ['directo', 'En directo', [
      { href: '#/directo', label: 'Directo', tail: s.status?.meld?.streaming ? live('●', 'en directo') : null },
      { href: '#/chat', label: 'Chat' },
      { href: '#/preguntas', label: 'Preguntas', tail: I.questions?.pending ? live(String(I.questions.pending), `${I.questions.pending} en cola`) : null },
      { href: '#/tierlist', label: 'Tier list', tail: I.vote ? live('votando') : null },
      { href: '#/sorteo', label: 'Sorteo', tail: I.giveaway?.open ? live('abierto') : null },
      { href: '#/teleprompter', label: 'Teleprompter', tail: s.teleprompter?.playback?.playing ? live('leyendo') : null },
    ]],
    ['configurar', 'Configurar', [
      { href: '#/alertas', label: 'Alertas', tail: warns ? <span className="nav-w" role="img" aria-label={warns === 1 ? '1 aviso' : `${warns} avisos`} title="Alertas con avisos" /> : null },
      { href: '#/comandos', label: 'Comandos de chat', tail: num(s.config.commands?.length) },
      { href: '#/mensajes', label: 'Mensajes programados', tail: num(s.config.timers?.length) },
      { href: '#/widgets', label: 'Widgets', tail: num(8) },
      { href: '#/atajos', label: 'Atajos y Stream Deck', tail: num(s.config.shortcuts?.length) },
    ]],
    ['produccion', 'Producción', [
      { href: '#/fuentes', label: 'Fuentes para Meld' },
      { href: '#/meld', label: 'Meld Studio', tail: <span className={cx('nav-n', meldOn && 'is-live')} aria-label={meldOn ? 'conectado' : 'sin conectar'}>●</span> },
      { href: '#/prompter', label: 'Prompter y dock' },
    ]],
    ['registro', 'Registro', [
      { href: '#/historial', label: 'Historial de alertas' },
      { href: '#/directos', label: 'Directos anteriores' },
      { href: '#/archivos', label: 'Archivos', tail: num(s.media?.length) },
    ]],
    ['ajustes', 'Ajustes', [
      { href: '#/apariencia', label: 'Apariencia' },
      { href: '#/conexiones', label: 'Conexiones' },
      { href: '#/filtros', label: 'Filtros y voz' },
      { href: '#/general', label: 'General' },
      { href: '#/acerca', label: 'Acerca de' },
    ]],
  ];
  // la entrada activa: la página (primer tramo de la dirección), aunque haya un slide abierto
  const active = (href: string) => href.split('/')[1] === current.split('/')[1];
  const pause = s.status?.pause || {};
  const n = s.status?.overlays || 0;
  return <aside className="side">
    <a className="brand" href="#/directo" aria-label="antena, inicio">
      <img className="brand-mark" src="/brand/logo.png" alt="" aria-hidden="true" />
      <span className="brand-name"><b>antena</b><small>Alertas y control de Meld</small></span>
    </a>
    <nav id="nav" aria-label="Secciones" data-tour="nav">
      {groups.map(([id, label, items]) => <div key={id} className="nav-grp" data-grp={id} data-tour={`nav-${id}`}>
        <p className="grp" id={`nav-g-${id}`}><span className="grp-l">{label}</span></p>
        <ul className="eg-menu eg-menu--nav" aria-labelledby={`nav-g-${id}`}>
          {items.map(it => {
            const key = it.href.slice(2) as keyof typeof ICONS;
            return <li key={it.href}><a className={cx('eg-menu__item', active(it.href) && 'on')} href={it.href} aria-current={active(it.href) ? 'page' : undefined}>
              <Icon d={ICONS[key]} /><span className="eg-menu__label">{it.label}</span>{it.tail}</a></li>;
          })}
        </ul>
      </div>)}
    </nav>
    <div className="side-foot">
      <CreateMenu />
      {isDesktop() && <div className="row tight">
        <button className="eg-btn eg-btn--ghost eg-btn--sm" style={{ flex: 1 }} onClick={guard(() => openPrompter(s.config.prompter?.monitor))}>Prompter</button>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" style={{ flex: 1 }} onClick={guard(() => openDock())}>Dock</button>
      </div>}
      <button className={cx('eg-btn eg-btn--sm', pause.paused ? 'eg-btn--primary' : 'eg-btn--secondary')} id="pauseBtn" onClick={guard(async () => {
        if (pause.paused) {
          const discard = (pause.held || 0) > 0 && !confirm(`Hay ${pause.held ?? 0} alertas en cola. ¿Sacarlas ahora? (Cancelar = descartarlas)`);
          await post('/api/resume', { discard });
        } else await post('/api/pause');
      })}>
        <Icon d={pause.paused ? ICONS.play : ICONS.pause} className="eg-btn__icon" />{pause.paused ? 'Reanudar alertas' : 'Pausar alertas'}{pause.paused && pause.held ? <span className="eg-tabs__count">{pause.held}</span> : null}
      </button>
      <div className="side-well" role="status">
        <span><span className={`eg-status-dot eg-status-dot--${meldOn ? 'running' : 'stopped'}`} aria-hidden="true" />{meldOn ? 'Meld conectado' : 'Meld sin conectar'}</span>
        <small id="ovCount">{n === 1 ? '1 overlay conectado' : `${n} overlays conectados`}</small>
      </div>
    </div>
  </aside>;
}

/** «Crear»: todo lo que se puede crear, desde cualquier página (abre el slide en modo «Nuevo»). */
const CREATE: [string, string][] = [
  ['#/comandos/nuevo', 'Comando de chat'], ['#/mensajes/nuevo', 'Mensaje programado'], ['#/alertas', 'Variación de una alerta…'],
  ['#/widgets/objetivos/nuevo', 'Objetivo'], ['#/atajos/nuevo', 'Atajo de Stream Deck'], ['#/tierlist/nueva', 'Tier list'], ['#/teleprompter/guiones/nuevo', 'Guion del teleprompter'],
];
function CreateMenu() {
  const [open, setOpen] = useState(false);
  return <div className="side-create" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
    {open && <div className="menu" role="menu" aria-label="Crear">
      <p>Crear</p>
      {CREATE.map(([href, label]) => <a key={href} role="menuitem" href={href} onClick={() => setOpen(false)}>{label}</a>)}
    </div>}
    <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" style={{ width: '100%' }} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}><Icon d={IC.plus} className="eg-btn__icon" />Crear</button>
  </div>;
}
