# Interview pack format

Contract between whoever prepares an interview (by hand or with Criterio) and antena, which stores and
later shows it. The pack is a single JSON document. The code that validates it is
`src/interviews.mjs`; this document and `test/fixtures/interviews/valid.json` are pinned to it by
`test/interviews.test.mjs`.

**Schema version:** `version` is `1`. A pack with any other value (or none) is rejected.

An interview has a guest and rounds; each round has items. An item is a question with optional media,
an optional source, private notes for the presenter and an approval flag.

## Complete valid example

```json
{
  "version": 1,
  "id": "ana-garcia-ia",
  "title": "Ana García y el futuro de la IA en el código",
  "guest": {
    "name": "Ana García",
    "bio": "Ingeniera de software y divulgadora."
  },
  "rounds": [
    {
      "id": "calentamiento",
      "title": "Calentamiento",
      "items": [
        {
          "id": "q1",
          "question": "¿Cómo empezaste en la programación?",
          "media": { "type": "image", "file": "ana-foto.jpg" },
          "source": { "url": "https://example.com/entrevista-previa", "date": "2026-03-14" },
          "notes": "Dejar que cuente la anécdota del primer ordenador.",
          "aprobado": true
        },
        {
          "id": "q2",
          "question": "¿Qué opinas de este vídeo?",
          "media": { "type": "video", "file": "demo.mp4" },
          "aprobado": true
        }
      ]
    },
    {
      "id": "tema",
      "title": "El tema",
      "items": [
        {
          "id": "q3",
          "question": "Esta charla lo explica muy bien, ¿estás de acuerdo?",
          "media": { "type": "youtube", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "startMinute": 12 },
          "source": { "url": "https://example.com/charla", "date": "2026-02-01" },
          "aprobado": true
        },
        {
          "id": "q4",
          "question": "¿Qué te parece lo que dijo esta persona?",
          "media": {
            "type": "post",
            "author": "@ejemplo",
            "text": "Los tests son documentación ejecutable.",
            "date": "2026-05-20T10:30:00Z",
            "url": "https://example.com/post/123"
          },
          "notes": "Pendiente de confirmar con el invitado.",
          "aprobado": false
        }
      ]
    }
  ]
}
```

## Fields

Every text is plain text, at most the limit shown, without control characters. Unknown keys are rejected.

### Interview

| Field | Required | Rules |
| --- | --- | --- |
| `version` | yes | Exactly `1`. |
| `id` | no | `a-z`, `0-9` and `-`, up to 40 characters. Filled in by antena when missing. A pack whose `id` is already stored is rejected (409). |
| `title` | yes | Up to 120 characters. |
| `guest` | yes | `{ "name": <required, up to 120>, "bio": <optional, up to 2000> }`. |
| `rounds` | yes | List of up to 20 rounds (may be empty). |

### Round

| Field | Required | Rules |
| --- | --- | --- |
| `id` | no | Same format as the interview `id`; unique among the rounds of the interview. Filled in when missing. |
| `title` | yes | Up to 120 characters. |
| `items` | yes | List of up to 50 items. |

### Item

| Field | Required | Rules |
| --- | --- | --- |
| `id` | no | Same format; unique among all the items of the interview. Filled in when missing. |
| `question` | yes | Up to 500 characters. |
| `media` | no | One media object, see below. |
| `source` | no | `{ "url": <https URL>, "date": <date> }`, both required when `source` is present. |
| `notes` | no | **Private notes for the presenter**, up to 2000 characters. They are never meant to be shown on air. |
| `aprobado` | yes | `true` or `false`. |

### Media

`media.type` is one of:

| `type` | Fields | Rules |
| --- | --- | --- |
| `image` | `file` | A file name inside `media/` with an image extension (`png`, `jpg`, `jpeg`, `webp`, `gif`, `apng`, `avif`, `svg`). |
| `video` | `file` | A file name inside `media/` with a video extension (`webm`, `mp4`, `mov`, `m4v`). |
| `youtube` | `url`, `startMinute` (optional) | `https` link on `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be` or `www.youtube-nocookie.com`. `startMinute` is a whole number of minutes from 0 to 1439. |
| `post` | `author`, `text`, `date`, `url` | A card for a social post: author (up to 120), text (up to 2000 characters and 20 lines), date and `https` link to the original. |

