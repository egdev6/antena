// Formato de fecha y hora de la interfaz (#126): dd/MM/yyyy y HH:mm en 24 horas.
// Hora con locale y ciclo explícitos; nunca usa la configuración regional del sistema.
// Las fechas siguen viajando en ISO en los datos; esto solo pinta.

const pad = (n) => String(n).padStart(2, '0');

function toDate(at) {
  if (at === undefined || at === null || at === '') return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** dd/MM/yyyy (por ejemplo, 20/10/2026). Vacío si la marca no es válida. */
export const fmtDate = (at) => {
  const d = toDate(at);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '';
};

/** HH:mm en 24 horas (por ejemplo, 15:22). Vacío si la marca no es válida. */
export const fmtTime = (at) => {
  if (at === undefined || at === null || at === '') return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
};

/** dd/MM/yyyy HH:mm. Vacío si la marca no es válida. */
export const fmtDateTime = (at) => {
  const d = toDate(at);
  return d ? `${fmtDate(d)} ${fmtTime(d)}` : '';
};
