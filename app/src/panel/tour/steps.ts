// Pasos del tour guiado (O5). Cada paso abre su vista (route) y señala un elemento con
// data-tour="<anchor>" (docs/ui-patterns.md › Guided tour anchors). `when` es la condición
// para que el paso exista: al empezar el tour se quitan los que no la cumplen.
import { live } from '../../lib/live';

/** Por debajo de 860 px los grupos del menú no tienen caja propia (display: contents). */
const wideSidebar = () => matchMedia('(min-width: 861px)').matches;
/** Las escenas solo se pintan con Meld conectado. */
const meldConnected = () => live.state?.status?.meld?.state === 'conectado';
/** Directo necesita las dos respuestas de sesión antes de mostrar sus anclas. */
const directoReady = '[data-tour-view-ready="directo"]';

export type TourStep = {
  route: string;
  anchor: string;
  viewReady?: string;
  title: string;
  text: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  when?: () => boolean;
};

export const TOUR_STEPS: TourStep[] = [
  { route: '#/directo', anchor: 'nav', side: 'right', title: 'El menú', text: 'Todo antena está aquí, ordenado por grupos. Pulsa el nombre de un grupo para plegarlo; con Alt dejas abierto solo ese.' },
  { route: '#/directo', anchor: 'nav-directo', when: wideSidebar, side: 'right', title: 'En directo', text: 'Lo que usas mientras emites: el mando del directo, el chat unificado y el historial de sesiones.' },
  { route: '#/directo', anchor: 'directo-head', viewReady: directoReady, side: 'bottom', title: 'Tu directo', text: 'Pon el título de la sesión, descarga o copia su resumen, lanza los créditos o archiva el directo para empezar de cero.' },
  { route: '#/directo', anchor: 'directo-status', viewReady: directoReady, side: 'bottom', title: 'Conexiones de un vistazo', text: 'Twitch, YouTube, Meld y los overlays: en verde lo que funciona, en gris o rojo lo que falta por conectar.' },
  { route: '#/directo', anchor: 'directo-stats', viewReady: directoReady, side: 'bottom', title: 'Métricas', text: 'Seguidores, subs, bits y el resto de eventos del directo, contados al momento.' },
  { route: '#/directo', anchor: 'directo-alerts', viewReady: directoReady, side: 'right', title: 'Alertas', text: 'La última alerta que salió y la cola: sáltala, vacía la cola o repite la última.' },
  { route: '#/directo', anchor: 'directo-timeline', viewReady: directoReady, side: 'right', title: 'Cronología', text: 'Cada evento del directo en orden. «Marcar momento» guarda el instante (y un marcador en Twitch) para el resumen.' },
  { route: '#/chat', anchor: 'chat-log', side: 'top', title: 'Chat unificado', text: 'Twitch y YouTube en una sola lista, ya filtrados. Los comandos salen marcados.' },
  { route: '#/chat', anchor: 'chat-send', side: 'top', title: 'Escribir en el chat', text: 'Elige a qué plataforma va el mensaje y escribe sin salir del panel.' },
  { route: '#/widgets', anchor: 'widgets-catalog', side: 'bottom', title: 'Widgets en pantalla', text: 'Chat, objetivos, últimos y créditos, y los que se manejan en directo (preguntas, tier list, sorteo y teleprompter): cada uno es una fuente de navegador para Meld. Pulsa su tarjeta para abrir su página.' },
  { route: '#/widgets/objetivos', anchor: 'goals-list', side: 'right', title: 'Tus objetivos', text: 'Cada caja de objetivos es una fila: ábrela para cambiar sus barras de Twitch y YouTube y su meta. Con «+ Nuevo objetivo» creas otra.' },
  { route: '#/meld', anchor: 'meld-head', side: 'bottom', title: 'Meld Studio', text: 'El estado de la conexión con Meld y el botón para conectar o reconectar.' },
  { route: '#/meld/escenas', anchor: 'meld-scenes', when: meldConnected, side: 'bottom', title: 'Escenas', text: 'Pulsa una escena para ponerla en directo; debajo controlas sus capas y el audio.' },
  { route: '#/meld/conexion', anchor: 'meld-connection', side: 'top', title: 'Conexión con Meld', text: 'Activa las conexiones remotas en Meld y pulsa «Conectar». Si cierras Meld, antena se reconecta sola.' },
  { route: '#/atajos/streamdeck', anchor: 'atajos-streamdeck', side: 'right', title: 'En el Stream Deck', text: 'Cada atajo tiene una dirección: pégala en un botón del Stream Deck con un plugin de peticiones web.' },
  { route: '#/atajos', anchor: 'atajos-list', side: 'right', title: 'Tus atajos', text: 'Un atajo encadena varias acciones: escena, alertas, mensajes en el chat… Desde la lista los pruebas o los abres para editarlos; «+ Nuevo atajo», arriba, crea otro con una plantilla.' },
  { route: '#/conexiones', anchor: 'conexiones-twitch', side: 'right', title: 'Twitch', text: 'Conecta tu cuenta una vez con el Client ID de tu app; la sesión se guarda en tu PC.' },
  { route: '#/conexiones', anchor: 'conexiones-youtube', side: 'left', title: 'YouTube', text: 'Con la API key lees el chat del directo; conecta tu cuenta de Google para poder escribir en él.' },
  { route: '#/general/tour', anchor: 'general-tour', side: 'bottom', title: 'Vuelve cuando quieras', text: 'Desde aquí puedes repetir este tour en cualquier momento. ¡Buen directo!' },
];