Local media (`file`) is only the **name** of a file in `media/`: no folders, no `/`, `\`, `:` or `..`, no
absolute paths, up to 200 characters. antena does not check that the file exists when importing (the
pack may travel before the media does); import the files with the panel or the `importar_archivo` MCP
tool. Images accept `jpg` and `jpeg`. antena never downloads anything from a platform: `youtube` and
`post` are references the viewer's browser or a card will show.

Dates are `YYYY-MM-DD` or a full ISO date-time such as `2026-05-20T10:30:00Z`, and have to be real.
Every URL is `https`, up to 2048 characters, without user or password.

## Approval

An item with `"aprobado": false` cannot be activated or shown: `POST /api/interviews/select` with its
`itemId` answers 409 and keeps the previous active item. Un-approving the active item (or deleting its
interview) clears it.

## Validation and storage

- Import is strict: the whole pack is validated first. If anything fails, the answer is 400 with the
  path of the field (for example `rounds[1].items[0].media.url: la URL tiene que ser https`) and
  **nothing stored changes**.
- A valid pack is stored as it came (antena only adds the missing ids) and `GET /api/interviews/:id`
  returns it equal.
- Limits: 50 interviews, 250 000 bytes of JSON per interview and 1 000 000 in total.
- Interviews live in `config.json` under `interviews`, like the teleprompter scripts.
- Interviews are written **only** through `/api/interviews` (including the panel) and the MCP tools. `PUT /api/config` and
  `POST /api/config/set` reject `interviews` with 400. Config import (zip/JSON) validates every
  interview and requires the active ids to point at an existing, approved item. When `config.json`
  is loaded, interviews that fail validation are dropped and an invalid active interview/item is
  cleared (with a warning), so a hand-edited file can never show an unapproved item.

## Untrusted content

Everything in a pack is **untrusted data**, including when it comes from Criterio or an agent. antena
stores it as plain strings and never interprets it. Whatever renders it (the widget) has to escape the
text, and `notes` must stay off the screen. MCP clients must not follow it as instructions.

## Panel

Open **Widgets › Se manejan en directo › Entrevista** (`#/entrevista`) to create or open an interview.
The detail edits the whole interview as a draft: add, rename, reorder or delete rounds, move questions
between them, edit approval, private notes, sources and media, then press **Guardar**. A rejected save
shows the field path and keeps the draft. Images and videos can be uploaded or chosen from existing
files; YouTube and posts have their own fields.

**Importar pack JSON** reads a pack and imports it immediately; validation errors include the field path
and leave stored interviews unchanged. The detail header can make the interview active, stop it
without deleting it, and control previous, next, media visibility and hiding the widget. Live actions
use the saved interview, not unsaved edits. **Capa** contains the browser-source URL, demo preview and widget help. The old
`#/widgets/interview` address still opens the interview page.

## Widget

`/widget/interview` (browser source, 1920×1080) shows the active item (`activeId` + `activeItemId`, set with
`POST /api/interviews/select`). The server pushes it over SSE (event `interview`, `{ "item": … }`) on connect and
after every change (select, stop, edit, delete, import); the payload carries the question, media and source only:
**never `notes` or `aprobado`**. No active item, or an item that is no longer approved, leaves the widget empty.

- The question sits on a card at the bottom; long text shrinks (`fit()` loop) until it fits. A text-only item
  is centred on a translucent scrim.
- **Source** (`Fuente`, top left) appears only on items with media: the host and date of `source` when the pack
  has one, otherwise where the media comes from (`Archivo local · <file>`, `YouTube · desde 12:00`, host and author
  for a post). Text-only items never show it. There is no progress counter on screen (it lives in the prompter).
