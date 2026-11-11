// Variantes de chat: copiar el predeterminado al crear y validar antes de tocar el store.
import { isDeepStrictEqual } from 'node:util';
import { CONFIG_SCHEMA, validatePatch, chatVariantId } from '../config-schema.mjs';
import { httpError } from '../http-util.mjs';

const CHAT_FIELDS = Object.keys(CONFIG_SCHEMA.widgets.chat);
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'La variante necesita un nombre');
  return value.trim().slice(0, 60).trimEnd();
};
const requireObject = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'La variante tiene que ser un objeto');
};

export function registerChatVariantsRoutes({ route, store }) {
  const variantsOf = () => {
    const variants = store.config.widgets.chatVariants;
    if (!Array.isArray(variants)) throw httpError(400, 'Las variantes del chat tienen que ser una lista');
    return variants;
  };
  const find = id => {
    let decoded;
    try { decoded = decodeURIComponent(id); } catch { throw httpError(400, 'Id de variante no válido'); }
    if (decoded === 'default') throw httpError(400, 'La variante predeterminada no se puede borrar ni editar aquí');
    const variant = variantsOf().find(v => v?.id === decoded);
    if (!variant) throw httpError(404, `No existe la variante «${decoded}»`);
    return variant;
  };
  const validate = variant => {
    // validatePatch permite null por compatibilidad genérica; una variante completa no lo admite.
    for (const field of CHAT_FIELDS) {
      if (variant[field] == null) throw httpError(400, `${field}: no puede estar vacío`);
    }
    const errors = validatePatch({ widgets: { chatVariants: [variant] } });
    if (errors.length) throw httpError(400, errors.map(e => e.message).join('; '));
  };
  const save = variants => store.patchConfig({ widgets: { chatVariants: variants } });

  route('GET', '/api/widgets/chat/variants', async () => variantsOf());
  route('POST', '/api/widgets/chat/variants', async body => {
    requireObject(body);
    const name = nameOf(body.name);
    const variants = variantsOf();
    const id = chatVariantId(name, variants);
    if (Object.hasOwn(body, 'id') && body.id !== id) throw httpError(400, 'El id de la variante nueva se genera a partir del nombre');
    for (const field of CHAT_FIELDS) {
      if (Object.hasOwn(body, field) && !isDeepStrictEqual(body[field], store.config.widgets.chat?.[field])) {
        throw httpError(400, `El campo «${field}» de una variante nueva se copia del chat predeterminado y no puede ser distinto`);
      }
    }
    const variant = { ...structuredClone(store.config.widgets.chat), id, name };
    validate(variant);
    await save([...variants, variant]);
    return { variant };
  });
  route('PUT', '/api/widgets/chat/variants/:id', async ({ id }, body) => {
    const previous = find(id);
    requireObject(body);
    if (Object.hasOwn(body, 'id') && body.id !== previous.id) throw httpError(400, 'El id de una variante no se puede cambiar');
    const fields = Object.fromEntries(CHAT_FIELDS.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
    const variant = { ...structuredClone(previous), ...fields, ...(Object.hasOwn(body, 'name') && { name: nameOf(body.name) }) };
    validate(variant);
    await save(variantsOf().map(v => v === previous ? variant : v));
    return { variant };
  });
  route('DELETE', '/api/widgets/chat/variants/:id', async ({ id }) => {
    const variant = find(id);
    const variants = variantsOf().filter(v => v !== variant);
    await save(variants);
    return { variants };
  });
}
