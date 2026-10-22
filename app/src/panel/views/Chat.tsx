import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { cx, fmtTime, guard, PfIcon, PLATFORM_NAMES, Seg, toast } from '../../lib/ui';
import type { ChatSendResult } from '../../lib/types';

export function sendResultText(r: any) {
  const errs = Object.entries<string>(r.errors || {});
  return `Enviado a ${Object.keys(r.sent || {}).map(k => PLATFORM_NAMES[k]).join(' y ')}${errs.length ? ' · ' + errs.map(([k, v]) => PLATFORM_NAMES[k] + ': ' + v).join(' · ') : ''}`;
}

export function SendTo({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts: [string, React.ReactNode, string][] = [['twitch', <PfIcon platform="twitch" />, 'Solo Twitch'], ['youtube', <PfIcon platform="youtube" />, 'Solo YouTube'], ['both', 'Ambos', 'Twitch y YouTube']];
  return <div className="eg-tabs eg-tabs--segmented eg-tabs--sm send-to" role="radiogroup" aria-label="Escribir en">
    {opts.map(([v, l, t]) => <button key={v} type="button" role="radio" className="eg-tabs__item" aria-checked={v === value} aria-selected={v === value} title={t} aria-label={t} onClick={() => onChange(v)}>{l}</button>)}
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
    <header className="view-head"><div><span className="crumb">En directo › Chat</span><h1>Chat</h1><p className="hint">Twitch y YouTube juntos, ya filtrados. Los mensajes con comando salen marcados. Últimos 200.</p></div>
      <div className="actions"><input value={channel} onChange={e => setChannel(e.target.value)} placeholder="canal de Twitch (vacío = el tuyo)" style={{ width: 250, margin: 0 }} />
        <button className="btn ghost" onClick={guard(() => post('/api/chat/join', { channel: channel.trim() }), 'Leyendo el chat')}>Leer este canal</button></div></header>
    <article className="panel chatpanel">
      <ol className="chatlog" ref={log} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30; }}>
        {chat.map(m => <li key={m.id} className={cx(m.command && 'cmd', m.owner && 'own')}><time>{fmtTime(m.at)}</time><span className="pf">{m.platform === 'twitch' || m.platform === 'youtube' ? <PfIcon platform={m.platform} /> : '··'}</span>
          <b>{m.user}{m.owner ? <> <span className="tagm you">Tú</span></> : m.mod ? ' ◆' : ''}</b><span>{m.text}</span></li>)}
      </ol>
      <div className="row chat-send">
        <SendTo value={cfg.sendTo || 'twitch'} onChange={v => live.patchConfig({ chat: { sendTo: v } })} />
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} placeholder="Escribe en tu chat… (tus mensajes no salen en el chat en pantalla)" style={{ flex: 1, margin: 0, minWidth: 200 }} />
        <button className="btn" onClick={send}>Enviar</button>
      </div>
    </article>
  </>;
}
