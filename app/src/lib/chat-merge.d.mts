// Tipos de chat-merge.mjs (la implementación vive en el .mjs, probada unitariamente desde test/).
import type { ChatMessage } from './types';

export function mergeChat(
  prev: ChatMessage[] | undefined,
  snap: ChatMessage[] | undefined,
  inflight: Set<string>,
): ChatMessage[];
