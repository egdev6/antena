// Tipos del estado (/api/state) y de las respuestas que usa la interfaz React (#74).
// Espejo del servidor (src/server.mjs y módulos): campos opcionales salvo lo que el
// servidor garantiza. Sin `any` en la API pública.

// ---------- comunes ----------
export type Platform = 'twitch' | 'youtube';
export type Destination = 'twitch' | 'youtube' | 'both';

/** Resultado de un envío por plataforma (chat, timers, atajos…). */
export interface SendResult { ok?: boolean; kind?: string; error?: string; [k: string]: unknown }
export interface ErrorItem { message?: string; error?: string; [k: string]: unknown }

// ---------- mensajes de chat ----------
export interface ChatPart { e?: string; t?: string; alt?: string; [k: string]: unknown }
export interface ChatMessage {
  id: string;
  at: string | number;
  platform: string;
  user: string;
  text: string;
  login?: string;
  color?: string;
  parts?: ChatPart[];
  owner?: boolean;
  mod?: boolean;
  member?: boolean;
  highlighted?: boolean;
  command?: boolean;
  used?: boolean;
  [k: string]: unknown;
}
export interface ChatSendResult { sent?: Record<string, unknown>; errors?: Record<string, string>; [k: string]: unknown }

// ---------- alertas ----------
export interface AlertAction {
  kind: string;
  delaySec?: number;
  scene?: string;
  layer?: string;
  hideLayer?: string;
  toggleLayer?: string;
  effect?: string;
  command?: string;
  event?: string;
  amount?: number;
  text?: string;
  destination?: string;
  seconds?: number;
  returnAfterSec?: number;
  [k: string]: unknown;
}
export interface AlertConditions {
  minAmount?: number | string;
  maxAmount?: number | string;
  tier?: string;
  users?: string;
  messageContains?: string;
  chance?: number;
  [k: string]: unknown;
}
export interface AlertVariation {
  id: string;
  name: string;
  enabled?: boolean;
  conditions: AlertConditions;
  overrides?: Partial<AlertConfig>;
  [k: string]: unknown;
}
export interface AlertConfig {
  enabled?: boolean;
  layout?: 'card' | 'media';
  media?: string;
  sound?: string;
  soundVolume?: number;
  durationMode?: 'media' | 'fixed';
  durationMs?: number;
  textDelayMs?: number;
  title?: string;
  text?: string;
  sub?: string;
  minAmount?: number;
  textX?: number;
  textY?: number;
  textWidth?: number;
  fontSize?: number;
  textAlign?: string;
  textColor?: string;
  accentColor?: string;
  ttsEnabled?: boolean;
  ttsTemplate?: string;
  ttsMinAmount?: number;
  actions?: AlertAction[];
  animIn?: string;
  animOut?: string;
  mediaSize?: number;
  mediaVolume?: number;
  css?: string;
  variations?: AlertVariation[];
  [k: string]: unknown;
}
export interface AlertType { label: string; platform?: string; [k: string]: unknown }

// ---------- comandos, mensajes programados y atajos ----------
export interface CommandConfig {
  id: string;
  trigger: string;
  title?: string;
  text?: string;
  sub?: string;
  enabled?: boolean;
  permission?: string;
  platforms?: string[];
  cooldownSec?: number;
  userCooldownSec?: number;
  [k: string]: unknown;
}
export interface TimerRuntime {
  nextInSec?: number;
  blockedBy?: string;
  lines?: number;
  runs?: number;
  lastRunAt?: string | number;
  platforms?: Record<string, SendResult>;
  warnings?: { message: string }[];
  lastError?: string;
  [k: string]: unknown;
}
export interface TimerConfig {
  id: string;
  name: string;
  message?: string;
  intervalMin?: number;
  minChatLines?: number;
  destination?: Destination;
  onlyWhenLive?: boolean;
  announce?: boolean;
  announceColor?: string;
  showAlert?: boolean;
  enabled?: boolean;
  runtime?: TimerRuntime;
  [k: string]: unknown;
}
export interface ShortcutStep {
  kind: string;
  action?: string;
  arg?: string;
  delaySec?: number;
  scene?: string;
  layer?: string;
  text?: string;
  command?: string;
  event?: string;
  effect?: string;
  seconds?: number;
  [k: string]: unknown;
}
export interface ShortcutConfig { id: string; name: string; color?: string; steps: ShortcutStep[]; path?: string }

