import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { enc, get, post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { cx, EmptyState, fmtTime, guard, PfIcon, PLATFORM_NAMES, ScaledFrame, Seg, toast, ViewHead } from '../../lib/ui';
import type { ChatSendResult, ChatVariant } from '../../lib/types';

export function sendResultText(r: any) {
  const errs = Object.entries<string>(r.errors || {});
  return `Enviado a ${Object.keys(r.sent || {}).map(k => PLATFORM_NAMES[k]).join(' y ')}${errs.length ? ' · ' + errs.map(([k, v]) => PLATFORM_NAMES[k] + ': ' + v).join(' · ') : ''}`;
}

export function SendTo({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts: [string, React.ReactNode, string][] = [['twitch', <PfIcon platform="twitch" />, 'Solo Twitch'], ['youtube', <PfIcon platform="youtube" />, 'Solo YouTube'], ['both', 'Ambos', 'Twitch y YouTube']];
  return <div className="eg-tabs send-to" role="radiogroup" aria-label="Escribir en">
    {opts.map(([v, l, t]) => <button key={v} type="button" role="radio" className="eg-tabs__item" aria-checked={v === value} aria-selected={v === value} title={t} aria-label={t} onClick={() => onChange(v)}>{l}</button>)}
  </div>;
}

// Keep the original Directo keys so existing preferences survive the move to Chat.
const PREVIEW_VISIBLE = 'egdev.panel.directo.chat-preview.visible';
const PREVIEW_VARIANT = 'egdev.panel.directo.chat-preview.variant';
const VARIANTS_ROUTE = '/api/widgets/chat/variants';

export function readPreviewPreference(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writePreviewPreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* el panel funciona sin almacenamiento */ }
}

/** The editor's example widget, independent of its unsaved drafts. */
function ChatPreview() {
  const savedWidgets = useLive(s => s.widgets?.widgets);
  const [visible, setVisible] = useState(() => readPreviewPreference(PREVIEW_VISIBLE) === 'true');
  const [id, setId] = useState(() => readPreviewPreference(PREVIEW_VARIANT) || 'default');
  const [variants, setVariants] = useState<ChatVariant[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let active = true, eventVersion = 0, requestVersion = 0;
    const refresh = () => {
      const eventAtStart = eventVersion, request = ++requestVersion;
      get<ChatVariant[]>(VARIANTS_ROUTE).then(list => {
        if (!Array.isArray(list)) throw new Error('Respuesta no válida');
        if (active && request === requestVersion && eventAtStart === eventVersion) { setVariants(list); setError(''); }
      }).catch(e => {
        if (active && request === requestVersion && eventAtStart === eventVersion) setError(`No se pudieron cargar las variantes: ${e instanceof Error ? e.message : 'error desconocido'}`);
      });
    };
    // A later saved widgets event wins over an older GET; config.widgets can be a draft.
    const off = live.on('widgets', state => {
      const list = state.widgets?.chatVariants;
      if (!Array.isArray(list)) return;
      eventVersion++; setVariants(list); setError('');
    });
    const offOpen = live.onOpen(refresh);
    refresh();
    return () => { active = false; off(); offOpen(); };
  }, [visible, attempt]);

  useEffect(() => {
    if (visible && variants && id !== 'default' && !variants.some(v => v.id === id)) {
      setId('default'); writePreviewPreference(PREVIEW_VARIANT, 'default');
      setNotice('La variante ya no existe. Se muestra el chat predeterminado.');
    }
  }, [visible, variants, id]);

  const toggle = (next: boolean) => {
    // A list from an earlier visit cannot confirm whether a variant still exists.
    setVariants(null); setError(''); setVisible(next); writePreviewPreference(PREVIEW_VISIBLE, String(next));
  };
  const choose = (next: string) => {
    setId(next); setNotice(''); writePreviewPreference(PREVIEW_VARIANT, next);
  };
  const selected = variants?.find(v => v.id === id);
  const horizontal = (id === 'default' ? savedWidgets?.chat?.layout : selected?.layout) === 'horizontal';
  const src = id === 'default' ? '/widget/chat?demo' : `/widget/chat?variant=${enc(id)}&demo`;
  return <div className="dir-widget-preview">
    <label className="check" htmlFor="dir-chat-preview"><input id="dir-chat-preview" type="checkbox" checked={visible} onChange={e => toggle(e.target.checked)} /> Vista previa del widget de chat</label>
    {visible && <div className="dir-widget-preview__content">
      {variants && variants.length > 0 && <label htmlFor="dir-chat-variant">Variante de chat<select id="dir-chat-variant" value={id} onChange={e => choose(e.target.value)}>
        <option value="default">Predeterminada</option>{variants.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select></label>}
      {!variants && !error && <p className="hint" role="status">Cargando variantes…</p>}
      {error && <p className="hint" role="alert">{error} <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => { setError(''); setAttempt(n => n + 1); }}>Reintentar</button></p>}
      {notice && <p className="hint" role="status">{notice}</p>}
      <figure className={cx('eg-stage', 'dir-widget-stage', horizontal && 'is-horizontal')}>
        <figcaption className="eg-stage__bar"><span className="eg-eyebrow">Vista previa</span><span className="eg-stage__spacer" /><span>Datos de ejemplo</span></figcaption>
        <ScaledFrame src={src} w={horizontal ? 1832 : 600} h={horizontal ? 160 : 900} title="Vista previa del widget de chat" />
      </figure>
    </div>}
  </div>;
}

