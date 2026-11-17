// Chat command routes; the returned lookup is also used by alert previews.
import { validatePath } from '../config-schema.mjs';
import { newCommand, normalizeTrigger } from '../commands.mjs';
import { httpError } from '../http-util.mjs';

export function registerCommandRoutes({ route, store, checkActions, pick, COMMAND_KEYS }) {
  const commandOf = id => {
    const c = (store.config.commands ||= []).find(x => x.id === id || normalizeTrigger(x.trigger) === normalizeTrigger(id));
    if (!c) throw httpError(404, `No existe el comando «${id}»`);
    return c;
  };
  const commandFields = body => {
    const fields = pick(body, COMMAND_KEYS);
    for (const key of ['outputMode', 'chatReply']) {
      const [error] = validatePath(`commands.0.${key}`, fields[key]);
      if (error) throw httpError(400, error.message);
    }
    checkActions(fields.actions);
    return fields;
  };

  route('GET', '/api/commands', async () => store.config.commands || []);
  route('POST', '/api/commands', async body => {
    const c = newCommand(commandFields(body));
    if ((store.config.commands || []).some(x => normalizeTrigger(x.trigger) === c.trigger)) throw httpError(409, `Ya existe el comando ${c.trigger}`);
    (store.config.commands ||= []).push(c);
    await store.save('commands');
    return { command: c };
  });
  route('PUT', '/api/commands/:id', async ({ id }, body) => {
    const c = commandOf(decodeURIComponent(id));
    Object.assign(c, commandFields(body));
    if (body.trigger) c.trigger = normalizeTrigger(body.trigger);
    await store.save('commands');
    return { command: c };
  });
  route('DELETE', '/api/commands/:id', async ({ id }) => {
    const c = commandOf(decodeURIComponent(id));
    store.config.commands = store.config.commands.filter(x => x !== c);
    await store.save('commands');
    return { commands: store.config.commands };
  });
  return commandOf;
}