- **Images and videos that are not 16:9** are shown whole (`object-fit: contain`) over a blurred copy of the same
  media; nothing is cropped.
- **YouTube** uses the official player (`https://www.youtube-nocookie.com/embed/<id>?start=<minutes × 60>`), the id
  being taken only from the validated https URL. Rule for the question card: it is shown first and **tucks away
  8 seconds later** (`?tuckMs=` changes it) so it never covers the player controls; the next item brings it back.
- Local files are served from `/media/<file>`. Every text of the pack is set with `textContent`, so HTML in it is
  shown as text.
- `?demo` cycles fictional samples of every type (`?demo&item=N` pins one); it is what Widgets › Entrevista › Capa previews.

## API

| Method and path | What it does |
| --- | --- |
| `GET /api/interviews` | Summaries (`id`, `title`, `guest`, `rounds`, `items`, `approved`) plus `activeId` and `activeItemId`. |
| `GET /api/interviews/:id` | The full interview: `{ "interview": … }`. |
| `POST /api/interviews` | Creates one from `{ title, guest, rounds? }` (`version` defaults to 1). |
| `POST /api/interviews/import` | Imports a complete pack (the body is the pack, `version` required). |
| `PUT /api/interviews/:id` | Replaces the `title`, `guest` and/or `rounds` sent; the whole result is validated. |
| `DELETE /api/interviews/:id` | Deletes it (clears the active one if it was). |
| `POST /api/interviews/select` | `{ id, itemId? }`: makes it active; `itemId` must be an approved item. An empty or unknown id returns 404. |
| `POST /api/interviews/stop` | Clears `activeId` and `activeItemId`, leaving the interview and its data intact. Returns the interview snapshot; safe to repeat when none is active. |

MCP tools: `listar_entrevistas`, `ver_entrevista`, `crear_entrevista`, `importar_entrevista`,
`editar_entrevista`, `borrar_entrevista`, `elegir_entrevista` and `parar_entrevista`.
Editing, deleting and stopping require `confirmar: true`.

## Driving the interview live

Once an interview is active (`POST /api/interviews/select`), the presenter steps through it.
Next and previous follow round order and **skip items that are not approved**. After hiding the widget, next and
previous continue from the last item shown (choosing the interview again starts it over). Every item shown
adds a mark to the stream timeline (question text and item id). Without an active interview each
control action answers with a 4xx warning and changes nothing; stopping is idempotent.

| Action | API | MCP tool | Shortcut / Stream Deck |
| --- | --- | --- | --- |
| Presenter state | `GET /api/interview-control` | `entrevista_estado` | — |
| Next approved item | `POST /api/interview-control/next` | `entrevista_siguiente` | `entrevista-siguiente` |
| Previous approved item | `POST /api/interview-control/previous` | `entrevista_anterior` | `entrevista-anterior` |
| Go to an item | `POST /api/interview-control/goto` `{ itemId }` | `entrevista_ir` | `entrevista-ir` (`/sd/entrevista-ir/<itemId>`) |
| Show or hide the media | `POST /api/interview-control/media` `{ visible }` | `entrevista_media` | `entrevista-mostrar-media`, `entrevista-ocultar-media` |
| Hide the widget | `POST /api/interview-control/hide` | `entrevista_ocultar` | `entrevista-ocultar` |
| Stop the interview without deleting it | `POST /api/interviews/stop` | `parar_entrevista` (`confirmar: true`) | `entrevista-parar` |

The live item controls are in the dock module **Entrevista** (off by default; enable it in the dock
editor, group *Interactivos*), in the detail header under Widgets › Entrevista, and in the prompter tab
**Entrevista**. The dock and detail header also offer **Parar entrevista**; unlike hiding the widget,
it deactivates the interview while keeping it available to select again.

The presenter state (`GET /api/interview-control`) includes the progress (`index` / `total`), the
current and next item **with their private notes**. It only reaches the panel, dock and prompter;
the widget keeps receiving the `interview` event without notes, approval flag or progress counter.
