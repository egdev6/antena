// Comandos de chat («!engram», «!web»…) que lanzan alertas propias.
import { randomUUID } from 'node:crypto';
import { DEFAULT_COMMAND } from './alerts.mjs';

export function newCommand(fields = {}) {
  const trigger = normalizeTrigger(fields.trigger || '!nuevo');
  return { ...structuredClone(DEFAULT_COMMAND), title: trigger, ...fields, trigger, id: fields.id || randomUUID().slice(0, 8) };
}

export function normalizeTrigger(t) {
  t = String(t || '').trim().split(/\s+/)[0].toLowerCase();
  if (!t) return '';
  return /^[!¡?.#]/.test(t) ? t : '!' + t;
}

export function canUse(perm, msg) {
  if (msg.owner) return true;
  if (perm === 'broadcaster') return false;
  if (perm === 'mods') return !!msg.mod;
  if (perm === 'vips') return !!(msg.mod || msg.vip);
  if (perm === 'members') return !!(msg.mod || msg.member);
  return true;
}

export class CommandRunner {
  constructor() { this.last = new Map(); }
  /** Devuelve { cmd, vars } si el mensaje dispara un comando y puede usarse ahora. */
  match(commands = [], msg, now = Date.now()) {
    const text = String(msg.text || '').trim();
    if (!text) return null;
    const [word, ...rest] = text.split(/\s+/);
    const trig = word.toLowerCase();
    const cmd = commands.find(c => c.enabled !== false && normalizeTrigger(c.trigger) === trig);
    if (!cmd) return null;
    if (cmd.platforms && !cmd.platforms.includes(msg.platform)) return null;
    if (!canUse(cmd.permission || 'everyone', msg)) return null;
    const gk = cmd.id, uk = cmd.id + ':' + (msg.login || msg.user);
    const privileged = msg.owner || msg.mod;
    if (!privileged) {
      const cool = (k, secs) => this.last.has(k) && now - this.last.get(k) < (Number(secs) || 0) * 1000;
      if (cool(gk, cmd.cooldownSec) || cool(uk, cmd.userCooldownSec)) return null;
    }
    this.last.set(gk, now); this.last.set(uk, now);
    return { cmd, vars: { user: msg.user, args: rest.join(' '), command: trig, platform: msg.platform } };
  }
}
