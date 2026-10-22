// Pasos del tour guiado (O5). Cada paso abre su vista (route) y señala un elemento con
// data-tour="<anchor>" (docs/ui-patterns.md › Guided tour anchors). `when` es la condición
// para que el paso exista: al empezar el tour se quitan los que no la cumplen.
import { live } from '../../lib/live';

/** Por debajo de 860 px los grupos del menú no tienen caja propia (display: contents). */
const wideSidebar = () => matchMedia('(min-width: 861px)').matches;
/** Las escenas solo se pintan con Meld conectado. */
const meldConnected = () => live.state?.status?.meld?.state === 'conectado';

export type TourStep = {
  route: string;
  anchor: string;
  title: string;
  text: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  when?: () => boolean;
};

export const TOUR_STEPS: TourStep[] = [
  { route: '#/directo', anchor: 'nav', side: 'right', title: 'El menú', text: 'Todo antena está aquí, ordenado por grupos. Pulsa el nombre de un grupo para plegarlo; con Alt dejas abierto solo ese.' },
  { route: '#/directo', anchor: 'nav-directo', when: wideSidebar, side: 'right', title: 'En directo', text: 'Lo que usas mientras emites: el mando del directo, el chat unificado y el historial de sesiones.' },
  { route: '#/directo', anchor: 'directo-head', side: 'bottom', title: 'Tu directo', text: 'Pon el título de la sesión, descarga o copia su resumen, lanza los créditos o archiva el directo para empezar de cero.' },
  { route: '#/directo', anchor: 'directo-status', side: 'bottom', title: 'Conexiones de un vistazo', text: 'Twitch, YouTube, Meld y los overlays: en verde lo que funciona, en gris o rojo lo que falta por conectar.' },
  { route: '#/directo', anchor: 'directo-stats', side: 'bottom', title: 'Métricas', text: 'Seguidores, subs, bits y el resto de eventos del directo, contados al momento.' },
  { route: '#/directo', anchor: 'directo-alerts', side: 'right', title: 'Alertas', text: 'La última alerta que salió y la cola: sáltala, vacía la cola o repite la última.' },
  { route: '#/directo', anchor: 'directo-timeline', side: 'right', title: 'Cronología', text: 'Cada evento del directo en orden. «Marcar momento» guarda el instante (y un marcador en Twitch) para el resumen.' },
  { route: '#/chat', anchor: 'chat-log', side: 'top', title: 'Chat unificado', text: 'Twitch y YouTube en una sola lista, ya filtrados. Los comandos salen marcados.' },
  { route: '#/chat', anchor: 'chat-send', side: 'top', title: 'Escribir en el chat', text: 'Elige a qué plataforma va el mensaje y escribe sin salir del panel.' },
  { route: '#/widget/goals', anchor: 'nav-widgets', when: wideSidebar, side: 'right', title: 'Widgets en pantalla', text: 'Preguntas, teleprompter, tier list, sorteo, chat, objetivos, últimos y créditos: cada uno es una fuente de navegador para Meld.' },
  { route: '#/widget/goals', anchor: 'goals-tabs', side: 'bottom', title: 'Tus objetivos', text: 'Una pestaña por caja de objetivos. Con «+ Nuevo objetivo» creas otra caja.' },
  { route: '#/widget/goals', anchor: 'goals-editor', side: 'top', title: 'Barras y metas', text: 'Cada caja puede tener varias barras de Twitch y YouTube con su propia meta. La vista previa se actualiza al cambiar la configuración.' },
  { route: '#/meld', anchor: 'meld-head', side: 'bottom', title: 'Meld Studio', text: 'El estado de la conexión con Meld y el botón para conectar o reconectar.' },
  { route: '#/meld', anchor: 'meld-scenes', when: meldConnected, side: 'bottom', title: 'Escenas', text: 'Pulsa una escena para ponerla en directo; debajo controlas sus capas y el audio.' },
  { route: '#/meld', anchor: 'meld-connection', side: 'top', title: 'Conexión con Meld', text: 'Activa las conexiones remotas en Meld y pulsa «Conectar». Si cierras Meld, antena se reconecta sola.' },
  { route: '#/atajos', anchor: 'atajos-streamdeck', side: 'right', title: 'En el Stream Deck', text: 'Cada atajo tiene una dirección: pégala en un botón del Stream Deck con un plugin de peticiones web.' },
  { route: '#/atajos', anchor: 'atajos-list', side: 'right', title: 'Tus atajos', text: 'Un atajo encadena varias acciones: escena, alertas, mensajes en el chat… Desde la lista los pruebas, los editas o los borras; «+ Nuevo atajo», arriba, crea otro.' },
  { route: '#/conexiones', anchor: 'conexiones-twitch', side: 'right', title: 'Twitch', text: 'Conecta tu cuenta una vez con el Client ID de tu app; la sesión se guarda en tu PC.' },
  { route: '#/conexiones', anchor: 'conexiones-youtube', side: 'left', title: 'YouTube', text: 'Con la API key lees el chat del directo; conecta tu cuenta de Google para poder escribir en él.' },
  { route: '#/general', anchor: 'general-tour', side: 'bottom', title: 'Vuelve cuando quieras', text: 'Desde aquí puedes repetir este tour en cualquier momento. ¡Buen directo!' },
];
