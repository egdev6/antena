import { useState } from 'react';
import { useLive } from '../lib/live';
import { post } from '../lib/api';
import { guard, Icon, cx } from '../lib/ui';
import { isDesktop, openDock, openPrompter } from '../lib/desktop';
import type { AlertConfig, AlertType } from '../lib/types';
import type { IconData } from '../lib/icons';

const ICONS = {
  directo: [['path', { d: 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9' }], ['path', { d: 'M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5' }], ['circle', { cx: '12', cy: '12', r: '2' }], ['path', { d: 'M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5' }], ['path', { d: 'M19.1 4.9C23 8.8 23 15.1 19.1 19' }]],
  chat: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
  historial: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }], ['path', { d: 'M12 7v5l4 2' }]],
  chev: [['path', { d: 'm6 9 6 6 6-6' }]],
  pause: [['rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }], ['rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' }]],
  play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
} satisfies Record<string, IconData>;

function readClosed(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem('egdev.nav.closed') || '[]')); } catch { return new Set(); } }
function saveClosed(s: Set<string>) { try { localStorage.setItem('egdev.nav.closed', JSON.stringify([...s])); } catch {} }

type Item = { href: string; label: string; lead?: any; tail?: any };

export function Sidebar({ current }: { current: string }) {
  const s = useLive(x => x);
  const [closed, setClosed] = useState(readClosed);
  const I = s.interactive || {};
  const meldOn = s.status?.meld?.state === 'conectado';
  const dot = (on: boolean) => <span className={`eg-status-dot eg-status-dot--${on ? 'running' : 'stopped'}`} aria-hidden="true" />;
  const tag = (t: string, live = false) => <span className={cx('eg-menu__tag', live && 'eg-menu__tag--live')}>{t}</span>;
  const count = (v: number) => (v ? <span className="eg-menu__count">{v}</span> : null);
  const types = Object.entries<AlertType>(s.types || {});
  const alertItem = ([k, t]: [string, AlertType]): Item => {
    const a = s.config.alerts[k] || {};
    return { href: `#/alerta/${k}`, label: t.label, lead: dot(!!a.enabled), tail: <>{a.layout === 'media' && a.media ? tag('vídeo') : null}{count(a.variations?.length || 0)}</> };
  };
  const groups: [string, string, Item[], boolean?][] = [
    ['directo', 'En directo', [
      { href: '#/directo', label: 'Directo', lead: <Icon d={ICONS.directo} /> },
      { href: '#/chat', label: 'Chat', lead: <Icon d={ICONS.chat} /> },
      { href: '#/historial', label: 'Historial', lead: <Icon d={ICONS.historial} /> },
    ], !!s.status?.meld?.streaming],
    ['twitch', 'Alertas de Twitch', types.filter(([, t]) => t.platform === 'twitch').map(alertItem)],
    ['youtube', 'Alertas de YouTube', types.filter(([, t]) => t.platform === 'youtube').map(alertItem)],
    ['chat', 'Chat', [
      { href: '#/comandos', label: 'Comandos de chat', tail: count(s.config.commands?.length) },
      { href: '#/mensajes', label: 'Mensajes programados', tail: count(s.config.timers?.length) },
    ]],
    ['widgets', 'Widgets', [
      { href: '#/widget/questions', label: 'Preguntas', tail: I.questions?.pending ? tag(`${I.questions.pending} en cola`, true) : null },
      { href: '#/widget/teleprompter', label: 'Teleprompter', tail: s.teleprompter?.playback?.playing ? tag('leyendo', true) : null },
      { href: '#/widget/tierlist', label: 'Tier list', tail: I.vote ? tag('votando', true) : null },
      { href: '#/widget/giveaway', label: 'Sorteo', tail: I.giveaway?.open ? tag('abierto', true) : null },
      { href: '#/widget/chat', label: 'Chat en pantalla' },
      { href: '#/widget/goals', label: 'Objetivos' },
      { href: '#/widget/latest', label: 'Últimos y ticker' },
      { href: '#/widget/credits', label: 'Créditos' },
    ], !!(I.questions?.pending || I.vote || I.giveaway?.open)],
    ['meld', 'Meld y Stream Deck', [
      { href: '#/fuentes', label: 'Fuentes para Meld' },
      { href: '#/meld', label: 'Meld Studio', tail: <span className={`eg-status-dot eg-status-dot--${meldOn ? 'running' : 'stopped'}`} aria-label={meldOn ? 'conectado' : 'sin conectar'} style={{ marginLeft: 'auto' }} /> },
      { href: '#/atajos', label: 'Atajos y Stream Deck', tail: count(s.config.shortcuts?.length) },
      { href: '#/prompter', label: 'Prompter' },
    ]],
    ['ajustes', 'Ajustes', [
      { href: '#/apariencia', label: 'Apariencia' },
      { href: '#/filtros', label: 'Filtros y voz' },
      { href: '#/conexiones', label: 'Conexiones' },
      { href: '#/general', label: 'General y archivos' },
      { href: '#/acerca', label: 'Acerca de' },
    ]],
  ];
  const active = (href: string) => href === current || (current.startsWith('#/comando/') && href === '#/comandos') || (current.startsWith('#/mensaje/') && href === '#/mensajes');
  const toggle = (id: string, alt: boolean) => {
    const next = new Set(closed);
    if (alt) {
      const solo = groups.every(([g]) => (g === id ? !closed.has(g) : closed.has(g)));
      groups.forEach(([g]) => { if (solo || g === id) next.delete(g); else next.add(g); });
    } else if (next.has(id)) next.delete(id); else next.add(id);
    setClosed(next); saveClosed(next);
  };
  const pause = s.status?.pause || {};
  const n = s.status?.overlays || 0;
  return <aside className="side">
    <a className="brand" href="#/directo" aria-label="antena, inicio">
      <img className="brand-mark" src="/brand/logo.png" alt="" aria-hidden="true" />
      <span className="brand-name"><b>antena</b><small>Alertas y control de Meld</small></span>
    </a>
    <nav id="nav" aria-label="Secciones" data-tour="nav">
      {groups.map(([id, label, items, live]) => {
        const isClosed = closed.has(id);
        return <div key={id} className={cx('nav-grp', isClosed && 'closed')} data-grp={id} data-tour={`nav-${id}`}>
          <button type="button" className="grp eg-menu__group eg-menu__group--toggle" aria-expanded={!isClosed} onClick={e => toggle(id, e.altKey)}>
            <Icon d={ICONS.chev} className="eg-menu__chev" /><span className="grp-l">{label}</span>
            {live ? <span className="eg-live-dot is-active" aria-label="Algo en marcha" /> : null}
            <span className="eg-menu__count">{items.length}</span>
          </button>
          <ul className="eg-menu eg-menu--nav">
            {items.map(it => <li key={it.href}><a className={cx('eg-menu__item', active(it.href) && 'on')} href={it.href} aria-current={active(it.href) ? 'page' : undefined}>{it.lead}<span className="eg-menu__label">{it.label}</span>{it.tail}</a></li>)}
          </ul>
        </div>;
      })}
    </nav>
    <div className="side-foot">
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
