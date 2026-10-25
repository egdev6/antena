# Panel UI patterns

Rules for the React panel (`app/src/panel`). The goal: the same task looks and behaves the same in every
view. Shared pieces live in `app/src/lib/ui.tsx`; UI copy stays in Spanish.

## Hierarchy (v2) and cards (v3)

The panel follows one hierarchy, drawn on the canvas «antena — Rediseño» (pages «v2 · jerarquía» and
«v3 · tarjetas»). Shared pieces live in `app/src/lib/layout.tsx`.

- **Page header** (`PageHead`): eyebrow (`crumb`), title, an optional hint and **one** main action
  («+ Nuevo X»). It can carry page tabs. `ViewHead` stays for the views that keep the classic skeleton
  (Directo, Chat, AcercaDe).
- **Indicators** (`Kpis`): up to four, one of them can be a warning.
- **What you create → table** (`ListPanel`): search, filter chips and rows with name, subtitle, status dot
  (`Dot`), tags (`Tags`) and `→`. Commands, scheduled messages, shortcuts, tier lists, teleprompter
  scripts, goals, past streams, files and the alert history.
- **What the app offers → cards** (`CardGroup` + `Card`): the catalog, which only grows when the app gets
  a new feature: alert types (grouped by platform), connections (Plataformas · Producción y acceso) and
  widgets (Capas de pantalla · Se manejan en directo). Every card has the same anatomy: thumbnail, name,
  status, tags and a footer with its main action; the whole card links to its slide, and footer controls sit
  above that link. A new feature = one more card in its group. What the user creates inside a catalog item
  lives inside its card (the «Objetivos» card opens the goals table, like variations inside an alert).
- **Detail → full-width slide** (`Slide`): back ←, crumb, title, ✕ and Esc; tabs with a dirty dot; a sticky
  footer (`SaveBar`) with the pending state, «Descartar», «Guardar» and the view's own actions («Probar en
  el directo»). A second level opens a second slide over the first one (*Alertas › Raid › Variación*,
  *Widgets › Objetivos › Objetivo*). Addresses: `#/<page>/<id>[/<tab>]`; the old ones redirect
  (`panel/router.ts`).
- **Pages without a list → page tabs**, linkable (`#/apariencia/iconos`, `usePageTab`): Apariencia,
  Preguntas, Sorteo, Filtros y voz, General, Meld Studio, Prompter y dock, Fuentes.
- **Creating** is the same everywhere: «+ Nuevo X» opens the slide in «Nuevo» mode with the minimum fields
  and a starting template (`lv-tiles`); the other tabs are locked until «Crear». The sidebar footer has a
  «Crear» menu with every «+ Nuevo».
- **Thumbnails**: an alert card shows its design (the mini card with the theme accent, the real first frame
  of its video, or the background with the card on top); hovering or focusing the card plays a looping,
  silent preview (`MediaPreview`).

### Manual save

Configuration pages and slides do not save as you type: the change stays as a draft until «Guardar», and
«Descartar» goes back to what was saved (`lib/draft.ts`, registered sources: config, widgets, interactive,
the alert editor, the theme, a script, a shortcut). Leaving with a draft asks first (and so does the browser
when closing). Previews show the draft when they can (alerts, commands and messages through `/api/test` with
`draft`; the theme through `/api/theme/draft`, read only by `?themeDraft` layers); widget previews show what
is saved. Live operations stay immediate and say so in the footer: enabling or ordering variations, the
«Activa» switch of an alert card, placing in the tier list, opening or drawing the giveaway, moving questions,
goal counters and goals themselves, connecting and deleting files. Marks the panel sets on its own (the tour
seen, `live.saveConfigNow`) are saved at once too, never held in the draft.

## View skeleton

Views outside the v2 hierarchy start with `ViewHead`, so all headers share the same order:

1. `crumb`: `<sidebar group> › <sidebar label>` (for example «Meld y Stream Deck › Atajos y Stream Deck»).
   Sidebar groups are not routes, so this crumb is plain text. Sub-routes link back to their parent view
   instead: «Comandos de chat › Comando», where «Comandos de chat» links to `#/comandos`.
