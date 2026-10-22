# Panel UI patterns

Rules for the React panel (`app/src/panel`). The goal: the same task looks and behaves the same in every
view. Shared pieces live in `app/src/lib/ui.tsx`; UI copy stays in Spanish.

## View skeleton

Every view starts with `ViewHead`, so all headers share the same order:

1. `crumb`: `<sidebar group> › <sidebar label>` (for example «Meld y Stream Deck › Atajos y Stream Deck»).
   Sidebar groups are not routes, so this crumb is plain text. Sub-routes link back to their parent view
   instead: «Comandos de chat › Comando», where «Comandos de chat» links to `#/comandos`.
2. `title` (`h1`): the sidebar label, or the object name in a sub-route (an editable `title-input` there).
3. `hint` (optional): one or two sentences on what the view does. Put «solo lo ves tú»-style notes here,
   never in the crumb.
4. `actions` (optional), on the right: status and switches that turn the whole view on/off first, then
   secondary buttons, and the primary button (if any) last.

The live dashboard (`Directo`) is the one exception: its crumb shows the stream state and clock.

## Sections and hints

- A view is made of sections: `Sec` for new code; `Panel` is the legacy wrapper and is styled the same
  (same surface, title in display caps, hairline under the header).
- The section title is the `title` prop; counts or status go in `aside` as `span.hint`; an on/off switch
  for the whole section also goes in `aside`.
- A section's introduction is the first child: `p.hint.lead`. Hints about a single field go right after
  that field as `p.hint`.
- Use `.sub-h` headings only to name a group of content that has no section of its own (for example
  «Últimos» and «Ticker» inside one form, or «Mis atajos» above the shortcut tabs).

## Forms

- Label above the control: `<label>Texto <input/></label>`. For a control that is not an input (`Seg`,
  a row of checkboxes), use `div.lbl` with the control in `div.field-ctl` (or `div.row.field-ctl`).
- Two or three fields side by side: `.row2` / `.row3`. Inline controls with buttons: `.row` / `.row.tight`
  (inputs inside a row and in header actions lose the «label above» margin automatically).
- On/off settings use `Switch`, also inside `.row2` / `.row3` (it aligns with the neighbouring inputs).
  Checkboxes (`label.check`) are only for picking several options from a set (platforms, items to show)
  and for fields of a form that is sent with a button («Es moderador», «sub o miembro»).
- No inline `style` for spacing or alignment. Use the classes: `.mt` (16 px) / `.mt-s` (8 px) top margin,
  `.lead` (12 px below), `.field-ctl` (6 px above a non-input control), `.push` (push to the right in a
  flex row), `.grow` (take the remaining width), `.row.middle` (center vertically), `.row.to-end` (align
  to the bottom right). Inline styles are fine for data-driven values (colors, progress, sizes of a
  specific control).

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

## Guided tour anchors

The first-run greeting and the guided tour (`app/src/panel/tour/`, driver.js) point at elements marked with
`data-tour="<id>"`. To add a step:

1. Mark the element: pass `tour="<id>"` to `ViewHead`, `Sec`, `Panel` or `ItemTabs`, or add
   `data-tour="<id>"` to any other element. Ids are `<view>-<zone>` (`chat-log`, `meld-connection`); sidebar
   groups are `nav-<group>`. An anchor only adds the attribute: never change layout or behaviour for the tour.
2. Add an entry to `TOUR_STEPS` (`app/src/panel/tour/steps.ts`): `route` (the hash to open), `anchor`, and the
   `title` and `text` in Spanish (one or two short sentences). `side` places the popover.
3. Anchor a box that is always rendered in that view. If the anchor does not appear within 2 s (a section that
   only exists when Meld is connected, a sidebar group in the narrow layout), the tour skips the step, so a
   step that is often missing is a step to rethink.
4. Update `test/onboarding-browser.test.mjs` if the step changes the route order it checks.
