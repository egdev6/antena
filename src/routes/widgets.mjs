// General widget settings; goals, variants and followers register separately.
import { validatePath, validateChatVariantsTransition } from '../config-schema.mjs';
import { httpError } from '../http-util.mjs';
import { deepMerge } from '../store.mjs';

export function registerWidgetRoutes({ route, store, engine }) {
  route('GET', '/api/widgets', async () => engine.widgetState());
  route('PUT', '/api/widgets', async body => {
    const patch = { ...body }; delete patch.goals;
    // Solo el campo nuevo se valida aquí: el resto del merge legacy no cambia.
    if (patch.chat && Object.hasOwn(patch.chat, 'layout')) {
      const [error] = validatePath('widgets.chat.layout', patch.chat.layout ?? false);
      if (error) throw httpError(400, error.message);
    }
    if (Object.hasOwn(patch, 'thanks')) {
      const [error] = validatePath('widgets.thanks', patch.thanks);
      if (error) throw httpError(400, error.message);
    }
    if (Object.hasOwn(patch, 'chatVariants')) {
      const [error] = validateChatVariantsTransition(store.config.widgets?.chatVariants, patch.chatVariants, store.config.widgets?.chat);
      if (error) throw httpError(400, error.message);
    }
    store.config.widgets = deepMerge(store.config.widgets, patch);
    if (Array.isArray(body.goals)) store.config.widgets.goals = body.goals;
    await store.save('widgets');
    return { widgets: store.config.widgets };
  });
}
