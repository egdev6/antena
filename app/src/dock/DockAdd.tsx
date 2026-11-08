import { useState, type ReactNode } from 'react';
import { guard } from '../lib/ui';

export function DockAdd({ label, placeholder, onAdd, children }: { label: string; placeholder: string; onAdd: (value: string) => Promise<void>; children?: ReactNode }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const add = guard(async () => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    try { await onAdd(text); setValue(''); }
    finally { setBusy(false); }
  });
  return <form className="d-add" onSubmit={e => { e.preventDefault(); add(); }}>
    <div className="d-row">
      <input aria-label={label} placeholder={placeholder} value={value} disabled={busy} onChange={e => setValue(e.target.value)} />
      <button className="d-btn sm" type="submit" disabled={busy || !value.trim()}>Añadir</button>
    </div>
    {children}
  </form>;
}
