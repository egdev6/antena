// Editor del dock: el estado es el borrador de config, no otra copia que guardar por separado.
import { useState } from 'react';
import { DEFAULT_DOCK, normalizeDock } from '../../../../src/dock-layout.mjs';
import { withKey } from '../../lib/api';
import { IC } from '../../lib/icons';
import { live, useLive } from '../../lib/live';
import { cx, IconBtn, ScaledFrame, Sec, Seg, Switch } from '../../lib/ui';
import type { DockConfig, DockLayout, DockModuleId, DockZone } from '../../lib/types';

const MODULE_LABELS: Record<DockModuleId, string> = {
  stream: 'Emisión', alerts: 'Alertas', marks: 'Marca y agradecidos', scenes: 'Escenas',
  teleprompter: 'Teleprompter', credits: 'Créditos', audio: 'Audio', questions: 'Preguntas',
  tierlist: 'Tier list', giveaway: 'Sorteo', shortcuts: 'Atajos',
};
const defaults = DEFAULT_DOCK as DockConfig;
const isKnown = (id: string): id is DockModuleId => Object.hasOwn(MODULE_LABELS, id);
const isSplit = (layout: DockLayout) => layout === 'split-v' || layout === 'split-h';

/** Offer omitted known modules without silently changing the saved draft or preview. */
function editorModules(dock: DockConfig) {
  const modules = [...dock.modules];
  for (const item of defaults.modules) if (!modules.some(m => m.id === item.id)) modules.push({ id: item.id, enabled: false });
  return modules;
}

function newZone(zones: DockZone[]): DockZone {
  let n = zones.length + 1;
  while (zones.some(zone => zone.id === `zone-${n}`)) n++;
  return { id: `zone-${n}`, label: `Zona ${n}`, modules: [] };
}

/** Keep empty zones editable, but in a split show the nonempty zones the dock actually renders. */
function editorZones(dock: DockConfig, projection: DockConfig): DockZone[] {
  const zones = isSplit(dock.layout)
    ? projection.zones.slice(0, 2).map(z => dock.zones.find(saved => saved.id === z.id) || z)
    : [...dock.zones];
  if (isSplit(dock.layout)) for (const zone of dock.zones) {
    if (zones.length >= 2) break;
    if (!zones.some(z => z.id === zone.id)) zones.push(zone);
  }
  if (!zones.length && projection.zones.length) zones.push(projection.zones[0]);
  const min = isSplit(dock.layout) ? 2 : 1;
  while (zones.length < min) zones.push(newZone([...dock.zones, ...zones]));
  return zones;
}

/** Changing to a split must not strand the modules from the other zones outside its two panes. */
function chooseLayout(dock: DockConfig, layout: DockLayout): DockConfig {
  if (!isSplit(layout)) return { ...dock, layout };
  const zones = [...dock.zones];
  // Before adding an empty zone, keep unplaced modules in their current effective last zone.
  if (zones.length < 2) for (const projected of (normalizeDock(dock) as DockConfig).zones) {
    const index = zones.findIndex(z => z.id === projected.id);
    if (index < 0) zones.push(projected);
    else zones[index] = { ...zones[index], modules: [...zones[index].modules,
      ...projected.modules.filter(id => !zones.some(z => z.modules.includes(id)))] };
  }
  while (zones.length < 2) zones.push(newZone(zones));
  const [first, second, ...rest] = zones;
  return { ...dock, layout, zones: [first, { ...second, modules: [...second.modules, ...rest.flatMap(zone => zone.modules)] }] };
}