export function Chat() {
  const chat = useLive(s => s.widgets?.chat || []);
  const cfg = useLive(s => s.config.chat);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState(cfg.twitchChannel || '');
  const log = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  // si estás leyendo más arriba o seleccionando texto, el chat no te mueve
  useLayoutEffect(() => { const el = log.current; if (el && stick.current && !document.getSelection()?.toString()) el.scrollTop = el.scrollHeight; }, [chat.length]);
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, []);
  const send = guard(async () => {
    const v = text.trim(); if (!v) return;
    const r = await post<ChatSendResult>('/api/chat/send', { text: v, to: cfg.sendTo || 'twitch' });
    setText(''); toast(sendResultText(r), !!Object.keys(r.errors || {}).length);
  });
  return <>
    <ViewHead tour="chat-head" crumb="En directo › Chat" title="Chat" hint="Twitch y YouTube juntos, ya filtrados. Los mensajes con comando salen marcados. Últimos 200. Tus mensajes no salen en el chat en pantalla." actions={<><input value={channel} onChange={e => setChannel(e.target.value)} placeholder="canal de Twitch (vacío = el tuyo)" />
        <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/chat/join', { channel: channel.trim() }), 'Leyendo el chat')}>Leer este canal</button></>} />
    <article className="panel chatpanel">
      <ol className="chatlog" data-tour="chat-log" ref={log} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30; }}>
        {/* la caja va dentro del ol a propósito: el chatlog es ancla del tour y debe existir siempre;
            con un hijo dentro, el ol deja de estar :empty y el pseudo-texto de panel.css no sale */}
        {!chat.length && <EmptyState action={<a className="eg-btn eg-btn--secondary eg-btn--sm" href="#/conexiones">Conectar Twitch</a>}>Todavía no hay mensajes. Conecta Twitch para leer tu chat.</EmptyState>}
        {chat.map(m => <li key={m.id} className={cx(m.command && 'cmd', m.owner && 'own')}><time>{fmtTime(m.at)}</time><span className="pf">{m.platform === 'twitch' || m.platform === 'youtube' ? <PfIcon platform={m.platform} /> : '··'}</span>
          <b>{m.user}{m.owner ? <> <span className="tagm you">Tú</span></> : m.mod ? ' ◆' : ''}</b><span>{m.text}</span></li>)}
      </ol>
      <div className="row chat-send" data-tour="chat-send">
        <SendTo value={cfg.sendTo || 'twitch'} onChange={v => live.patchConfig({ chat: { sendTo: v } })} />
        <input className="grow" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} placeholder="Escribe en tu chat…" style={{ minWidth: 200 }} />
        <button className="eg-btn eg-btn--primary" onClick={send}>Enviar</button>
      </div>
      <ChatPreview />
    </article>
  </>;
}
