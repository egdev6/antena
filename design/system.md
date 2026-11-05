# antena design system

Extracted read-only from the project sources. Only values found in the sources are recorded.
`public/ds/tokens.css` and `public/ds/bundle.css` are synced from egdev-design-system `32fe9d7`
(`@egdev/tokens` 0.3.0) with `pnpm ds:sync`; that repository is the source of truth.
Sources: `public/ds/tokens.css`, `public/ds/bundle.css`, `public/fonts.css`, `app/src/styles/panel.css`,
`app/src/styles/prompter.css`, `app/src/styles/dock.css`, `public/widgets/widget.css`.

Dark-only UI (`color-scheme:dark` in panel.css, prompter.css, dock.css). No `[data-theme]` variants.

## Colors

### Primitives — `public/ds/tokens.css`
| Token | Value |
| --- | --- |
| `--color-primitive-black` | `#000000` |
| `--color-primitive-neutral-950` | `#0A0A0A` |
| `--color-primitive-neutral-900` | `#1A1A1A` |
| `--color-primitive-white` | `#FFFFFF` |
| `--color-primitive-neutral-200` | `#CCCCCC` |
| `--color-primitive-neutral-500` | `#888888` |
| `--color-primitive-neutral-600` | `#6B6B6B` |
| `--color-primitive-red-neon` | `#FF0036` |
| `--color-primitive-red-dark` | `#CC002B` |
| `--color-primitive-red-light` | `#FF335E` |
| `--color-primitive-red-200` | `#FF8FA6` |
| `--color-primitive-red-300` | `#FF6680` |
| `--color-primitive-red-950` | `#1F0006` |
| `--logo-red` | `#E91B35` |
| `--logo-red-shade` | `#800C1D` |
| `--color-primitive-graphite-950` | `#141518` |
| `--color-primitive-graphite-900` | `#1B1C20` |
| `--color-primitive-graphite-850` | `#232428` |
| `--color-primitive-graphite-800` | `#2A2B30` |
| `--color-primitive-graphite-750` | `#2D2E33` |
| `--color-primitive-graphite-500` | `#7A7B81` |
| `--color-primitive-graphite-400` | `#A1A2A8` |

Alpha: white `.07`/`.08`; red `rgba(255,0,54,x)` at `.07 .10 .12 .15 .18 .22 .30 .45 .65`; black `.25`/`.42`.

### Semantic — `public/ds/tokens.css`
| Token | Value | Usage |
| --- | --- | --- |
| `--color-bg-canvas` | graphite-950 `#141518` | App background |
| `--color-bg-scrim` | black | Modal scrim |
| `--color-bg-glass` | white .08 | Glass surfaces |
| `--color-bg-deep` | `#800C1D` | Deep brand backdrop |
| `--color-surface-0…3` | `#141518` `#1B1C20` `#232428` `#2D2E33` | Elevation steps |
| `--color-surface-overlay` | `rgba(35,36,40,.84)` | Toasts, floating bars |
| `--color-fg-default` | `#FFFFFF` | Primary text |
| `--color-fg-secondary` | `#CCCCCC` | Secondary text |
| `--color-fg-muted` | `#A1A2A8` | Muted text, labels |
| `--color-fg-brand-default` / `-hover` / `-raised` | `#FF0036` / `#FF335E` / `#FF0036` | Brand text ("Todo neón": raised is neon too) |
| `--color-fg-on-status`, `--color-fg-on-flood` | black | Text on status/flood fills |
| `--color-border-default` | `#2A2B30` | Card/panel borders |
| `--color-border-subtle` | white .07 | Dividers |
| `--color-border-brand` / `-strong` | red .45 / `#CC002B` | Active/brand borders |
| `--color-border-control` | `#7A7B81` | Form control borders |
| `--color-border-hairline` / `-strong` | white .08 / .14 | Hairlines |
| `--color-action-primary-bg-default` / `-hover` | red .12 / .18 | Tinted primary button |
| `--color-action-primary-solid-bg` / `-hover` | `#FF0036` / `#FF335E` | Solid primary button |
| `--color-action-primary-solid-fg` | black | Solid primary label |
| `--color-focus-ring` / `-inverse` | `#FF0036` / white | Focus |
| `--color-status-success` | `#2DE2C4` | OK states |
| `--color-status-warning` | `#FFB224` | Warnings |
| `--color-status-info` | `#8AB4FF` | Info |
| `--color-status-danger` | `#FF6680` | Errors |
| `--color-status-danger-bg` | `color-mix(danger 12%, transparent)` | Invalid-control well |
| `--color-ambient-*` | `#060103` `#b40a1e` `#950e20` `#e6001a` `#ff2244` `#4d000d` | Ambient background art |

Red roles: brand, focus and CTA use neon `#FF0036`; hover `#FF335E`; pressed/control borders `#CC002B`; brand text on tinted backgrounds `#FF8FA6`; errors `#FF6680`; `#E91B35`/`#800C1D` are logo-only. Panel, prompter and dock use no other reds (`test/ds-reds.test.mjs`).