function previewUrl(dock: DockConfig) {
  const bytes = new TextEncoder().encode(JSON.stringify(dock));
  const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  return withKey('/dock?preview=' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

export function DockEditor() {
  const dock = useLive(s => s.config.dock) || defaults;
  const [size, setSize] = useState<'narrow' | 'wide'>('narrow');
  const modules = editorModules(dock);
  const projection = normalizeDock(dock) as DockConfig;
  const visibleZones = editorZones(dock, projection);
  const set = (next: DockConfig) => live.patchConfig({ dock: next });
  const move = (index: number, direction: -1 | 1) => {
    const known = modules.map((item, i) => isKnown(item.id) ? i : -1).filter(i => i >= 0);
    const target = known[known.indexOf(index) + direction];
    if (target === undefined) return;
    const reordered = [...modules];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    set({ ...dock, modules: reordered });
  };
  const zonesWith = (id: string) => {
    const zone = visibleZones.find(z => z.id === id);
    return zone && !dock.zones.some(z => z.id === id) ? [...dock.zones, zone] : dock.zones;
  };
  const assign = (id: DockModuleId, zoneId: string) => set({ ...dock, zones: zonesWith(zoneId).map(zone => ({
    ...zone, modules: zone.id === zoneId ? [...zone.modules.filter(m => m !== id), id] : zone.modules.filter(m => m !== id),
  })) });
  const rename = (id: string, label: string) => set({ ...dock, zones: zonesWith(id).map(zone => zone.id === id ? { ...zone, label } : zone) });
  const enabled = modules.filter(item => item.enabled && isKnown(item.id));
  const knownIndices = modules.flatMap((item, i) => isKnown(item.id) ? [i] : []);

  return <div className="editor">
    <div className="form-col">
      <Sec title="Dock" id="dock-editor">
        <p className="hint lead">Elige qué aparece en el dock y en qué orden. Los cambios se aplican al guardar.</p>
        <h3 className="sub-h">Módulos</h3>
        <div className="rows">{modules.map((item, i) => isKnown(item.id) && <article key={item.id} data-dock-module={item.id} className={cx('eg-post eg-post--row', !item.enabled && 'is-off')}>
          <div className="eg-post__content"><Switch checked={item.enabled} onChange={enabled => set({ ...dock, modules: modules.map((m, index) => index === i ? { ...m, enabled } : m) })}>{MODULE_LABELS[item.id]}</Switch></div>
          <IconBtn icon={IC.up} label={`Subir ${MODULE_LABELS[item.id]}`} disabled={i === knownIndices[0]} onClick={() => move(i, -1)} />
          <IconBtn icon={IC.down} label={`Bajar ${MODULE_LABELS[item.id]}`} disabled={i === knownIndices.at(-1)} onClick={() => move(i, 1)} />
        </article>)}</div>
        <label>Distribución del dock <select aria-label="Distribución del dock" value={dock.layout} onChange={e => set(chooseLayout(dock, e.target.value as DockLayout))}>
          <option value="auto">Automática — recomendada</option><option value="tabs">Pestañas</option><option value="columns">Columnas</option>
          <option value="split-v">Partida arriba y abajo</option><option value="split-h">Lado a lado</option>
        </select></label>
        <p className="hint">Por debajo de 480 px las distribuciones elegidas usan pestañas.</p>
        <h3 className="sub-h">Zonas</h3>
        {visibleZones.map((zone, i) => <label key={zone.id}>Nombre de la zona {i + 1} <input aria-label={`Nombre de la zona ${i + 1}`} value={zone.label} onChange={e => rename(zone.id, e.target.value)} /></label>)}
        {enabled.map(item => {
          const zone = projection.zones.find(z => z.modules.includes(item.id));
          const selected = zone?.id || visibleZones[visibleZones.length - 1]?.id || '';
          const outside = zone && !visibleZones.some(z => z.id === zone.id) ? zone as DockZone : null;
          return <label key={item.id}>Zona de {MODULE_LABELS[item.id]} <select aria-label={`Zona de ${MODULE_LABELS[item.id]}`} value={selected} onChange={e => assign(item.id, e.target.value)}>
            {visibleZones.map((z, i) => <option key={z.id} value={z.id}>{z.label || `Zona ${i + 1}`}</option>)}
            {outside && <option value={outside.id} disabled>{outside.label || outside.id} · fuera de la vista</option>}
          </select></label>;
        })}
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => {
          if (confirm('¿Restablecer el dock de serie? Se sustituirán los cambios actuales por los valores de serie.')) set(structuredClone(defaults));
        }}>Restablecer el dock de serie</button>
      </Sec>
    </div>
    <div className="preview-col">
      <figure className="eg-stage">
        <figcaption className="eg-stage__bar"><span className="eg-eyebrow">Vista previa del dock</span><span className="eg-stage__spacer" />
          <Seg label="Tamaño de la vista previa" value={size} options={[[ 'narrow', 'Estrecho' ], [ 'wide', 'Ancho' ]]} onChange={setSize} />
        </figcaption>
        <ScaledFrame src={previewUrl(dock)} w={size === 'narrow' ? 420 : 1256} h={780} title="Vista previa del dock" />
        <div className="eg-stage__bar">Vista previa sin acciones · cambios sin guardar</div>
      </figure>
    </div>
  </div>;
}
