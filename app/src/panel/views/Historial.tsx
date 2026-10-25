import { post } from '../../lib/api';
import { useLive } from '../../lib/live';
import { fmtTime, guard, PfIcon } from '../../lib/ui';
import { ListPanel, NameCell, PageHead, Tags, useListFilter } from '../../lib/layout';

export function Historial() {
  const history = useLive(s => s.history || []);
  const types = useLive(s => s.types);
  const f = useListFilter();
  const pf = (h: any) => types[h.type]?.platform || 'twitch';
  const rows = history.filter((h: any) => f.chip === 'all' || (f.chip === 'command' ? h.type === 'command' : f.chip === 'var' ? !!h.variation : pf(h) === f.chip && h.type !== 'command'))
    .filter((h: any) => f.match(h.text, h.sub, types[h.type]?.label))
    .map((h: any) => ({ id: h.id, cells: {
      at: <span className="lv-mono">{fmtTime(h.at)}</span>,
      name: <NameCell name={h.text || '—'} sub={h.sub} lead={<PfIcon platform={pf(h)} />} />,
      type: types[h.type]?.label || (h.type === 'command' ? 'Comando' : h.type),
      tags: <Tags items={h.variation ? [{ t: h.variation.name, on: true }] : []} />,
      replay: <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/replay', { id: h.id }), 'Repitiendo')}>Repetir</button>,
    } }));
  return <>
    <PageHead crumb={`Registro · ${history.length} alertas`} title="Historial de alertas" desc="Las alertas que han salido en pantalla. Las pruebas no se guardan." />
    <ListPanel title="Alertas" search={f.q} onSearch={f.setQ} placeholder="Buscar por nombre o mensaje"
      chips={[['all', 'Todas'], ['twitch', 'Twitch'], ['youtube', 'YouTube'], ['command', 'Comandos'], ['var', 'Con variación']]} chip={f.chip} onChip={f.setChip}
      cols={[{ key: 'at', label: 'Hora' }, { key: 'name', label: 'Quién' }, { key: 'type', label: 'Alerta' }, { key: 'tags', label: 'Variación', hide: true }, { key: 'replay', label: '' }]}
      rows={rows} empty={history.length ? 'Ninguna alerta coincide.' : 'Todavía no ha llegado ninguna alerta.'} />
  </>;
}
