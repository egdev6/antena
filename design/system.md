# antena design system

Extracted read-only from the project sources. Only values found in the sources are recorded.
`public/ds/tokens.css` and `public/ds/bundle.css` are synced from egdev-design-system `32fe9d7` with `pnpm ds:sync`.
Sources: `public/ds/tokens.css`, `public/ds/bundle.css`, `public/fonts.css`, `app/src/styles/panel.css`,
`app/src/styles/prompter.css`, `app/src/styles/dock.css`, `public/widgets/widget.css`.

Panel, dock and prompter declare `color-scheme:dark`; the prompter uses a black canvas (`app/src/styles/panel.css`, `app/src/styles/dock.css`, `app/src/styles/prompter.css`).

## Colors

### Primitives — `public/ds/tokens.css`

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--color-primitive-black` | `#000000` | Scrim, on-solid text | `public/ds/tokens.css` |
| `--color-primitive-neutral-950`, `--color-primitive-neutral-900` | `#0A0A0A`, `#1A1A1A` | Dark surfaces | `public/ds/tokens.css` |
| `--color-primitive-white`, `--color-primitive-neutral-200`, `--color-primitive-neutral-500`, `--color-primitive-neutral-600` | `#FFFFFF`, `#CCCCCC`, `#888888`, `#6B6B6B` | Foreground and neutral states | `public/ds/tokens.css` |
| `--color-primitive-red-neon`, `--color-primitive-red-dark`, `--color-primitive-red-light` | `#FF0036`, `#CC002B`, `#FF335E` | Brand, strong border, hover | `public/ds/tokens.css` |
| `--color-primitive-red-200`, `--color-primitive-red-300`, `--color-primitive-red-950` | `#FF8FA6`, `#FF6680`, `#1F0006` | Light red, danger, dark red | `public/ds/tokens.css` |
| `--color-primitive-graphite-950`, `--color-primitive-graphite-900`, `--color-primitive-graphite-850`, `--color-primitive-graphite-800`, `--color-primitive-graphite-750`, `--color-primitive-graphite-500`, `--color-primitive-graphite-400` | `#141518`, `#1B1C20`, `#232428`, `#2A2B30`, `#2D2E33`, `#7A7B81`, `#A1A2A8` | Surface, border and muted ramp | `public/ds/tokens.css` |
| `--logo-red`, `--logo-red-shade` | `#E91B35`, `#800C1D` | Logo and deep brand backdrop | `public/ds/tokens.css` |
| `--color-alpha-white-07`, `--color-alpha-white-08` | `rgba(255,255,255,.07)`, `rgba(255,255,255,.08)` | Hairlines and glass | `public/ds/tokens.css` |
| `--color-alpha-red-07`, `--color-alpha-red-10`, `--color-alpha-red-12`, `--color-alpha-red-15`, `--color-alpha-red-18`, `--color-alpha-red-22`, `--color-alpha-red-30`, `--color-alpha-red-45`, `--color-alpha-red-65` | `rgba(255,0,54,x)`, where `x` is `.07`, `.10`, `.12`, `.15`, `.18`, `.22`, `.30`, `.45`, `.65` respectively | Tints, borders and glow | `public/ds/tokens.css` |
| `--color-alpha-black-25`, `--color-alpha-black-42` | `rgba(0,0,0,.25)`, `rgba(0,0,0,.42)` | Dark overlays | `public/ds/tokens.css` |