// ---------- widgets y objetivos (#128: cajas con barras por plataforma) ----------
export interface GoalBar { id: string; platform: 'twitch' | 'youtube'; metric: string; target: number; visible?: boolean; [k: string]: unknown }
export interface GoalConfig { id: string; title: string; visible?: boolean; showMetric?: boolean; css?: string; bars: GoalBar[]; [k: string]: unknown }
export interface GoalValue extends GoalConfig { bars: (GoalBar & { value?: number })[] }
/** Sección de ajustes de un widget (chat, latest, ticker, credits): campos dinámicos. */
export type WidgetSection = Record<string, unknown>;
export interface WidgetsConfig {
  goals?: GoalConfig[];
  chat?: WidgetSection;
  latest?: WidgetSection;
  ticker?: WidgetSection;
  credits?: WidgetSection;
  [k: string]: unknown;
}
/** Estado que consumen los widgets (engine.widgetState()). */
export interface WidgetState {
  chat: ChatMessage[];
  goals: GoalValue[];
  totals: Record<string, number>;
  [k: string]: unknown;
}

// ---------- configuración (store.publicConfig()) ----------
export interface PrompterConfig {
  monitor?: string;
  micTrack?: string;
  fontSize?: number;
  chatLines?: number;
  hideCommands?: boolean;
  autoSwitch?: boolean;
  mirror?: boolean;
  css?: string;
  [k: string]: unknown;
}
export interface ChatConfig { sendTo?: Destination; twitchChannel?: string; [k: string]: unknown }
export interface OverlayConfig { css?: string; volume?: number; queueMax?: number; [k: string]: unknown }
export interface MeldConfig { enabled?: boolean; autoSession?: boolean; url?: string; [k: string]: unknown }
export interface TtsConfig { enabled?: boolean; voice?: string; rate?: number; pitch?: number; volume?: number; maxChars?: number; [k: string]: unknown }
export interface FiltersConfig {
  enabled?: boolean;
  blockedWords?: string[];
  replaceWith?: string;
  blockedUsers?: string[];
  blockLinks?: boolean;
  maxMessageLength?: number;
  [k: string]: unknown;
}
export interface TwitchConfig { clientId?: string; [k: string]: unknown }
export interface YoutubeConfig {
  apiKey?: string;
  channelId?: string;
  video?: string;
  pollSeconds?: number;
  clientId?: string;
  clientSecret?: string;
  [k: string]: unknown;
}
export interface Config {
  alerts: Record<string, AlertConfig>;
  commands: CommandConfig[];
  timers: TimerConfig[];
  shortcuts: ShortcutConfig[];
  widgets: WidgetsConfig;
  prompter: PrompterConfig;
  chat: ChatConfig;
  overlay: OverlayConfig;
  meld: MeldConfig;
  tts: TtsConfig;
  filters: FiltersConfig;
  twitch: TwitchConfig;
  youtube: YoutubeConfig;
  [key: string]: unknown;
}

// ---------- estado de conexiones ----------
export interface TwitchStatus {
  state?: string;
  user?: string;
  channel?: string;
  device?: { url: string; code: string } | null;
  subscriptions?: string[];
  errors?: string[];
  [k: string]: unknown;
}
export interface YoutubeStatus {
  state?: string;
  title?: string;
  polls?: number;
  notice?: string;
  retryAt?: string | number;
  account?: string;
  liveChatId?: string;
  errors?: string[];
  [k: string]: unknown;
}
export interface MeldStatus { state?: string; streaming?: boolean; error?: string; [k: string]: unknown }
export interface PersistenceState { dirty?: Record<string, boolean>; pending?: Record<string, number>; [k: string]: unknown }
export interface PauseState { paused?: boolean; held?: number; [k: string]: unknown }
export interface Status {
  twitch?: TwitchStatus;
  youtube?: YoutubeStatus;
  chat?: { state?: string; channel?: string; [k: string]: unknown };
  meld?: MeldStatus;
  overlays: number;
  pause?: PauseState;
  persistence?: PersistenceState;
  sessionRecovery?: unknown;
  sessionArchive?: unknown;
  heldRecovery?: unknown;
}

