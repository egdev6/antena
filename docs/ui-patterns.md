# Panel UI patterns

Rules for the React panel (`app/src/panel`). The goal: the same task looks and behaves the same in every
view. Shared pieces live in `app/src/lib/ui.tsx`; UI copy stays in Spanish.

## Collections: item tabs vs list + sub-route

Use **item tabs** (`ItemTabs`) when a view edits one object at a time from a small set the user creates:
one tab per object, the selected one is edited below, and the last tab is «+ Nuevo …» / «+ Nueva».

| Collection | View | «+ …» tab |
| --- | --- | --- |
| Goals | `Widgets.tsx` (Goals) | creates the object directly and selects it |
| Teleprompter scripts | `Teleprompter.tsx` | creates the object directly and selects it |
| Tier lists | `Interactivos.tsx` (TierList) | opens a creation form (title + items), then selects the new list |
| Shortcuts | `Atajos.tsx` | opens a creation form (name), then selects the new shortcut |

- Create directly when the object needs no input to exist; open a form when it needs data first.
- After creating, select the new item. After deleting, fall back to a valid selection (the first item, or
  the «+ …» tab when the collection is empty or when the view had no other object selected).
- Use the tab badge (`badge`) for a short state: «en pantalla», «oculto», «sin guardar».
- If a collection has a hard minimum (the last teleprompter script), disable the delete button and say why
  in its `title`.

Use **list + sub-route** when each object has a large editor of its own (tabs, preview, test buttons):
the list shows one `eg-post eg-post--row` per object with its actions, and «Editar» goes to its own route.
Commands (`#/comandos` → `#/comando/<id>`), scheduled messages (`#/mensajes` → `#/mensaje/<id>`) and alert
variations (`#/alerta/<type>/v/<id>`) follow this pattern.

### Saving inside item tabs

Most editors save as you type (`LazyInput`, `live.patchConfig`). Shortcut steps are the exception: they keep
an explicit «Guardar pasos» button because a half-built chain of steps should not run from the Stream Deck.
Non-selected shortcut cards stay mounted (`hidden`) so unsaved steps survive a tab switch, and the tab shows
«sin guardar» while there are pending changes.

## Rows and reordering

- A row is `article.eg-post.eg-post--row`: `eg-post__content` (bold name + `eg-post__meta` lines), then its
  actions. Use `is-off` for disabled objects.
- Reorder with `IconBtn` up/down (`IC.up` «Subir», `IC.down` «Bajar»), disabled at the ends.
- Remove a sub-element with `IconBtn` `IC.x` and a specific label («Quitar paso», «Quitar acción»,
  «Quitar tier»), never a text «✕» button.

## Buttons

Only `eg-btn` classes from EGDEV Foundation; the legacy `btn`, `btn ghost`, `btn sm` classes are not used in
views.

| Role | Classes |
| --- | --- |
| Main action of a view or section | `eg-btn eg-btn--primary` |
| Secondary action | `eg-btn eg-btn--secondary` or `eg-btn eg-btn--ghost` |
| Inside rows, cards and toolbars | add `eg-btn--sm` |
| Destructive | add `danger` (red on hover) |
| Icon-only | `IconBtn` (always with an accessible `label`) |

## Empty states

Use `EmptyState` for an empty list or section: it renders `eg-post eg-post--empty empty-state` (dashed box,
muted text, no pointer cursor). Do not use `li.empty`, `li.hint` or a loose `p.hint` for «nothing here yet».
Render the list element only when it has items, so the empty state is never inside a `ul`/`ol`.

## Delete confirmation

Keep the native `confirm()`, through `confirmDelete(name, fallback)`:

- With a name: `¿Borrar «<nombre>»?`.
- Without a name: `¿Borrar este <cosa>?` / `¿Borrar esta <cosa>?` (the `fallback` argument).
- Removing a sub-element that matches a «Quitar …» button uses the same shape with «Quitar»:
  `¿Quitar «<nombre>»?`. Ask only when something would be lost (for example a block with text).
- Other confirmations (reset, regenerate a key, empty a list) describe the consequence in one sentence.

## Custom CSS help

Every custom CSS field is followed by `<p className="css-help">Clases: <code>.x</code> …</p>` listing the
classes the user can target. Derive them from the real widget markup (`public/widgets/*.html`,
`public/overlay.html`), including state classes (`.done`, `.flash`, `.empty`, `.col`). Longer references
(variables, animations) go in a collapsed `details.css-ref` after the list.

## Preview refresh

- Widgets that subscribe to their config over SSE update their preview by themselves.
- A preview whose widget only reads its config when it loads must remount when the config changes: key the
  `ScaledFrame` by the config (`key={JSON.stringify(config)}`, see Goals). Do not remount on live values
  (counters), only on configuration.