2. `title` (`h1`): the sidebar label, or the object name in a sub-route (an editable `title-input` there).
3. `hint` (optional): one or two sentences on what the view does. Put «solo lo ves tú»-style notes here,
   never in the crumb.
4. `actions` (optional), on the right: status and switches that turn the whole view on/off first, then
   secondary buttons, and the primary button (if any) last.

Header exceptions are listed in the view grammar below (Headers).

## View grammar

The sections below say how each piece looks; this table says when to use each one. Pick by the rule, not
by what the neighbouring view did: the same data gets the same control in every view.

### Controls

| The value is… | Use |
| --- | --- |
| One of 2-4 fixed options (Degradado/Sólido/Cristal) | `Seg` |
| One of a dynamic or long list (voices, tracks, commands, monitors) | `select` |
| On/off | `Switch` |
| A numeric magnitude | `Range` |
| Several from a set | `Check` (only for multi-selection or a form sent with a button) |

### Cards and rows

| The object is… | Use |
| --- | --- |
| An item of a list, with its actions | `eg-post--row` |
| A dashboard module or a platform | `eg-module-card` |
| A pickable option with a preview | `eg-tile` |

### Structure

- Small configuration (two groups or fewer): stacked sections (`Sec`). Three or more groups that are each
  worth a stop of their own: `editor-tabs`.
- `Panel` is retired: migrate the remaining uses to `Sec`.
- Layout: `row2`/`row3` inside a section; `grid2` for two panels of equal weight. One layout system per
  view.
- The preview always goes in the right column (`WidgetLayout`).

### Headers

`ViewHead` in every view. Documented exceptions:

- `Directo`: its crumb shows the stream state and clock.
- Espectadores: the «Récord» pane of the viewers alerts is a pane of the alert editor, not a view; its
  `eg-module-card` acts as its header.
- `AcercaDe`: writes the `view-head` markup by hand; migrate it to `ViewHead` (or document why not).

## Widget pages

Every page of the «Widgets» sidebar group (Preguntas, Teleprompter, Tier list, Sorteo, Chat en pantalla,
Objetivos, Últimos y ticker, Créditos) uses one layout, `WidgetLayout`, below the header (and below the
`ItemTabs` when the page has them):

- Two columns: the left one is everything you configure or operate, the right one is the preview. Below
  1180 px they stack and the preview goes first.
- The left column always starts with `BrowserSource`: a section titled «Fuente de navegador en Meld» with
  the URL (`CopyUrl`), its size and a usage hint (default «En Meld: + › Browser…»; pass `hint` for
  widget-specific parameters such as `?nocount`). Never build this block by hand or give it another name.
  A page with two widgets lists both URLs in the same block with a `label` each (Últimos y ticker); a page
  with one source per object renders the block inside each object's tab (Objetivos).
- The right column holds only previews, each one a `Stage` (or the same `figure.eg-stage` markup when it
  needs its own toolbar, as in Teleprompter) with an eyebrow: «Vista previa» for example data or the object
  being edited, «En pantalla» for what the widget shows right now. Status or the data source goes in the
  caption `aside` («Datos de ejemplo», «Con los datos reales del directo»), not in a `p.hint` below.
- Every widget page has a preview. When there is no object to show (Tier list on «+ Nueva»), use the
  widget's `?demo` mode.

## Sections and hints

- A view is made of sections (`Sec`). `Panel` is retired (see the view grammar): it is styled the same
  (same surface, title in display caps, hairline under the header) until its remaining uses move to `Sec`.
- The section title is the `title` prop; counts or status go in `aside` as `span.hint`; an on/off switch
  for the whole section also goes in `aside`.
- A section's introduction is the first child: `p.hint.lead`. Hints about a single field go right after
  that field as `p.hint`.
- Use `.sub-h` headings only to name a group of content that has no section of its own (for example
  «Últimos» and «Ticker» inside one form).

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