// ---------- Meld ----------
export interface MeldScene { id: string; name: string; current?: boolean; layers: MeldLayer[]; [k: string]: unknown }
export interface MeldLayer { id: string; name: string; visible?: boolean; url?: string; [k: string]: unknown }
export interface MeldTrack { id: string; name: string; muted?: boolean; [k: string]: unknown }
export interface MeldSession {
  scenes: MeldScene[];
  tracks: MeldTrack[];
  streaming?: boolean;
  recording?: boolean;
  [k: string]: unknown;
}
export interface Meld { session?: MeldSession | null; commands?: string[]; events?: string[]; [k: string]: unknown }

// ---------- interactivos (preguntas, tier list, sorteo) ----------
export interface Question { id: string; at: string | number; platform: string; user: string; text: string; status: string; [k: string]: unknown }
export interface TierListTier { id?: string; label: string; color: string; [k: string]: unknown }
export interface TierListItem { id: string; label: string; [k: string]: unknown }
export interface TierList {
  id: string;
  title: string;
  items: TierListItem[];
  tiers: TierListTier[];
  placements: Record<string, string>;
  [k: string]: unknown;
}
export interface VoteSummary {
  listId?: string;
  item?: TierListItem | null;
  total: number;
  counts: Record<string, number>;
  endsAt?: string | number | null;
  winner?: string | null;
  [k: string]: unknown;
}
export interface GiveawayEntry { user: string; member?: boolean; platform?: string; [k: string]: unknown }
export interface GiveawayWinner { user: string; at: string | number; platform?: string; [k: string]: unknown }
export interface GiveawayHistory { at: string | number; title?: string; prize?: string; winner: string; entries: number; [k: string]: unknown }
export interface GiveawayState {
  open: boolean;
  count: number;
  entries: GiveawayEntry[];
  winners: GiveawayWinner[];
  history?: GiveawayHistory[];
  [k: string]: unknown;
}
/** Ajustes de preguntas, tier list y sorteo: secciones dinámicas (IxField accede por nombre). */
export type InteractiveConfig = Record<string, Record<string, unknown>>;
export interface Interactive {
  questions: { list: Question[]; pending: number; current: Question | null };
  tierlists?: TierList[];
  shownTierlist?: string | null;
  vote: VoteSummary | null;
  giveaway: GiveawayState;
  config: InteractiveConfig;
  [k: string]: unknown;
}

// ---------- cronología e historial ----------
export interface TimelineItem {
  id: string;
  kind: string;
  at: string | number;
  offset: number;
  type?: string;
  user?: string;
  sub?: string;
  text?: string;
  label?: string;
  platform?: string;
  amount?: number;
  message?: string;
  done?: boolean;
  twitchError?: string;
  twitchMarker?: boolean;
  variation?: { name: string } | null;
  [k: string]: unknown;
}
export interface Timeline {
  items: TimelineItem[];
  pending: number;
  startedAt?: string | number | null;
  title?: string;
  limit?: number;
  capped?: boolean;
}
export interface HistoryItem {
  id: string;
  at: string | number;
  type: string;
  text?: string;
  sub?: string;
  variation?: { name: string } | null;
  [k: string]: unknown;
}

// ---------- resto del estado ----------
export interface MediaItem { name: string; kind: 'video' | 'image' | 'audio'; size?: number; [k: string]: unknown }
export interface Metric { label: string; [k: string]: unknown }
export interface Access { lan?: boolean; urls?: string[]; [k: string]: unknown }
export interface UploadResult { name: string; media: MediaItem[]; [k: string]: unknown }
export interface SessionSummary { startedAt?: string | number; title?: string; totals?: Record<string, number>; eventCount?: number; [k: string]: unknown }
export interface SessionList { past?: { id: string; startedAt?: string | number; title?: string; events?: number }[]; [k: string]: unknown }