### Semantic — `public/ds/tokens.css`

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--color-bg-canvas`, `--color-bg-scrim`, `--color-bg-surface`, `--color-bg-glass` | `var(--color-primitive-graphite-950)`, `var(--color-primitive-black)`, `var(--color-surface-1)`, `var(--color-alpha-white-08)` | Canvas, scrim, surface, glass | `public/ds/tokens.css` |
| `--color-bg-brand-subtle`, `--color-bg-brand-hover`, `--color-bg-flood`, `--color-bg-deep` | `var(--color-alpha-red-10)`, `var(--color-alpha-red-18)`, `var(--color-primitive-red-neon)`, `var(--logo-red-shade)` | Brand fills | `public/ds/tokens.css` |
| `--color-surface-0`, `--color-surface-1`, `--color-surface-2`, `--color-surface-3`, `--color-surface-overlay` | `#141518`, `#1B1C20`, `#232428`, `#2D2E33`, `rgba(35,36,40,.84)` | Elevation and floating surfaces | `public/ds/tokens.css` |
| `--color-fg-default`, `--color-fg-secondary`, `--color-fg-muted` | `#FFFFFF`, `#CCCCCC`, `#A1A2A8` | Primary, secondary and muted text | `public/ds/tokens.css` |
| `--color-fg-brand-default`, `--color-fg-brand-hover`, `--color-fg-brand-raised` | `#FF0036`, `#FF335E`, `#FF0036` | Brand text and hover | `public/ds/tokens.css` |
| `--color-fg-on-status`, `--color-fg-on-flood` | `#000000`, `#000000` | Text on status and flood fills | `public/ds/tokens.css` |
| `--color-border-default`, `--color-border-subtle`, `--color-border-brand`, `--color-border-brand-strong`, `--color-border-control` | `#2A2B30`, `rgba(255,255,255,.07)`, `rgba(255,0,54,.45)`, `#CC002B`, `#7A7B81` | Surface, divider, brand and control borders | `public/ds/tokens.css` |
| `--color-border-hairline`, `--color-border-hairline-strong` | `rgba(255,255,255,.08)`, `rgba(255,255,255,.14)` | Hairlines | `public/ds/tokens.css` |
| `--color-action-primary-bg-default`, `--color-action-primary-bg-hover`, `--color-action-primary-fg` | `rgba(255,0,54,.12)`, `rgba(255,0,54,.18)`, `#FFFFFF` | Tinted action | `public/ds/tokens.css` |
| `--color-action-primary-solid-bg`, `--color-action-primary-solid-bg-hover`, `--color-action-primary-solid-fg` | `#FF0036`, `#FF335E`, `#000000` | Solid action | `public/ds/tokens.css` |
| `--color-focus-ring`, `--color-focus-ring-inverse` | `#FF0036`, `#FFFFFF` | Focus | `public/ds/tokens.css` |
| `--color-status-success`, `--color-status-warning`, `--color-status-info`, `--color-status-danger`, `--color-status-danger-bg` | `#2DE2C4`, `#FFB224`, `#8AB4FF`, `#FF6680`, `color-mix(in srgb, var(--color-status-danger) 12%, transparent)` | Status and invalid-control well | `public/ds/tokens.css` |
| `--color-ambient-bg`, `--color-ambient-glow`, `--color-ambient-line`, `--color-ambient-line-glow`, `--color-ambient-square`, `--color-ambient-square-glow` | `#060103`, `#b40a1e`, `#950e20`, `#4d000d`, `#e6001a`, `#ff2244` | Ambient background art | `public/ds/tokens.css` |
| Panel aliases `--bg`, `--s0`…`--s3`, `--line`, `--line2`, `--ctrl`, `--text`, `--grey`, `--muted`, `--red`, `--red-2`, `--pink`, `--ok`, `--warn` | References to the semantic and primitive tokens above; notably `--pink:var(--color-fg-brand-raised)` | Panel recipes | `app/src/styles/panel.css` |
| Dock aliases `--bg`, `--s0`…`--s3`, `--line`, `--line2`, `--text`, `--grey`, `--muted`, `--red`, `--pink`, `--ok`, `--warn` | References to the semantic and primitive tokens above | Dock recipes | `app/src/styles/dock.css` |
| Prompter aliases `--text`, `--grey`, `--muted`, `--red`, `--pink` | References to the semantic and primitive tokens above | Prompter recipes | `app/src/styles/prompter.css` |
| Widget aliases `--red`, `--red-2`, `--red-dark`, `--pink`, `--white`, `--grey`, `--muted` | `#FF0036`, `#FF335E`, `#800C1D`, `#FF8FA6`, `#fff`, `#ccc`, `#888` | Widget colors; `--pink` differs from the panel alias | `public/widgets/widget.css` |
| `--bg-scrim-backdrop` | `color-mix(in srgb,var(--color-bg-scrim) 60%,transparent)` | Panel modal backdrop | `app/src/styles/panel.css` |

The neon brand text token is `#FF0036`, including `--color-fg-brand-raised`; `#FF8FA6` is used by the bundle's tag and widget pink, not the panel `--pink` alias (`public/ds/tokens.css`, `public/ds/bundle.css`, `public/widgets/widget.css`, `app/src/styles/panel.css`). Check contrast against the actual surface before using a foreground color.

### Gradients — `public/ds/tokens.css`