> Since v2, collections the user creates are a `ListPanel` table that opens a `Slide` (see Hierarchy
> above): goals, scripts, tier lists and shortcuts moved there. `ItemTabs` remains for picking the active
> object during the stream (the teleprompter's «En directo» tab). The rules below still describe the
> pieces, but the hierarchy wins where they disagree.

Use **item tabs** (`ItemTabs`) when a view edits one object at a time from a small set the user creates:
one tab per object, the selected one is edited below, and the last tab is «+ Nuevo …» / «+ Nueva».

| Collection | View | «+ …» tab |
| --- | --- | --- |
| Goals | `Widgets.tsx` (Goals) | creates the object directly and selects it |
| Teleprompter scripts | `Teleprompter.tsx` | creates the object directly and selects it |
| Tier lists | `Interactivos.tsx` (TierList) | opens a creation form (title + items), then selects the new list |

- There is one tab look in the whole UI: the underlined `eg-tabs` of the alert editor. Item tabs, filters
  (Prompter timeline), mode toggles (Chat and Prompter «Escribir en») and value pickers (`Seg`) all use it;
  `eg-tabs--segmented` and `eg-tabs--sm` are not used. `Seg` keeps `role=radio` + `aria-checked` so it is
  announced as a setting, and adds `aria-selected` for the underline.
- Icon-only options (platform logos) dim the unpicked icons: a short underline under a 16 px logo is not
  enough to show the pick on its own.
- Long settings views split into section tabs with the same markup as the alert editor (`editor-tabs`,
  `role=tab` + `tabpanel`, every pane mounted and only `hidden`): the alert editor and Apariencia
  (Color, Tipografía, Iconos, Forma y efectos, Posición y movimiento, Sonido). The preview stays outside the
  tabs. Prefix pane ids per view (`ap-tp-*`) so they never collide with another view's ids.
- Cards never touch: stacked card blocks keep 16 px between them. Inside `.stack`/`.cols`/`.grid2` the
  container's `gap` gives it; cards that hang straight from `main` get it from one rule in `panel.css`
  (`main>:is(.panel,.sec,.cols,.grid2,.stack)+…`). Do not add per-pair margins; the browser test
  «ninguna vista deja tarjetas apiladas sin separación» walks every route and tab and fails below 12 px.
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

Use **list + modal** when the list itself is what the user works with day to day and the editor is
occasional: shortcuts (`Atajos.tsx`). The list (`eg-post eg-post--row`) shows each object with
«Probar», «Editar» and «Borrar»; «+ Nuevo …» is a primary button in the `ViewHead` actions; «Editar» and
«+ Nuevo» open the shared `Modal` (`lib/ui.tsx`). The modal asks for the data needed to create the object
and, once created, switches to editing it. `Modal` closes on Esc, its «Cerrar» button and the backdrop,
but `onClose` decides (it can refuse), and it gives the focus back to the button that opened it. Toasts sit
above modals (`z-index`), so errors inside a modal stay visible.

### Saving

Since v2 every editor saves explicitly (see Manual save above): shortcuts included, so a half-built chain of
steps never runs from the Stream Deck. Leaving a slide with a draft asks «Tienes cambios sin guardar. ¿Salir y
descartarlos?».

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
Render the list element only when it has items, so the empty state is never inside a `ul`/`ol`. `ListPanel`
already does this: its `empty` text is shown in an `EmptyState` under the table, and a «Crear el primero» link
there points to the «Nuevo» slide.

One approved exception (#4): in the Chat view the empty state lives **inside** `ol.chatlog`. The list is a
guided tour anchor (`data-tour="chat-log"`) and must always exist, and a child inside it stops the `:empty`
pseudo-element of `panel.css` from showing. Everywhere else the rule above holds.

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
3. If the anchor only exists in some states, give the step a `when` precondition (for example
   `meldConnected` for the scenes, `wideSidebar` for sidebar groups, which have no box below 860 px). The tour
   evaluates `when` once at start and drops the steps that fail, so «n de N» counts only steps that will be
   shown and they are skipped instantly.
4. Anchor a box that is always rendered when `when` holds. As a safety net, an anchor that still does not
   appear within 2 s is skipped and the counter is renumbered: the next step takes its number and the total
   drops by one (no gaps). A step that hits the safety net is a missing `when`.
5. Update `test/onboarding-browser.test.mjs` if the step changes the route order it checks.