// ---------- récord de espectadores (src/viewers.mjs) ----------
export interface ViewerSettings { enabled: boolean; pollSec: number; minViewers: number; confirmPolls: number; minStep: number; minStepPct: number; cooldownMin: number; warmupMin: number; alertFirst: boolean }
export interface ViewerPlatform { live: boolean; off: boolean; current: number | null; peak: number; record: number; liveSince: string | null; pending: boolean; alerts: number; lastAlertAt: string | null; lastAlertValue: number | null; nextAt: number; updatedAt: string | null; error: string | null }
export interface ViewersState { settings: ViewerSettings; platforms: Record<'twitch' | 'youtube', ViewerPlatform> }
// ---------- teleprompter (src/teleprompter.mjs) ----------
export interface TpBlock { id: string; title: string; text: string }
export interface TpScript { id: string; title: string }
export interface TpToken { w?: string; i?: number; note?: string; at?: number; br?: number }
export interface TpSettings { wpm: number; size: number; mirror: boolean; line: boolean; pauseAtNotes: boolean; countdownSec: number; monitor?: string }
export interface TpCompiledBlock { id: string; title: string; text: string; start: number; words: number; tokens: TpToken[] }
export interface TpCompiled { id: string | null; title: string; total: number; notes: number[]; blocks: TpCompiledBlock[] }
export interface TeleprompterState {
  settings: TpSettings;
  activeId: string | null;
  scripts: TpScript[];
  script: TpCompiled;
  playback: { playing: boolean; anchorWord: number; anchorAt: number; position: number; block: number; serverNow: number };
}

// ---------- Apariencia: tema de pantalla (src/theme.mjs) ----------
export interface Theme {
  accent: string; accentSoft: string; text: string; textSoft: string; muted: string;
  surface: string; surfaceOpacity: number; surfaceStyle: 'gradient' | 'solid' | 'glass'; border: string; borderWidth: number; glow: number;
  platformAccent: boolean; twitchColor: string; youtubeColor: string;
  fontDisplay: string; fontBody: string; textScale: number; uppercase: boolean; outline: boolean;
  iconStroke: 'thin' | 'normal' | 'bold'; iconColor: string; tileShape: 'square' | 'round' | 'none'; platformBadge: 'text' | 'logo' | 'none'; icons: Record<string, string>;
  round: number; alertWidth: number; alertScale: number; tilt: boolean; reflection: boolean; decorations: boolean; timerBar: boolean;
  position: 'top' | 'center' | 'bottom'; align: 'left' | 'center' | 'right'; offsetX: number; offsetY: number; animation: '3d' | 'slide' | 'fade' | 'pop' | 'none';
  sound: string; soundVolume: number; version?: string;
}
export interface ThemeInfo {
  theme: Theme; defaults: Theme; presets: { id: string; label: string; theme: Partial<Theme> }[];
  fonts: { id: string; label: string; css: string }[]; icons: string[]; sounds: string[]; images: string[];
}

/** Respuesta de GET /api/state (src/server.mjs). */
export interface AppState {
  config: Config;
  types: Record<string, AlertType>;
  defaults: Record<string, AlertConfig>;
  lookDefaults: Partial<AlertConfig>;
  fields?: unknown;
  conditionDefaults: AlertConditions;
  commandDefaults: Partial<CommandConfig>;
  samples: Record<string, Record<string, string>>;
  status: Status;
  history: HistoryItem[];
  media: MediaItem[];
  metrics: Record<string, Metric>;
  meld: Meld;
  widgets: WidgetState;
  access: Access;
  widgetNames?: string[];
  timers: TimerConfig[];
  timerDefaults: Partial<TimerConfig>;
  announceColors?: unknown;
  interactive: Interactive;
  viewers?: ViewersState;
  teleprompter?: TeleprompterState;
  theme?: Theme;
}

/** Pestañas del prompter y estado del prompter (/api/prompter). */
export interface PrompterState { tab?: string; at?: number; auto?: boolean; [k: string]: unknown }

// ---------- eventos SSE (contrato único, src/events.mjs) ----------
export interface ChatResult { origin?: { kind?: string; type?: string; trigger?: string } | null; platforms?: Record<string, SendResult>; [k: string]: unknown }
/** Payload de cada evento del bus: mapea el nombre del evento con su tipo. */
export interface LiveEvents {
  status: Status;
  persistence: PersistenceState;
  pause: PauseState;
  history: HistoryItem[];
  interactive: Interactive;
  timers: TimerConfig[];
  meld: MeldSession;
  widgets: WidgetState;
  chat: ChatMessage;
  chatDelete: { id: string };
  chatResult: ChatResult;
  chatClear: { login: string };
  timeline: Timeline;
  prompter: PrompterState;
  config: Partial<Config>;
  viewers: ViewersState;
  teleprompter: TeleprompterState;
  theme: Theme;
  gap: unknown;
  /** Evento solo de cliente: fallos de fetch/config que el propio Live emite. */
  error: Error;
}
export type LiveEventName = keyof LiveEvents;