| Token | Value | Source |
| --- | --- | --- |
| `--gradient-section-show` | `radial-gradient(45% 55% at 22% 50%, var(--color-alpha-red-12), transparent 70%)` | `public/ds/tokens.css` |
| `--gradient-vignette` | `radial-gradient(ellipse 120% 90% at 50% 45%, transparent 35%, rgba(0,0,0,.55) 75%, rgba(0,0,0,.92) 100%)` | `public/ds/tokens.css` |
| `--gradient-sheen` | `linear-gradient(180deg, rgba(255,255,255,.045) 0%, rgba(255,255,255,0) 42%)` | `public/ds/tokens.css` |
| `--gradient-glass-card` | `linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.015) 45%)` | `public/ds/tokens.css` |
| `--gradient-btn-primary` | `linear-gradient(180deg, #FF2D57 0%, #FF0036 52%, #EE0031 100%)` | `public/ds/tokens.css` |
| `--gradient-btn-primary-hover` | `linear-gradient(180deg, #FF4A6E 0%, #FF1A49 52%, #F00033 100%)` | `public/ds/tokens.css` |
| `--gradient-btn-secondary` | `linear-gradient(180deg, rgba(255,0,54,.20) 0%, rgba(255,0,54,.08) 100%)` | `public/ds/tokens.css` |
| `--gradient-btn-secondary-hover` | `linear-gradient(180deg, rgba(255,0,54,.30) 0%, rgba(255,0,54,.13) 100%)` | `public/ds/tokens.css` |
| `--gradient-chip-active` | `linear-gradient(180deg, rgba(255,0,54,.24), rgba(255,0,54,.09))` | `public/ds/tokens.css` |
| `--gradient-post-new` | `linear-gradient(180deg, rgba(255,0,54,.11), rgba(255,0,54,.03) 60%)` | `public/ds/tokens.css` |
| `--gradient-progress` | `linear-gradient(180deg, #FF4A6E, #FF0036 60%, #D9002D)` | `public/ds/tokens.css` |
| `--gradient-hot` | `radial-gradient(120% 80% at 85% -10%, rgba(255,0,54,.26), transparent 55%), linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,0) 40%), #22121A` | `public/ds/tokens.css` |

## Typography — `public/ds/tokens.css`, `public/fonts.css`

| Token or recipe | Value | Source |
| --- | --- | --- |
| `--font-display`, `--font-sans`, `--font-mono` | `"Barlow Condensed","Arial Narrow",sans-serif`; `"Barlow",system-ui,sans-serif`; `"JetBrains Mono",ui-monospace,monospace` | `public/ds/tokens.css` |
| App `--font-display`, `--font-sans`, `--font-mono` | `'EG Barlow Condensed','Barlow Condensed','Arial Narrow',sans-serif`; `'EG Barlow','Barlow',system-ui,sans-serif`; `'EG JetBrains Mono','JetBrains Mono',ui-monospace,monospace` | `app/src/styles/panel.css`, `app/src/styles/dock.css`, `app/src/styles/prompter.css` |
| `--f-cond`, `--f-body`, `--f-mono` | `'EG Barlow Condensed','Barlow Condensed','Arial Narrow','DejaVu Sans Condensed',sans-serif`; `'EG Barlow','Barlow','Segoe UI',system-ui,sans-serif`; `'EG JetBrains Mono','JetBrains Mono',Consolas,monospace` | `public/fonts.css` |
| Panel `--f-cond`, `--f-body`, `--f-mono` | `var(--font-display)`, `var(--font-sans)`, `var(--font-mono)` | `app/src/styles/panel.css` |
| Local face weights | EG Barlow Condensed `700`, `800`; EG Barlow `500`, `600`; EG JetBrains Mono `500` | `public/fonts.css` |
| `--text-display-hero`, `--text-display-show`, `--text-display-pro` | `44.8px/1.1 800`, `76.8px/.9 800`, `51.2px/.95 800` | `public/ds/tokens.css` |
| `--text-display-stat`, `--text-display-stat-sm` | `28.8px/1 800`, `22.4px/1 800` | `public/ds/tokens.css` |
| `--text-heading-section`, `--text-heading-small` | `32px/1.2 800`, `19.2px/1.2 700` | `public/ds/tokens.css` |
| `--text-body-large`, `--text-body-default`, `--text-body-muted` | `16px/1.6 500`, `12.8px/1.6 500`, `16px/1.6 400` | `public/ds/tokens.css` |
| `--text-label-default`, `--text-label-eyebrow`, `--text-meta`, `--text-cta-label`, `--text-code` | `11.2px/1.2 600`, `11.2px/1.2 700`, `11.2px/1.3 600`, `12.8px/1.2 700`, `11.2px/1.6 400` | `public/ds/tokens.css` |
| `--text-title-section`, `--text-title-hero`, `--text-title-show`, `--text-title-display` | `clamp(32px,4.48vw,51.2px)/.9 800`, `clamp(48px,7.2vw,112px)/.86 800`, `clamp(44.8px,6.56vw,105.6px)/.86 800`, `clamp(51.2px,7.68vw,131.2px)/.82 800` | `public/ds/tokens.css` |
| `--text-countdown-md`, `--text-countdown-sm` | `clamp(41.6px,4.8vw,76.8px)/.85 800`, `clamp(28.8px,3.2vw,44.8px)/.85 800` | `public/ds/tokens.css` |
| `--text-quote-pull`, `--text-quote-display` | `clamp(15.2px,1.36vw,18.4px)/1.4 500`, `clamp(38.4px,4.96vw,80px)/.86 800` | `public/ds/tokens.css` |
| Tracking | `--text-label-eyebrow--letter-spacing:.12em`; `--text-meta--letter-spacing:.08em`; the other recipes above have `0` | `public/ds/tokens.css` |
| Panel | Body `500 14px/1.45`; h1 `800 26px/1`; h2 `800 15px/1`; code `500 12px` | `app/src/styles/panel.css` |
| Dock | Body `500 14px/1.35` | `app/src/styles/dock.css` |
| Prompter | `--fs:22px`; body `500 calc(var(--fs)*.82)/1.3` | `app/src/styles/prompter.css` |
| Bundle title scale | Section `clamp(40px,5.6vw,64px)`; hero `clamp(60px,9vw,140px)`; show `clamp(56px,8.2vw,132px)`; display `clamp(64px,9.6vw,164px)` | `public/ds/bundle.css` |

