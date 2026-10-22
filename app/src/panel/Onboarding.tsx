// Bienvenida del panel: modal con tarjetas, una por grupo del sidebar. Se muestra la
// primera vez (config.panel.onboardingDone) y se puede relanzar desde General y Ajustes;
// cerrarla o entrar en un área la marca como vista (patchConfig persiste en config.json).
import { live, useLive } from '../lib/live';

const AREAS: { href: string; title: string; text: string }[] = [
  { href: '#/directo', title: 'Directo', text: 'El mando del directo: conexiones, cronología, alertas en cola y métricas al momento.' },
  { href: '#/chat', title: 'Chat', text: 'Lee y escribe en Twitch y YouTube desde un solo sitio, con filtros y comandos ocultos.' },
  { href: '#/historial', title: 'Historial', text: 'Cada sesión se archiva con su resumen: mensajes, eventos y clips.' },
  { href: '#/comandos', title: 'Comandos y programados', text: 'Comandos de chat con permisos y mensajes que se repiten solos durante el directo.' },
  { href: '#/widget/questions', title: 'Interactivos', text: 'Preguntas, tier list y sorteos con colas, votos y anuncios en pantalla.' },
  { href: '#/widget/chat', title: 'Widgets en pantalla', text: 'Chat, objetivos, últimos y ticker, créditos: copia la URL como fuente de navegador en Meld.' },
  { href: '#/meld', title: 'Meld Studio', text: 'Fuentes y capas de Meld controladas desde antena, con sesión automática al abrir el directo.' },
  { href: '#/atajos', title: 'Atajos y Stream Deck', text: 'Botones que lanzan varias acciones a la vez; también desde el Stream Deck, el móvil o el MCP.' },
  { href: '#/general', title: 'Ajustes', text: 'Apariencia, filtros y voz, conexiones (Twitch, YouTube, Meld) y tus archivos.' },
];

/** Marca la bienvenida como vista y la guarda en el servidor. */
const marcarVista = () => live.patchConfig({ panel: { onboardingDone: true } });

export function Onboarding() {
  const done = useLive(s => s.config?.panel?.onboardingDone);
  if (done !== false) return null;   // true (ya vista) o undefined (estado aún sin cargar)
  return <div className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onb-t">
    <div className="onboarding__box">
      <header className="onboarding__head">
        <span className="kicker">Bienvenido a antena</span>
        <h1 id="onb-t">Todo lo que hace, en una pantalla</h1>
        <p className="hint">Nueve áreas para preparar, lanzar y disfrutar el directo. Entra en la que quieras conocer o cierra y explora por tu cuenta; puedes volver a abrir esta bienvenida desde <b>General y archivos</b>.</p>
      </header>
      <div className="onboarding__grid">
        {AREAS.map(a => <a key={a.href} className="onboarding__card" href={a.href} onClick={marcarVista}>
          <b>{a.title}</b><span>{a.text}</span>
        </a>)}
      </div>
      <footer className="onboarding__foot">
        <button className="btn" onClick={marcarVista}>Empezar</button>
      </footer>
    </div>
  </div>;
}