Legacy aliases (`--bg --s0…3 --line --line2 --ctrl --text --grey --muted --red --red-2 --pink --ok --warn`) map onto these tokens in panel.css, dock.css and prompter.css. Widgets (`public/widgets/widget.css`) hardcode `--red:#FF0036 --red-2:#FF335E --red-dark:#800C1D --pink:#FF8FA6 --white:#fff --grey:#ccc --muted:#888`.

## Typography — `public/ds/tokens.css`, `public/fonts.css`
| Token | Value |
| --- | --- |
| `--font-display` | `"Barlow Condensed","Arial Narrow",sans-serif` |
| `--font-sans` | `"Barlow",system-ui,sans-serif` |
| `--font-mono` | `"JetBrains Mono",ui-monospace,monospace` |
| `--f-cond` / `--f-body` / `--f-mono` | EG-prefixed local faces with system fallbacks (`fonts.css`, layer `egdev`) |

Type recipes `--text-*` (e.g. `--text-display-hero:44.8px/1.1 800`, `--text-display-show:76.8px/.9 800`, `--text-display-pro:51.2px/.95 800`). Sizes in use in the app: body `500 14px/1.45` (panel, dock); h1 `800 26px/1` and h2 `800 15px/1` display, uppercase (panel.css); code `500 12px` mono; prompter `--fs:22px`, body `calc(var(--fs)*.82)/1.3` (prompter.css). Bundle display scale: `--section clamp(40px,5.6vw,64px)`, `--hero clamp(60px,9vw,140px)`, `--show clamp(56px,8.2vw,132px)`, `--display clamp(64px,9.6vw,164px)`.

## Spacing — `public/ds/tokens.css`
`--space-0:0 · 1:3.2px · 2:6.4px · 3:9.6px · 4:12.8px · 5:16px · 6:19.2px · 7:22.4px · 8:25.6px · 10:32px · 12:38.4px · 14:44.8px · 16:51.2px · 20:64px · 24:76.8px` (×0.8 scale).
Layout: `--content-max:1024px`, `--gutter:clamp(12.8px,3.2vw,32px)`, `--nav-height:54.4px`, `--bp-sm:520px`, `--bp-md:960px`, `--bp-lg:1260px`.

## Radius — `public/ds/tokens.css`
`--radius-none:0 · sm:3.2px · md:9.6px · lg:12.8px · xl:17.6px · 2xl:19.2px · full:9999px`.

## Shadows — `public/ds/tokens.css`
- Brand glow: `--shadow-glow-base:0 4px 20px rgba(255,0,54,.15)`, `--shadow-glow-active:0 8px 30px rgba(255,0,54,.30)`, `--shadow-glow-intense`, `--shadow-cta-hover`, `--shadow-glow-hot`, `--shadow-hot`.
- Structural: `--shadow-focus:0 0 0 2px #141518, 0 0 0 4px #FF0036`, `--shadow-card`, `--shadow-edge` / `-strong` (`inset 0 1px 0 rgba(255,255,255,.07/.13)`), `--shadow-well`, `--shadow-elev-1/2/3`, `--shadow-ring-brand:0 0 0 3px rgba(255,0,54,.22)`, `--shadow-btn-primary` / `-hover`, `--shadow-btn-pressed`.
- Panel recipe (panel.css): `--shadow-inset-highlight:inset 0 1px 0 rgba(255,255,255,.35)`.

## Components — `public/ds/bundle.css` (+ panel recipes in `app/src/styles/panel.css`)
- **eg-btn** `--primary --secondary --ghost --dark --sm --icon`, `__icon`. Panel compacts to `min-height:34px`.
- **eg-tabs** underlined tabs, `--segmented --sm --lg`, `__item`, `__count`, `__item--danger`.
- **eg-menu** `--nav`, `__item __label __count __group`, `[aria-current]` (sidebar).
- **eg-field** `__label __control __hint __counter`, `--invalid --sm`; **eg-check**.
- **eg-chip**, **eg-tag** `--solid`, **eg-status** `--success --warning --info --danger --neutral`, **eg-kbd**, **eg-live-dot**, **eg-progress**.
- **eg-post**, **eg-timeline** (`__item--hot`, `--chat`), **eg-tile** (`--live`), **eg-stage**, **eg-stat** (`--flash --glass --sm`), **eg-module-card**, **eg-status-dot**.
- Panel recipes: `.panel`, `.sec` / `.sec-h` / `.sec-foot`, `.switch`, `.pill` / `.state(.ok .warn .err .live)`, `.tagm`, `.qcur`, `.scene`, `.tile-stat`, `.modal` / `.modal-backdrop`.
- Widgets: `.eg-card` (neon glow card, `.soft`) in `public/widgets/widget.css`.

Layers: prompter loads bundle into `@layer ds` and its own CSS into `@layer egdev`; user CSS (unlayered) wins. `prefers-reduced-motion` and `prefers-reduced-transparency` are honored in panel, prompter, dock and bundle.