## Spacing — `public/ds/tokens.css`

| Tokens | Values | Source |
| --- | --- | --- |
| `--space-0`, `--space-1`, `--space-2`, `--space-3`, `--space-4`, `--space-5`, `--space-6`, `--space-7`, `--space-8` | `0px`, `3.2px`, `6.4px`, `9.6px`, `12.8px`, `16px`, `19.2px`, `22.4px`, `25.6px` | `public/ds/tokens.css` |
| `--space-10`, `--space-12`, `--space-14`, `--space-16`, `--space-20`, `--space-24` | `32px`, `38.4px`, `44.8px`, `51.2px`, `64px`, `76.8px` | `public/ds/tokens.css` |
| `--spacing-countdown-column`, `--spacing-countdown-unit` | `clamp(11.2px,1.76vw,25.6px)`, `1.9ch` | `public/ds/tokens.css` |
| `--spacing`, `--spacing-0`…`--spacing-8`, `--spacing-10`, `--spacing-12`, `--spacing-14`, `--spacing-16`, `--spacing-20`, `--spacing-24` | Aliases to `--space-1` and corresponding `--space-*` | `public/ds/tokens.css` |
| `--content-max`, `--gutter`, `--nav-height`, `--bp-sm`, `--bp-md`, `--bp-lg` | `1024px`, `clamp(12.8px,3.2vw,32px)`, `54.4px`, `520px`, `960px`, `1260px` | `public/ds/tokens.css` |

## Radius — `public/ds/tokens.css`

| Tokens | Values | Source |
| --- | --- | --- |
| `--radius-none`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-2xl`, `--radius-full` | `0px`, `3.2px`, `9.6px`, `12.8px`, `17.6px`, `19.2px`, `9999px` | `public/ds/tokens.css` |
| Widget card | `calc(22px * var(--round,1))` | `public/widgets/widget.css` |

## Shadows — `public/ds/tokens.css`

| Token | Value | Source |
| --- | --- | --- |
| `--shadow-glow-base` | `0 4px 20px 0 rgba(255,0,54,.15)` | `public/ds/tokens.css` |
| `--shadow-glow-active` | `0 8px 30px 0 rgba(255,0,54,.30)` | `public/ds/tokens.css` |
| `--shadow-glow-intense` | `0 0 22px 4px rgba(255,0,54,.65), 0 0 55px 8px rgba(255,0,54,.28)` | `public/ds/tokens.css` |
| `--shadow-cta-hover` | `0 0 16px 4px rgba(255,0,54,.35), 0 0 45px 10px rgba(255,0,54,.15), inset 0 0 16px 0 rgba(255,0,54,.08)` | `public/ds/tokens.css` |
| `--shadow-focus` | `0 0 0 2px #141518, 0 0 0 4px #FF0036` | `public/ds/tokens.css` |
| `--shadow-card` | `0 0 0 1px rgba(255,0,54,.12), 0 8px 40px 0 rgba(255,0,54,.12), inset 0 0 16px 0 rgba(255,0,54,.08)` | `public/ds/tokens.css` |
| `--shadow-glow-hot` | `0 0 4px 1px rgba(255,255,255,.85), 0 0 18px 4px rgba(255,0,54,.75), 0 0 60px 12px rgba(255,0,54,.35)` | `public/ds/tokens.css` |
| `--shadow-edge`, `--shadow-edge-strong` | `inset 0 1px 0 rgba(255,255,255,.07)`, `inset 0 1px 0 rgba(255,255,255,.13)` | `public/ds/tokens.css` |
| `--shadow-elev-1` | `0 1px 2px rgba(0,0,0,.7), 0 4px 14px -2px rgba(0,0,0,.55)` | `public/ds/tokens.css` |
| `--shadow-elev-2` | `0 2px 4px rgba(0,0,0,.7), 0 14px 36px -6px rgba(0,0,0,.75)` | `public/ds/tokens.css` |
| `--shadow-elev-3` | `0 4px 10px rgba(0,0,0,.7), 0 28px 70px -10px rgba(0,0,0,.9)` | `public/ds/tokens.css` |
| `--shadow-well` | `inset 0 1px 2px rgba(0,0,0,.55), inset 0 0 0 1px rgba(0,0,0,.28)` | `public/ds/tokens.css` |
| `--shadow-ring-brand` | `0 0 0 3px rgba(255,0,54,.22)` | `public/ds/tokens.css` |
| `--shadow-btn-primary` | `inset 0 1px 0 rgba(255,255,255,.38), inset 0 -1px 0 rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.6), 0 8px 22px -8px rgba(255,0,54,.7)` | `public/ds/tokens.css` |
| `--shadow-btn-primary-hover` | `inset 0 1px 0 rgba(255,255,255,.45), inset 0 -1px 0 rgba(0,0,0,.25), 0 1px 2px rgba(0,0,0,.6), 0 0 0 1px rgba(255,0,54,.35), 0 10px 30px -6px rgba(255,0,54,.75)` | `public/ds/tokens.css` |
| `--shadow-btn-pressed` | `inset 0 2px 5px rgba(0,0,0,.4)` | `public/ds/tokens.css` |
| `--shadow-hot` | `inset 0 1px 0 rgba(255,180,195,.35), inset 0 0 0 1px rgba(255,0,54,.18), 0 2px 0 0 #7A0A1C, 0 5px 0 0 #3D050E, 0 18px 40px -10px rgba(0,0,0,.85), 0 0 50px -6px rgba(255,0,54,.45)` | `public/ds/tokens.css` |
| `--shadow-inset-highlight` | `inset 0 1px 0 rgba(255,255,255,.35)` | `app/src/styles/panel.css` |
| `--shadow-inset-highlight-glow` | `var(--shadow-inset-highlight),0 0 10px -2px var(--color-alpha-red-65)` | `app/src/styles/panel.css` |
| `--shadow-inset-highlight-glow-wide` | `var(--shadow-inset-highlight),0 0 12px -2px var(--color-alpha-red-65)` | `app/src/styles/panel.css` |

## Components — `public/ds/bundle.css` (+ app and widget recipes)

- **eg-btn**: `--primary`, `--secondary`, `--ghost`, `--dark`, `--sm`, `--icon`, `__icon`; panel compact height `34px`, small `30px` (`public/ds/bundle.css`, `app/src/styles/panel.css`).
- **eg-icon-btn**: icon button, including `--outline`; panel `30px` square (`public/ds/bundle.css`, `app/src/styles/panel.css`).
- **eg-tabs**: underline or `--segmented`, `--sm`, `__item`, `__count`, `__item--danger`; prompter adds `--lg` with `52px` items (`public/ds/bundle.css`, `app/src/styles/prompter.css`).
- **eg-menu**: popup or `--nav`, with `__item`, `__label`, `__count`, `__group`, `[aria-current]` (`public/ds/bundle.css`).
- **eg-field**: `__label`, `__control`, `__hint`, `__counter`; `--invalid`, `--sm`, `--code`, `--range`, `--prose` (`public/ds/bundle.css`).
- **eg-check**: checkbox and `--switch` (`public/ds/bundle.css`).
- **eg-chip**: default, active and `--avatar` (`public/ds/bundle.css`).
- **eg-tag**: outlined or `--solid` (`public/ds/bundle.css`).
- **eg-status**: `--success`, `--warning`, `--info`, `--danger`, `--neutral` (`public/ds/bundle.css`).
- **eg-kbd**: keyboard label (`public/ds/bundle.css`).
- **eg-live-dot**: live indicator, `--static` (`public/ds/bundle.css`).
- **eg-progress**: default, `--edge`, `--lg`, `--muted` (`public/ds/bundle.css`).
- **eg-post**: card, `--row`, `--new`, `--empty`, `--compact`, `.is-off` (`public/ds/bundle.css`).
- **eg-timeline**: live event rows, `--chat`, `__item--hot`; prompter enlarges `--lg` (`public/ds/bundle.css`, `app/src/styles/prompter.css`).
- **eg-tile**: selectable thumbnail, `--live`, portrait, story, square, wide and banner (`public/ds/bundle.css`).
- **eg-stage**: preview frame, safe area, bar and named zone (`public/ds/bundle.css`).
- **eg-stat**: metric with `--flash`, `--glass`, `--sm`; panel value `26px` (`public/ds/bundle.css`, `app/src/styles/panel.css`).
- **eg-module-card**: `--stopped`, `--error`, `--wide`, `--glass`, `--banded` (`public/ds/bundle.css`).
- **eg-status-dot**: `--running`, `--idle`, `--warning`, `--error`, `--stopped` (`public/ds/bundle.css`).
- **eg-table**: `.eg-table-wrap`, dense table, `--compact`, numeric and row headers (`public/ds/bundle.css`).
- **eg-notice**: `--info`, `--warning`, `--danger`, `--success`, `--sm` (`public/ds/bundle.css`).
- **eg-mark**: inline mark with danger, info and ok variants (`public/ds/bundle.css`).
- **eg-dropzone**: default and `--inline` upload target (`public/ds/bundle.css`).
- **eg-dialog**: backdrop, head, body, foot and `--full` (`public/ds/bundle.css`).
- **panel / sec**: toned surface, section header and footer; `--flat` removes the surface (`app/src/styles/panel.css`).
- **switch**: `36px × 20px` track with checked and focus states (`app/src/styles/panel.css`).
- **pill / state / tagm**: compact status and metadata labels (`app/src/styles/panel.css`).
- **scene**: selectable scene tile with current state (`app/src/styles/panel.css`).
- **qcur**: highlighted question uses `--gradient-hot` and `--shadow-hot` (`app/src/styles/panel.css`, `public/ds/tokens.css`).
- **tile-stat**: compact metric, `24px` value (`app/src/styles/panel.css`).
- **modal / modal-backdrop**: centered modal with 60% scrim (`app/src/styles/panel.css`).
- **lv-list / lv-drawer / lv-slide / lv-savebar**: dense list, slide-over editor and fixed save bar (`app/src/styles/panel.css`).
- **lv-card / lv-switch**: catalog card with 16:8 thumbnail, selected and warning states, compact switch (`app/src/styles/panel.css`).
- **dock d-tabs / d-btn / d-card / d-item**: compact tabs, controls, cards and lists; wide dock has three columns (`app/src/styles/dock.css`).
- **prompter ev-item / pr-row**: event rows and active reading row (`app/src/styles/prompter.css`).
- **eg-card**: widget glow card, including `.soft`, with configurable `--glow`, `--round`, `--surface-bg`, `--surface-border` and `--line-w` (`public/widgets/widget.css`).

Prompter declares `@layer ds, egdev`; its unlayered overrides and user CSS participate outside those layers (`app/src/styles/prompter.css`). Panel, dock and bundle define reduced-motion rules; panel, prompter and bundle define reduced-transparency rules (`app/src/styles/panel.css`, `app/src/styles/dock.css`, `app/src/styles/prompter.css`, `public/ds/bundle.css`).
