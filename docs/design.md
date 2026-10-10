# Design

This is the visual spec of the node-graph field and its editor. The goal is an editor that looks like part of Directus 11.17.4 itself, not like a graph library dropped into a drawer. Every piece below names the Directus token, component or file it imitates, with `path:line` references into `directus-11.17.4/app/src` unless stated otherwise.

The tokens and shared classes live in [`src/shared/ui/theme.css`](../src/shared/ui/theme.css), and the mapping of Vue Flow's own elements onto them in [`src/canvas/directus-theme.css`](../src/canvas/directus-theme.css). This document explains them and says how to use them. If the document and the CSS disagree, fix whichever is wrong.

Differences that Vue Flow forces, and how the canvas works around them, are listed in §13.

## 0. Principles

1. **Directus tokens only.** Colours, fonts, border widths, radii and shadows come from `--theme--*` variables, through the `--ng-*` tokens in `theme.css`. Custom themes and theme overrides (Settings → Appearance) then apply to the editor automatically, in light and in dark mode. No hex values, no library palette and no library font.
2. **Directus components wherever one exists.** Use `v-button`, `v-icon`, `v-list`/`v-list-item`, `v-detail`, `v-divider`, `v-chip`, `v-badge`, `v-notice`, `v-info`, `v-dialog` + `v-card`, `v-form`, `v-select`, `v-skeleton-loader`, `v-progress-circular`, `v-text-overflow` and the `v-tooltip` directive. All are global (`components/register.ts:80-160`), so extensions can use them without imports. Write new markup only where the library renders the element itself (cards, handles, edges); that markup uses the shared `ng-*` classes.
3. **The canvas is the Flows and Insights workspace.** It uses flat tiles with a 2px frame, the 18px grid with dots shown only in edit mode, and Flows arrows: 2px lines with rounded corners and an open chevron (`components/v-workspace.vue:175-193`, `components/v-workspace-tile.vue:357-396`, `modules/settings/routes/flows/components/arrows/*`).
4. **Flat.** Shadows appear only where Directus uses them: on popover surfaces (minimap, toasts; `--theme--popover--menu--box-shadow`), on the header while the drawer scrolls (stock), and as the Flows trigger halo, which marks the selected card.
5. **Canvas geometry is in px, the shell in rem.** Cards, handles and edges are measured in canvas units (CSS px at zoom 1) on the 18px grid, so cards stay on the grid whatever the root font size, and the TypeScript constants in `src/canvas/context.ts` (card width, header height, port rows, chevron size, corner radius) use the same numbers as `theme.css`. Zoom is the accessibility mechanism inside the canvas. The palette, header, inspector, dialogs and field row use Directus's own rem values.
6. **Directus copy.** Button labels and dialog titles use Title Case ("Discard Changes", "Keep Editing"); body text uses sentence case. Reuse Directus i18n keys where they exist (`apply`, `cancel`, `edit`, `delete_label`, `unsaved_changes`, `unsaved_changes_copy`, `discard_changes`, `discard_changes_copy`, `keep_editing`, `done`, `toggle`; `lang/translations/en-US.yaml`). Directus has no keys for undo, redo or zoom, so the extension supplies those.

## 1. What each piece imitates

| Editor piece | Imitates | Source |
|---|---|---|
| Canvas surface and dotted grid | Flows/Insights workspace in edit mode | `components/v-workspace.vue:175-193` |
| Card frame and states | Workspace tile (Flows operations, Insights panels) | `components/v-workspace-tile.vue:357-396` |
| Card header icon tile | File interface preview tile | `interfaces/file/file.vue:425-447` |
| Card headline over title | Drawer header headline/title | `components/v-drawer-header.vue:131-154` |
| Card summary rows | Flows operation overview `<dl>` | `modules/settings/routes/flows/components/options-overview.vue:16-63` |
| Card divider | Tile footer divider | `components/v-workspace-tile.vue:452-457` |
| Selected card | Flows trigger tile (primary frame + halo) | `modules/settings/routes/flows/components/operation.vue:346-381` |
| Deprecated / placeholder frame | Dashed list item / dashed button | `components/v-list-item.vue:200-213`, `components/v-button.vue` `.dashed` |
| Handles | Flows "adjust" attachment handle (ring, gap, dot) | `modules/settings/routes/flows/components/operation.vue:248-258, 427-441` |
| Edges, chevron, corners | Flows arrows | `flows/components/arrows/arrows.vue:89-102`, `arrows/lib/generate-path.ts:60-69`, `arrows/utils/generate-corner.ts`, `utils/vector2.ts:40` (10px corner) |
| Edge label, card badges | `v-chip` x-small | `components/v-chip.vue:110-153` |
| Issue colours | Soft `danger`/`warning` rounded buttons | `components/v-button.vue:252-264` |
| Status overlay | Tile `.resize-details` | `components/v-workspace-tile.vue:408-431` |
| Minimap, toasts | `v-menu` popover surface | `components/v-menu.vue:661-675` |
| Editor surface | Stock `v-drawer` as the Repeater uses it | `components/v-drawer.vue`, `interfaces/list/list.vue:280-315` |
| Header actions | Private-view header action buttons | `views/private/private-view/components/private-view-header-bar-action-button.vue`, `...-header-bar-actions.vue:9-18` |
| Palette | Drawer sidebar navigation list | `components/v-drawer.vue:187-219`, `modules/settings/components/navigation.vue` |
| Palette categories | `v-detail` group (content navigation) | `components/v-detail.vue`, `modules/content/components/navigation.vue:118-136` |
| Inspector / issues column | Item-page sidebar and `sidebar-detail` sections | `views/private/private-view/components/private-view-sidebar.vue:30-35`, `views/private/components/sidebar-detail.vue:66-150` |
| Field row | M2O and File interface rows | `interfaces/select-dropdown-m2o/select-dropdown-m2o.vue:195-269`, `interfaces/file/file.vue:395-447` |
| Empty states | `v-info` | `components/v-info.vue` |
| Banners | `v-notice` | `components/v-notice.vue` |

## 2. The Directus 11.17.4 design language

### 2.1 Where the variables come from

- `ThemeProvider` turns the active theme's `rules` into CSS variables and injects them on `:root` (`packages/themes/src/components/theme-provider.vue:30-67`). Names are the flattened rule path, decamelized and joined with `--`, prefixed `--theme--` (`packages/themes/src/utils/rules-to-css-vars.ts`). For example `form.field.input.borderColorHover` becomes `--theme--form--field--input--border-color-hover`.
- Every theme is merged over the default light or dark theme (`packages/themes/src/composables/use-theme.ts:20-36`). Every variable listed below therefore exists in every theme, including custom ones, and only its value changes.
- `--theme--primary` is `var(--project-color)`, set from the project colour on `:root` (`app.vue:27`). The default is `#6644FF`.
- `body.light` and `body.dark` also define an older palette (`--purple`, `--danger-10`, `--danger-25`, `--background-inverted`, `--foreground-inverted`, `--white` and so on; `styles/themes/_light.scss`, `_dark.scss`, `styles/_colors.scss`). Some stock components still use it, but **it does not follow custom themes**, so the editor's own CSS must not. Use `--theme--danger-background` (a 10% mix, the same as `--danger-10`) and friends instead.

### 2.2 Variables used, with default light and dark values

All 171 `--theme--*` variables exist in both default themes. The light theme has `public--form--label--*` where the dark theme has `public--form--field--label--*`; those are unused here. The ones the editor uses are listed below; mixes are computed for the default project colour `#6644ff`.

| Variable | Light | Dark |
|---|---|---|
| `--theme--foreground` | `#4f5464` | `#c9d1d9` |
| `--theme--foreground-accent` | `#172940` | `#f0f6fc` |
| `--theme--foreground-subdued` | `#a2b5cd` | `#666672` |
| `--theme--background` | `#fff` | `#0d1117` |
| `--theme--background-normal` | `#f0f4f9` | `#21262e` |
| `--theme--background-accent` | `#e4eaf1` | `#30363d` |
| `--theme--background-subdued` | `#f7fafc` | `#161b22` |
| `--theme--border-color` | `#e4eaf1` | `#21262e` |
| `--theme--border-color-accent` | `#d3dae4` | `#30363d` |
| `--theme--border-color-subdued` | `#f0f4f9` | `#21262d` |
| `--theme--border-width` | `2px` | `2px` |
| `--theme--border-radius` | `0.3125rem` | `0.3125rem` |
| `--theme--primary` | project colour | project colour |
| `--theme--primary-background` (10% over background) | `#f0ecff` | `#16162e` |
| `--theme--primary-subdued` (50%) | `#b3a2ff` | `#3a2b8b` |
| `--theme--primary-accent` (25% shade) | `#5842d0` | `#5238c6` |
| `--theme--secondary` | `#ff99dd` | `#ff99dd` |
| `--theme--success` / `-background` | `#2ecda7` / `#eafaf6` | `#2ecda7` / `#102425` |
| `--theme--warning` / `-background` | `#ffa439` / `#fff6eb` | `#ffa439` / `#25201a` |
| `--theme--danger` / `-background` | `#e35169` / `#fceef0` | `#e35169` / `#22171f` |
| `--theme--fonts--sans--font-family` / `-weight` | `"Inter", system-ui` / `500` | same |
| `--theme--fonts--display--font-family` / `-weight` | `"Inter", system-ui` / `700` | same |
| `--theme--fonts--monospace--font-family` / `-weight` | `"Fira Mono", monospace` / `500` | same |
| `--theme--navigation--background` | `var(--theme--background-normal)` | `#21262e` |
| `--theme--navigation--list--*` (icon, foreground, background, hover, active, divider) | see `packages/themes/src/themes/light/default.ts:99-120` | same names |
| `--theme--header--background` / `--box-shadow` | `#fff` / `0 4px 7px -4px rgb(0 0 0 / 0.2)` | `#0d1117` / `0 4px 7px -4px black` |
| `--theme--header--headline--foreground` | `var(--theme--foreground-subdued)` | same |
| `--theme--form--field--label--font-weight` | `600` | `600` |
| `--theme--form--field--input--background` / `-subdued` | `#fff` / `#f7fafc` | `#0d1117` / `#161b22` |
| `--theme--form--field--input--foreground` / `-subdued` | `#4f5464` / `#a2b5cd` | `#c9d1d9` / `#666672` |
| `--theme--form--field--input--border-color` / `-hover` | `#e4eaf1` / `#d3dae4` | `#21262e` / `#30363d` |
| `--theme--form--field--input--border-color-focus` | `var(--theme--primary)` | same |
| `--theme--form--field--input--box-shadow-focus` | `0 0 16px -8px var(--theme--primary)` | same |
| `--theme--form--field--input--height` / `--padding` | `3.375rem` / `0.875rem` | same |
| `--theme--form--row-gap` / `--column-gap` | `2.25rem` / `1.8125rem` (the drawer content overrides row gap to `2.9375rem`, `v-drawer.vue:175`) | same |
| `--theme--sidebar--background` | `var(--theme--background-normal)` | `#21262e` |
| `--theme--sidebar--section--toggle--background` / `--foreground` / `--icon--foreground` | `#e4eaf1` / `#172940` / `#172940` | `#30363d` / `#f0f6fc` / `#f0f6fc` |
| `--theme--popover--menu--background` | `#fafcfd` | `#161b22` |
| `--theme--popover--menu--box-shadow` | `0 0 6px 0 rgb(23 41 64 / 0.2), 0 0 12px 2px rgb(23 41 64 / 0.05)` | `0 0 6px 0 black` |
| `--theme--popover--menu--border-radius` | `var(--theme--border-radius)` | same |

### 2.3 Non-theme root variables that are safe to use

These come from `styles/_variables.scss:3-29`: `--fast` (125ms), `--medium` (200ms), `--slow` (300ms), `--transition` (`cubic-bezier(0.4, 0, 0.2, 1)`), `--transition-in`, `--transition-out`, `--header-bar-height` (3.375rem above 22.5rem width), `--content-padding` (1.375rem from `sm`), `--content-padding-bottom`, `--focus-ring-width` (2px), `--focus-ring-offset` (2px), `--focus-ring-offset-invert`, `--focus-ring-radius` and `--focus-ring-color` (`var(--theme--primary)`). They are not colours; `theme.css` reads them with fallbacks.

### 2.4 Typography and icons

- The body text is 0.8125rem (13px) with line-height 1.5385 in Inter 500 (`styles/_base.scss:31-41`). Drawer content uses 0.875rem with line-height 1.5714 (`v-drawer.vue:183-185`).
- Labels use `.type-label`: 0.875rem, weight 600 (`--theme--form--field--label--font-weight`), `--theme--foreground-accent`. Titles use `.type-title`: 1rem, display font 700. Notes use `.type-note`: 0.75rem italic subdued (`styles/mixins/_type-styles.scss`). Strong text is 600 (`_base.scss:109-111`). Code and values use Fira Mono through `--theme--fonts--monospace--font-family`.
- The headline above a drawer title is 0.6875rem, weight 600, line-height 1, in `--theme--header--headline--foreground` (`v-drawer-header.vue:146-154`).
- **Icons** are Material Symbols, a variable font registered by the app as `font-family: 'Material Symbols'` (`styles/_fonts.scss:116-122`). `<v-icon>` renders `<i data-icon="name">` and shows the name through `::after { content: attr(data-icon) }` with ligatures on and `font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24`; `filled` switches FILL to 1 (`components/v-icon/v-icon.vue:108-150`). Sizes are x-small 0.6875rem, small 1rem, default 1.375rem, large 2rem and x-large 2.6875rem (`v-icon.vue:182-196`). Colour comes from `--v-icon-color`, falling back to `currentColor`.
- Inside the canvas, render `<v-icon :name>` **without** a size prop and set `--v-icon-size` on the parent in px. A size class sets `--v-icon-size` on the icon itself, which would override the parent's value. Vue Flow renders the node and edge components inside the app's component tree, so `<v-icon>` and `v-tooltip` resolve there as anywhere else.

### 2.5 Shape, focus and motion

- Borders are `--theme--border-width` (2px) and radius `--theme--border-radius` (5px). Tiles draw the 2px frame as half inside and half outside (`v-workspace-tile.vue:368-369`).
- Focus: non-div elements get a solid 2px ring in `--focus-ring-color`, offset 2px. Divs and `main` get a 2px **dotted** ring inset by its own width (`_base.scss:44-61`). The editor root is focused only by script and shows no ring (§4.1); cards and edges get their own ring (§5.6, §7.3).
- Transitions use `var(--fast) var(--transition)` for colour, border and shadow, and `var(--slow) var(--transition)` for the grid fade (`v-workspace.vue:186`).

### 2.6 Components

| Component | Facts used here |
|---|---|
| `v-button` | Heights: x-small 1.5625rem, small 2rem, default 2.5rem, large 2.9375rem. `icon` makes it square, `rounded` makes it a circle. `secondary` uses background-normal with hover background-accent. Variants are `outlined`, `dashed`, `warning`, `danger`, `active`, `disabled` and `loading` (`v-button.vue:200-400`). |
| Header action button | `<v-button icon rounded small [secondary]><v-icon :name small /></v-button>` (`private-view-header-bar-action-button.vue:24-40`). Buttons sit in a flex row with a 0.4375rem gap; secondary icons use `--theme--foreground` (`private-view-header-bar-actions.vue:9-18`). `PrivateViewHeaderBarActionButton` is not global, so use the markup it renders. |
| `v-list nav` | Items are 2rem tall with radius 0.25rem and 0.4375rem side padding (`v-list-item.vue:355-371`). Inside a drawer sidebar the stock drawer already maps `--v-list-item-*` to the `--theme--navigation--list--*` tokens (`v-drawer.vue:203-214`). |
| `v-list-item block` | The input-like row: `--theme--form--field--input--height`, 2px input border, radius, input background, hover border colour (`v-list-item.vue:279-343`). |
| `v-detail` | A collapsible group whose activator is a `v-divider` label in `--theme--foreground-subdued` that turns `--theme--foreground` on hover. Props: `label`, `start-open`, `disabled` (`v-detail.vue`). |
| `v-chip` | x-small is 1.125rem with 0.6875rem text and radius 0.5625rem; small is 1.375rem with 0.8125rem text (`v-chip.vue:148-160`). |
| `v-badge` | A corner pill or dot. `--v-badge-background-color`, `--v-badge-color` and `--v-badge-border-color` with `bordered` (`v-badge.vue`). The sidebar uses `--v-badge-color: var(--theme--background-normal)` on a primary badge (`sidebar-detail.vue:66-73`). |
| `v-notice` | `--theme--form--field--input--height` minimum, background-normal, a 4px left bar in the type colour; types `info`, `success`, `warning`, `danger` (`v-notice.vue:67-135`). |
| `v-info` | Centred empty state: a 5.625rem circle icon (pass `icon`, it defaults to none), a `type-title` heading and subdued text (`v-info.vue`). |
| `v-dialog` + `v-card` | Confirmation dialogs: `v-card-title`, `v-card-text`, `v-card-actions` with a `secondary` button then a primary one (`interfaces/list/list.vue:318-329`). |
| `v-tooltip` | The directive; inverted colours, 0.25rem radius (`styles/_tooltip.scss`). Use `v-tooltip.bottom` in the header and `.right` in the palette. |
| `v-skeleton-loader type="input"` | The loading placeholder of input rows (`select-dropdown-m2o.vue:195`). |

### 2.7 Directus 12

Directus 12 renames `--theme--navigation--*` and `--theme--header--*` to `--theme--shell--*`, replaces the input focus border and box-shadow with `--theme--form--field--input--focus-ring-color`, and deprecates `v-button rounded`, `v-resizeable` and the drawer `subtitle` (`docs/content/releases/3.breaking-changes/3.version-12.md:80-120`). This package targets 11.17.4. `theme.css` already lists the 12.x names as `var()` fallbacks wherever it reads a renamed token, so a port mostly means deleting the old names.

## 3. Token reference

Every token is declared in `theme.css` on the editor roots: `.node-graph-editor` (drawer body), `.node-graph-palette` (palette in the drawer sidebar, which is **outside** the body element), `.node-graph-actions` (header actions), `.node-graph-field` (field row) and `.node-graph-display`. Tokens that depend on a per-element inline variable are derived on the element's class instead (see "Per element"), because a custom property that references another one is resolved where it is declared.

**Per element (set inline by the canvas from the compiled ruleset):**

| Inline variable | Set on | Value |
|---|---|---|
| `--ng-node-color` | `.ng-node` | `NodeTypeDef.color`, else unset (falls back to `--ng-node-color-default` = `--theme--primary`) |
| `--ng-port-color` | `.ng-handle` | `ResolvedPort.color`: the data type's colour, `var(--theme--foreground-subdued)` for "any" and for data types without a colour, `var(--theme--danger)` for undeclared placeholders (`src/shared/core/ports.ts:21-28`) |
| `--ng-edge-color` | `.ng-edge` | `EdgeTypeDef.style.color`, else the source port's `ResolvedPort.color` |
| `--ng-connection-color` | `.ng-connection` | the source port's colour |
| `--ng-viewport-x`, `--ng-viewport-y` (px), `--ng-viewport-zoom` (number), `--ng-grid-size` (px) | `.ng-grid` | current viewport and grid size (§4.1) |

Ruleset colours reach the DOM only after `compileRuleset` has accepted them (`isSafeColor` in `src/shared/core/util.ts:230-241`, checked through `optionalColor` in `src/shared/core/compile.ts:796-800`), and only as custom properties in Vue style objects, which Vue applies with `style.setProperty()`. They are never concatenated into a `style` string.

**Base and surfaces:**

| Token | Value |
|---|---|
| `--ng-font-family`, `--ng-font-family-mono` | sans and monospace theme fonts |
| `--ng-font-weight`, `--ng-font-weight-strong` | `--theme--fonts--sans--font-weight` (500); label weight (600) |
| `--ng-foreground`, `-accent`, `-subdued` | the three theme foregrounds |
| `--ng-border-width`, `--ng-border-radius` | theme border width and radius |
| `--ng-transition-fast`, `--ng-transition-slow` | `var(--fast) var(--transition)`, `var(--slow) var(--transition)` |
| `--ng-focus-ring-width`, `-offset`, `-color` | Directus focus ring |
| `--ng-overlay-background`, `-radius`, `-shadow` | `--theme--popover--menu--*` |
| `--ng-error-color`, `--ng-error-background` | `--theme--danger`, `--theme--danger-background` |
| `--ng-warning-color`, `--ng-warning-background` | `--theme--warning`, `--theme--warning-background` |
| `--ng-success-color` | `--theme--success` |

**Canvas:**

| Token | Value |
|---|---|
| `--ng-canvas-background` | `--theme--background` (Flows workspace) |
| `--ng-grid-dot-color` | `--theme--form--field--input--border-color` (`v-workspace.vue:182`) |
| `--ng-grid-dot-radius` | `1px` at 100% (plus 0.5px anti-aliasing, about Directus's 10% radial stop on an 18px tile). `.ng-grid` scales it with `--ng-viewport-zoom` (`--ng-grid-dot-current`), as the stock workspace scales its dots with its content (`v-workspace.vue:155-193`). |
| `--ng-selection-background` | `color-mix(in srgb, var(--theme--primary) 8%, transparent)` |
| `--ng-selection-border-color` | `--theme--primary` |

**Node card:**

| Token | Value |
|---|---|
| `--ng-node-width` | `252px` (14 grid units, the Flows tile width, `flows/constants.ts:3`) |
| `--ng-node-header-height` | `54px` |
| `--ng-node-row` | `18px` |
| `--ng-node-section-padding` | `9px` |
| `--ng-node-padding-inline` | `12px` |
| `--ng-node-port-inset` | `14px` (label start, measured from the card edge) |
| `--ng-node-ports-offset` | `72px` (centre of the first port row) |
| `--ng-node-summary-row` | `36px` |
| `--ng-node-icon-tile`, `--ng-node-icon-size` | `36px`, `22px` |
| `--ng-node-radius` | `--theme--border-radius` |
| `--ng-node-font-size`, `-type`, `-title` | `13px`, `11px`, `14px` |
| `--ng-node-background` | `--theme--background` |
| `--ng-node-background-placeholder` | `--theme--background-subdued` |
| `--ng-node-outline-width` | `--theme--border-width` |
| `--ng-node-border-color` | `--theme--form--field--input--border-color` (edit-mode tile) |
| `--ng-node-border-color-hover` | `--theme--form--field--input--border-color-hover` |
| `--ng-node-border-color-readonly` | `--theme--border-color-subdued` (view-mode tile) |
| `--ng-node-border-color-selected` | `--theme--form--field--input--border-color-focus` (primary) |
| `--ng-node-glow-selected` | `0 0 0 (1px + 8px) color-mix(primary 20%, transparent)`, the trigger halo |
| `--ng-node-border-color-error` | `--theme--danger` |
| `--ng-node-divider-color` | `--theme--border-color-subdued` |
| `--ng-node-foreground`, `-title-color`, `-type-color` | foreground, foreground-accent, foreground-subdued |
| `--ng-node-color-default` | `--theme--primary` |

**Ports and handles:**

| Token | Value |
|---|---|
| `--ng-port-color-any` | `--theme--foreground-subdued` |
| `--ng-port-label-color` | `--theme--foreground` |
| `--ng-handle-size` | `14px` |
| `--ng-handle-border-width` | `--theme--border-width` |
| `--ng-handle-background` | `--theme--background` |
| `--ng-handle-dot-size` | `4px` |
| `--ng-handle-hit-size` | `24px` |
| `--ng-handle-halo-width` | `4px` |
| `--ng-handle-valid-color`, `--ng-handle-invalid-color` | `--theme--primary`, `--theme--danger` |
| `--ng-handle-invalid-opacity` | `0.35` |

**Edges:**

| Token | Value |
|---|---|
| `--ng-edge-color-default` | `--theme--foreground-subdued` (Flows' subdued arrow) |
| `--ng-edge-color-selected` | `--theme--primary` |
| `--ng-edge-width`, `--ng-edge-width-selected` | `2px` (Flows), `3px` |
| `--ng-edge-halo-width`, `--ng-edge-hit-width` | `8px`, `16px` |
| `--ng-edge-dash`, `--ng-edge-gap` | `6px`, `4px` |
| `--ng-edge-marker-size` | `8px` (Flows arrowSize) |
| `--ng-edge-corner-radius` | `10px` (Flows corner) |
| `--ng-edge-label-background`, `-color` | `--theme--background-normal`, `--theme--foreground` (v-chip) |
| `--ng-edge-label-height`, `-font-size`, `-max-width` | `18px`, `11px`, `160px` |
| `--ng-connection-dash` | `4px` |

`--ng-node-ports-offset`, `--ng-node-summary-row`, `--ng-edge-marker-size`, `--ng-edge-corner-radius`, `--ng-foreground-accent`, `--ng-success-color` and `--ng-palette-width` are not read by any rule today. They document the geometry and the palette; the canvas uses the same numbers from `src/canvas/context.ts`.

**Minimap and shell:**

| Token | Value |
|---|---|
| `--ng-minimap-node`, `-node-selected`, `-mask` | background-accent, primary, `color-mix(background-normal 70%, transparent)` |
| `--ng-palette-width`, `--ng-palette-background` | `12.375rem` (stock drawer sidebar), navigation background |
| `--ng-inspector-width` | `22rem` |
| `--ng-panel-background` | `--theme--sidebar--background` |
| `--ng-panel-header-height`, `-background`, `-foreground`, `-icon`, `-border-width`, `-border-color` | `3.375rem` and the `--theme--sidebar--section--toggle--*` tokens |
| `--ng-field-icon-tile` | `2.25rem` (file preview tile) |

## 4. Canvas

### 4.1 Surface and grid

- `.ng-canvas` is the canvas component's root, which Vue Flow mounts into. It has `position: relative; overflow: hidden; direction: ltr`, background `--ng-canvas-background`, `touch-action: none`, `overscroll-behavior: contain` and `user-select: none`. The canvas is always left-to-right, because the graph's geometry is physical (inputs on the left in LR). The shell around it follows the user's text direction.
- `.ng-grid` is an absolutely positioned layer at the bottom of the canvas. It draws the Flows dots with CSS; `@vue-flow/background` is not used. The canvas sets `--ng-viewport-x/y/zoom` and `--ng-grid-size` from Vue Flow's viewport on the `.ng-grid` element itself, not on `.ng-canvas`: custom properties inherit, so changing them on the root on every pan and zoom frame made the browser recalculate the style of every element of every card (about 2.3 s of style work in a 30-step pan of a 500-node graph, 16-17 fps); on the grid layer the same pan runs at 37-40 fps. Dots sit on multiples of the grid size in canvas units, which is where snapped card corners land.
- **Edit mode shows the dots; read-only hides them**, fading over `--slow` (`v-workspace.vue:175-193`: the dots only exist while `editing`). The canvas adds `ng-grid--hidden` when `gridSize × zoom < 9px`, because the dots turn into a grey wash below that.
- Cursors: the empty canvas uses `grab`, and `grabbing` while panning (Vue Flow defaults), and `crosshair` while a connection is drawn. Cards use `move` in edit mode (`v-workspace-tile.vue:378-382`) and `pointer` in read-only. Handles use `crosshair`, and `not-allowed` over an invalid target. Edges and labels use `pointer`.
- Paint order from bottom to top: grid (0), edges, then the selected edge above other edges, edge labels, cards with the dragged card on top, the connection line, the selection box, then the shell's overlays (empty state 4, status 5, toast 6, loading 7). The minimap is a Vue Flow panel inside the canvas. The canvas is its own stacking context (`.ng-stage__canvas` has `isolation: isolate`), so nothing inside it climbs over the overlays. Edges always pass **under** cards, as in Flows.
- Wheel and pinch zoom the canvas and must never scroll the drawer. The drawer's `main` scrolls (`v-drawer.vue:231-236`), so Vue Flow runs with `prevent-scrolling`, the stage calls `preventDefault()` on any wheel event the library did not consume, and `overscroll-behavior: contain` on the root and canvas catches the rest.
- Focus: the editor root (`tabindex="-1"`) is focused by script so the shell's keys reach it, and it is not in the tab order, so it shows **no** ring: `.node-graph-editor:focus-visible { outline: none }`. Without it, Chrome treats the root as `:focus-visible` after any shortcut and the stock dotted ring for focused divs (`_base.scss:52-60`) frames the whole body. Every control inside keeps its own ring.

### 4.2 Overlays

| Overlay | Class | Content and look |
|---|---|---|
| Status | `.ng-canvas-status` | Bottom-left, 0.6875rem from the edges: the zoom, e.g. "100%". 0.6875rem Fira Mono in `--theme--foreground-subdued` on the canvas background, radius 5px. This is the tile's `.resize-details` look. Not interactive. The zoom comes from the canvas's `setViewport` commands, so the canvas reports every view change. |
| Loading | `.ng-canvas-loading` | Covers the canvas until the canvas emits `ready` (the shell stops waiting after 5 s and logs a warning). `<v-progress-circular indeterminate />` centred, the Flows loading state (`flows/flow.vue:669-671`). |
| Empty | `.ng-canvas-empty` | `<v-info icon="account_tree" title="Empty Graph">` (Title Case like "No Flows" and "Empty Item"). Edit mode: "Drag a node type onto the canvas to start, or click one to add it to the middle." (no "from the left": below 54rem the node types are above the canvas). Read-only: "This graph has no nodes." It has `pointer-events: none`, so drops and pans still reach the canvas. |
| Toast | `.ng-canvas-toast .ng-canvas-toast--bottom` | A connection or node was refused: `<v-notice type="danger">` (not `multiline`: without a `#title` that puts the icon on a line of its own, `v-notice.vue:146-148`) with the reason, bottom centre 2.5rem from the bottom so it never covers the status readout, popover shadow. It fades out after 4s, or straight away on the next pointerdown. ⌘S shows "Applied. Save the item to keep the changes." the same way as an `info` notice. |
| Remote change | `.ng-canvas-toast .ng-canvas-toast--top` | Stays until answered: `<v-notice type="warning">` (no `multiline`, as for the toast) "This field changed while you were editing." with `<v-button x-small secondary>` "Reload" and `<v-button x-small>` "Keep Mine". It floats over the canvas, so the viewport size does not change. |
| Minimap | `.ng-minimap` | §8.2. |

## 5. Node card

### 5.1 Anatomy and geometry

All values are canvas px at zoom 1. W = 252.

```text
 x=0                                                              x=252
 ┌──────────────────────────────────────────────────────────────────┐ y=0
 │ ┌────┐  Task                                         ┌────────┐  │  header 54
 │ │ ✓  │  Review contract                              │ (!) 2  │  │  (9 + 36 + 9)
 │ └────┘                                               └────────┘  │
 ◉ in                                                        next ◉  │ y=72   ports: 9 + 18·R + 9
 │                                                                  │
 ├──────────────────────────────────────────────────────────────────┤  2px divider (inset, no layout)
 │ Assignee                                                         │  summary: 9 + 36·S + 9
 │ Security                                                         │  (dt 18 + dd 18 per row)
 │ Due days                                                         │
 │ 3                                                                │
 └──────────────────────────────────────────────────────────────────┘ y=180
```

- **Height** = `54 + (R > 0 ? 18 + 18·R : 0) + (S > 0 ? 18 + 36·S : 0)`, where R = max(number of left-side ports, number of right-side ports), counting undeclared placeholders, and S = number of summary rows. Every height is a multiple of 18, so a snapped card covers whole grid cells, and the browser renders exactly these sizes (90, 144, 180 and 198px for the common cases). Vue Flow measures the DOM, so the CSS must arrive at these numbers by itself.
- **Port centres:** input *i* at (0, 72 + 18·i), output *i* at (252, 72 + 18·i). These are always grid lines, so two snapped cards at the same y get perfectly straight edges between them.
- **Top and bottom ports** (direction `TB`, or `side: 'top' | 'bottom'`): centres on that edge at x = 126 + 36·(i − (n − 1)/2), which is also on grid lines. They have no label row; the label goes in a `v-tooltip` and in the inspector. In pure TB direction R = 0, so the card is just header plus summary.
- The frame is drawn with `box-shadow` (1px inset + 1px outset), so it takes no layout space. It looks exactly like the tile's border + box-shadow pair and like a 2px SVG stroke centred on the edge. Radius is `--theme--border-radius`.
- The handles are siblings of the card inside Vue Flow's node wrapper, which has exactly the card's size, so the card needs no positioning of its own. Inside `.ng-node`, use flex and grid only.

### 5.2 Header (54px)

- `.ng-node__header`: flex, 9px gap, padding 9px 12px 9px 9px.
- `.ng-node__icon`: a 36×36 tile with radius 5px and background `color-mix(in srgb, var(--ng-node-background), var(--ng-node-color) 10%)`, the same formula as `--theme--primary-background`. The icon is `NodeTypeDef.icon` at 22px in the node colour. It defaults to `--theme--primary`, as Insights panels and Flows do (`v-workspace-tile.vue:71`). With no icon, use `category` for categorised types and `account_tree` otherwise. This is the file interface preview tile tinted like `.has-file` (`file.vue:425-447`).
- `.ng-node__heading` stacks:
  - `.ng-node__type`: the type label at 11px/16px, weight 600, `--theme--foreground-subdued`. This is the drawer-header headline idiom. Flows writes the type in primary at 14px; here the colour moves to the icon tile instead, because node colours such as warning orange are hard to read as 11px text. Deprecated types append ` <span class="ng-node__type-suffix">· Deprecated</span>` (italic).
  - `.ng-node__title`: `nodeTitle()` at 14px/20px, weight 600, `--theme--foreground-accent`, one line with an ellipsis. An empty title already falls back to the type label in core.
- `.ng-node__badges`: at most two `.ng-badge` pills, errors first: 18px tall, 0 5px padding, radius 9px, 11px weight 600, a 12px `error` or `warning` icon plus the count. `--error` is danger on danger-background; `--warning` is warning on warning-background (the soft `.danger.rounded` / `.warning.rounded` v-button colours). Each has a `v-tooltip` listing the messages.

### 5.3 Ports block

- `.ng-node__ports`: a 2-column grid (`minmax(0, 1fr)` twice, 12px gap), padding 9px 14px. `.ng-node__inputs` holds one `.ng-port-label` per left-side port, left aligned; `.ng-node__outputs` holds the right-side ports, right aligned. The block is left out when R = 0.
- `.ng-port-label`: 18px rows, 13px text in `--theme--foreground`, ellipsis. Undeclared placeholder ports (`ResolvedPort.declared === false`) add `.ng-port-label--undeclared`: italic, danger colour, and the raw key as text.
- Handles are positioned by Vue Flow (§6, §13.1), not inside this block.

### 5.4 Summary block (Flows overview)

- `<dl class="ng-node__summary">` with one `<div><dt>Label</dt><dd>Value</dd></div>` per `nodeSummary()` row, padding 9px 12px. `dt`: 13px/18px, weight 600, `--theme--foreground`. `dd`: 13px/18px Fira Mono in `--theme--foreground-subdued`, one line with an ellipsis. This is `options-overview.vue:41-63` plus the global `dt`/`dd` colours (`_base.scss:121-147`, which theme.css overrides for layout).
- `nodeSummary()` leaves out fields without a value, so a card only lists the summary fields that are filled in and its height varies with its content. Item references show the referenced item's display text, which the shell loads while the editor is open (`src/shared/ui/references.ts`) and hands to the canvas as `CanvasProps.references`; until then they show their key. An empty `dd`, should one ever render, shows `--` in `--theme--form--field--input--border-color`, exactly as `ValueNull` does (`views/private/components/value-null.vue`).
- When the card also has ports, a 2px `--theme--border-color-subdued` divider sits on top of the block (the tile footer divider), drawn as an inset shadow so it takes no space.
- The block is left out when S = 0.

### 5.5 Canonical markup

```html
<div class="ng-node [state classes]" style="--ng-node-color: var(--theme--primary)">
	<div class="ng-node__header">
		<span class="ng-node__icon"><v-icon name="task_alt" /></span>
		<span class="ng-node__heading">
			<span class="ng-node__type">Task</span>
			<span class="ng-node__title">Review contract</span>
		</span>
		<span class="ng-node__badges">
			<span class="ng-badge ng-badge--error"><v-icon name="error" />2</span>
		</span>
	</div>
	<div class="ng-node__ports">
		<div class="ng-node__inputs"><span class="ng-port-label">in</span></div>
		<div class="ng-node__outputs"><span class="ng-port-label">next</span></div>
	</div>
	<dl class="ng-node__summary">
		<div><dt>Assignee</dt><dd>Security</dd></div>
	</dl>
</div>
```

### 5.6 States

Modifier classes go on `.ng-node`. The edit or read-only mode comes from `.node-graph-editor--readonly` on the editor root. Precedence, from strongest: focus ring, selected/dragging, placeholder, error, deprecated, hover, base.

| State | Class | Frame | Other |
|---|---|---|---|
| Rest, edit mode | — | 2px `--theme--form--field--input--border-color` | cursor `move` |
| Rest, read-only | (root `--readonly`) | 2px `--theme--border-color-subdued` (Flows view mode) | cursor `pointer`; free handles hidden |
| Hover | `:hover` | `--theme--form--field--input--border-color-hover` | `--fast` transition |
| Selected | `ng-node--selected` | `--theme--primary` + 8px halo of primary at 20% (the Flows trigger tile, not animated) | Driven by the shell's `selection`, not Vue Flow's internal selection |
| Dragging | `ng-node--dragging` | same as selected | on top of other cards |
| Keyboard focus | `:focus-visible`, or a focused Vue Flow node wrapper | Directus ring: 2px solid `--focus-ring-color`, 2px outside the frame | The wrapper's own dotted div ring is removed (`:has(> .ng-node)`) |
| Has errors | `ng-node--error` | `--theme--danger` | error badge |
| Has warnings only | — | unchanged | warning badge (warnings are common while a graph is being built, so they do not recolour the frame) |
| Deprecated type | `ng-node--deprecated` | dashed 2px in `--…-border-color-hover` | icon tile greyed (background-normal, subdued icon); headline "· Deprecated"; the `deprecated_node_type` warning badge |
| Unknown type (placeholder) | `ng-node--placeholder ng-node--error` | dashed 2px `--theme--danger` | background `--theme--background-subdued`; icon `help` on danger-background; headline "Unknown type"; title = raw type key in Fira Mono; no summary; ports only for the keys edges reference (undeclared) |

## 6. Ports and handles

### 6.1 Geometry and look

- A 14px circle centred on the card edge at the port centre (§5.1), with a 2px ring in `--ng-port-color` and an inner fill of `--theme--background`. The fill hides the edge underneath.
- **Free:** ring only. **Connected:** ring, a 1px gap and a 4px dot in the port colour. This is the Flows "adjust" input handle (ring, gap, dot) scaled from 18px to 14px so ports fit one per 18px row.
- Hit target: 24px, a transparent `::before` around the ring. It needs the handle to be positioned, which Vue Flow does.
- Edges start at the source handle's outer edge (centre ±7px) and their chevron tip stops 2px before the target ring, i.e. 9px before the target centre, as in Flows, where the arrowhead stops just short of the handle.

### 6.2 States

| State | Class (on `.ng-handle`) | Look |
|---|---|---|
| Free | — | ring in port colour |
| Connected | `ng-handle--connected` | ring + dot |
| Hover (edit) | `:hover` | + 4px halo of the port colour at 25% |
| Drag source | `ng-handle--source` | + halo |
| Port has a warning-level issue (`min_connections` by default) | `ng-handle--warning` | ring in warning |
| Port has an error-level issue (`max_connections`, `unknown_port`, or any of the three raised to error) | `ng-handle--error` | ring in danger (wins over warning) |
| Valid target while drawing | `ng-handle--valid-target` | + 4px primary halo at 25% |
| Invalid target while drawing | `ng-handle--invalid-target` | opacity 0.35 |
| Pointer over a valid target | `ng-handle--target ng-handle--valid-target` | ring primary + dot + halo |
| Pointer over an invalid target | `ng-handle--target ng-handle--invalid-target` | full opacity, ring danger, fill danger-background, danger halo, cursor `not-allowed` |
| Undeclared placeholder | `ng-handle--undeclared` | dashed ring, danger colour (from `ResolvedPort.color`) |
| Read-only | (root `--readonly`) | free handles hidden (`visibility: hidden`, Flows view mode, `operation.vue:208, 228`); connected handles shown, cursor `default` |

The canvas computes the valid and invalid classes itself. When a connection drag starts (a new connection, or an edge end being moved to another port), it runs `canConnect()` for every port on the other side once and keeps the verdicts; each handle then gets `ng-handle--valid-target` or `ng-handle--invalid-target`, and they are removed on release. Only "the handle under the pointer" (`ng-handle--target`) comes from Vue Flow, through its `connectionEndHandle` (§13.1).

### 6.3 Markup

Vue Flow's `<Handle>` renders a `div` and positions it; the canvas adds the classes and the inline variables:

```html
<div class="vue-flow__handle vue-flow__handle-left ng-handle ng-handle--connected" style="top: 72px; --ng-port-color: var(--theme--primary)"></div>
```

## 7. Edges

### 7.1 Colour, width and path

- **Colour:** the edge type's `style.color`, else the source port's data-type colour, else `--ng-edge-color-default` (`--theme--foreground-subdued`). Issues override it: errors draw in danger and warnings in warning. Selection overrides everything with primary. With the example ruleset, `flow` edges are primary, exactly like Flows resolve arrows, and `event` escalations and `timeout` edges are warning orange.
- **Width:** 2px (Flows), 3px when selected. Caps and joins are round.
- **Path** (`EdgeTypeDef.style.path`): `bezier` uses horizontal tangents at both ends (vertical in TB). `step` is orthogonal with 10px rounded corners, the Flows `generateCorner` radius (Vue Flow `getSmoothStepPath({ borderRadius: 10 })`). `straight` is a straight line. Backward edges (target left of source) need a detour for `step`; Vue Flow's routing provides it, and it is not hand-built.
- **Dashed** (`style.dashed`, `ng-edge--dashed`): `6px 4px`. **Animated** (`style.animated`, `ng-edge--animated`): the same dash, moving 10px every 0.6s toward the target; it stops under `prefers-reduced-motion`.
- **Marker** (`style.marker`, default `arrow`): an **open chevron**, two 8px arms at 45° in the edge's own colour and width, round caps, tip at the target end (`arrows/lib/generate-path.ts:60-69`). It is never a filled triangle. It is drawn as a second path inside the edge group, so it follows the edge's CSS state without per-colour `<marker>` defs. `marker: 'none'` draws no chevron.

### 7.2 Markup

```html
<g class="ng-edge [ng-edge--selected|--error|--warning|--dashed|--animated]" style="--ng-edge-color: var(--theme--primary)">
	<path class="ng-edge__halo" d="…" />
	<path class="ng-edge__path" d="…" />
	<path class="ng-edge__marker" d="M tx-8 ty-8 L tx ty L tx-8 ty+8" />
	<path class="ng-edge__hit" d="…" />
</g>
```

`(tx, ty)` is the tip, 9px before the target port centre along the arrival direction. In LR the chevron opens to the left as above; in TB it is `M tx-8 ty-8 L tx ty L tx+8 ty-8`. `chevronPath()` in `src/canvas/context.ts` covers all four sides.

### 7.3 States

| State | Look |
|---|---|
| Rest | 2px line + chevron in the resolved colour |
| Hover (edit and read-only) | 8px halo of the edge colour at 20% behind the line |
| Selected | primary, 3px, 8px halo of primary at 25%; label pill turns primary |
| Keyboard focus (Vue Flow edges are focusable) | halo in the focus ring colour at 40% |
| Has errors | line, chevron and label in danger |
| Has warnings | line, chevron and label in warning |

### 7.4 Label pill

- Text comes from `edgeLabel()`. An empty label means no pill.
- It is an x-small `v-chip`: 18px tall, 0 6px padding, radius 9px, 11px Inter 500, `--theme--foreground` on `--theme--background-normal`, at most 160px wide with an ellipsis. It sits at the path midpoint, centred, above edges and below cards.
- `--selected` uses primary on primary-background; `--error` uses danger on danger-background; `--warning` uses warning on warning-background.
- It is an HTML `.ng-edge-label`, rendered through Vue Flow's `EdgeLabelRenderer`.
- Clicking the pill selects the edge.

### 7.5 Connection in progress

`<path class="ng-connection" style="--ng-connection-color: <source port colour>">`: a bezier, 2px, dashed 4px, round caps, no chevron, no pointer events. It turns solid (`--valid`) when the pointer is over a valid target, and danger (`--invalid`) over an invalid one, together with the target handle states (§6.2). On release over an invalid target nothing is created and the shell shows the toast (§4.2).

## 8. Selection box and minimap

### 8.1 Selection box

Shift + drag on the empty canvas draws Vue Flow's marquee, and a marquee selection keeps a rectangle around the selected cards. Both (`.vue-flow__selection`, `.vue-flow__nodesselection-rect`) get the same look: a 1px `--theme--primary` border, a fill of primary at 8%, radius 2.5px. Vue Flow positions them. Directus has no marquee of its own; this uses the same primary-on-tint pairing as the selected `v-fancy-select` card in the field drawer.

### 8.2 Minimap

- A floating card at the bottom right, 0.6875rem in from the edges, 200 × 135px, `.ng-minimap`: popover background, radius and shadow, the `v-menu` surface. It shows only when the field's `showMinimap` option is on. It is `@vue-flow/minimap` (§13.1), pannable and zoomable.
- Inside it, cards are `--ng-minimap-node` (background-accent) with radius 4, selected cards are primary (`ng-minimap__node--selected`), and the viewport mask is background-normal at 70%. Edges are not drawn.

## 9. Drawer layout

```text
     ┌───────────────────────────────────────────────────────────────────────────────────┐
 (X) │ (◎) Approval workflow · v1                                                         │ stock v-drawer-header
     │      Graph                          [↶][↷]  [−][+][⤢]  [!3]  (✓)                   │ 3.375rem, sticky
     ├───────────────┬─────────────────────────────────────────────────┬─────────────────┤
     │ PALETTE       │ CANVAS  .ng-canvas                              │ INSPECTOR 22rem │
     │ drawer        │ dotted grid in edit mode                        │ sidebar bg      │
     │ sidebar       │                                                 │ ┌─────────────┐ │
     │ 12.375rem,    │      ┌──────────┐      ┌──────────┐             │ │ ◎ Task      │ │ 3.375rem
     │ resizable     │      │  card    │─────>│  card    │             │ │ Review … [x]│ │ section header
     │ ─ Flow ────── │      └──────────┘      └──────────┘             │ └─────────────┘ │
     │  ▶ Start      │                                                 │  v-form         │
     │  ■ End        │                                                 │  node issues    │
     │ ─ Steps ───── │                                                 │ ┌─────────────┐ │
     │  ✓ Task       │                                                 │ │ ! Issues  3 │ │ issues section
     │  ◎ Approval   │ 100%                                [minimap]   │ │ …           │ │ (toggle)
     └───────────────┴─────────────────────────────────────────────────┴─────────────────┘
```

### 9.1 Drawer and widths

- Use the stock `v-drawer` with `persistent`, `icon="account_tree"` (shown in the stock 2rem round header tile), `:title` set to the field name, and `:subtitle` set to `"<ruleset name> · v<version>"`, plus `" · Read Only"` in read-only mode. The subtitle renders as the 0.6875rem headline. The X on the left is the drawer's own cancel button (`v-drawer.vue:79-90`).
- Widths: `standard` is the stock 48.125rem; `wide` is `max(48.125rem, 80vw)`; `full` is `none`, which with the stock `inline-size: calc(100% - 3.625rem)` (`v-drawer.vue:243-245`) leaves room for the X. The drawer has no width prop and caps its article with a scoped rule (`v-drawer.vue:141-146`, specificity 0,2,0), so the unscoped `<style>` block of `src/shared/ui/NodeGraphEditor.vue` widens it with `#dialog-outlet .v-drawer:has(.node-graph-editor--wide)` and `--full` (1,2,0, which wins without `!important`). Only a drawer that contains the editor's body matches; drawers stacked on top keep the stock width. These rules key on the drawer's internal class names, so re-check them on Directus upgrades.
- Pass `sidebar-resizeable` so the palette can be dragged from 198px to 385px (`v-drawer.vue:46-48, 95-106`).

### 9.2 Header actions (`#actions`)

Every action uses the header action button markup: `<v-button v-tooltip.bottom="label" icon rounded small secondary :disabled><v-icon :name small /></v-button>`. Apply is the only non-secondary (primary) button and comes last, as the Repeater's check does (`list.vue:290-297`). Put a 0.25rem spacer between groups; Directus headers have no dividers.

| Group | Button | Icon | Tooltip | Notes |
|---|---|---|---|---|
| History | Undo | `undo` | "Undo (⌘Z)" | `disabled` when there is nothing to undo |
| | Redo | `redo` | "Redo (⌘⇧Z)" | |
| View | Zoom out | `zoom_out` | "Zoom Out" | |
| | Zoom in | `zoom_in` | "Zoom In" | |
| | Fit | `fit_screen` | "Fit to Screen" | |
| Issues | Issues | `error` (errors), `warning` (warnings only), `check_circle` (none) | "Issues" | Wrapped in `<v-badge :value="count" :disabled="!count" bordered>` (99+ at most) with `--v-badge-background-color` danger (or warning), `--v-badge-color: var(--theme--background-normal)` and `--v-badge-border-color: var(--theme--header--background)`. While the issues section is open, use the active colours from `flows/flow.vue:789-794`: `--v-button-background-color: var(--theme--primary-background)`, `--v-button-color: var(--theme--primary)`, hover `--theme--primary-subdued`. |
| Apply | Apply | `check` | "Apply (⌘⏎)" | Primary `v-button icon rounded small`. It applies and closes, like the drawer's own ⌘⏎ (`v-dialog.vue:39-44`); ⌘S applies and keeps the editor open. |

Read-only mode shows only the View group. Show ⌘ on macOS and Ctrl elsewhere.

### 9.3 Palette (`#sidebar`)

- Root: `<div class="node-graph-palette">`, so the tokens reach it (the sidebar slot is outside the editor body). The stock drawer already applies the navigation list colours here (`v-drawer.vue:203-214`).
- Use `<v-list nav>`. Each node type is `<v-list-item class="ng-palette-item" clickable draggable="true" :disabled>` containing:
  - `<v-list-item-icon><v-icon :name="type.icon" :color="type.color" /></v-list-item-icon>`. The icon takes the node colour, as collection icons in the content navigation take the collection colour.
  - `<v-list-item-content><v-text-overflow :text="type.label" /></v-list-item-content>`.
  - With `maxInstances`, `<v-list-item-hint>` shows `used / max` in subdued text.
- `v-tooltip.right` shows `type.description`. A disabled item (limit reached) shows "Limit reached (1 of 1)" and has `cursor: not-allowed`, `--theme--foreground-subdued` text and no drag. An item is disabled only while `max_instances` is an error, as core's `addNode` refuses only then; with the severity at warning or off the type stays available and the issues panel reports the extra node.
- **Categories:** each category is a `<v-detail :label="category" start-open>` (a divider label with a chevron, subdued until hovered), as the content navigation does for groups. Types without a category come first, without a heading. Deprecated types are hidden.
- With more than 8 visible types, add a sticky search at the top (`.ng-palette-search` with `<v-input small type="search">` and a `search` icon), the content navigation's search (`navigation.vue:142-151`).
- Dragging: the cursor is `grab`, then `grabbing`. Use the browser's default drag image of the list item, set `PALETTE_DRAG_MIME` (and no `text/plain`, so the type key cannot be dropped into text inputs), and set `effectAllowed = 'copy'`. Clicking an item adds the node at the viewport centre, nudged down until it does not cover another card's header.
- Under 54rem the drawer hides the sidebar and renders the same slot again in a `v-detail` above the content (`v-drawer.vue:127-131`). The palette component is therefore mounted twice, so it must not use DOM ids. That detail does not set the navigation icon colour, so `.node-graph-palette` sets `--v-list-item-icon-color` to `--theme--navigation--list--icon--foreground` itself; otherwise uncoloured type icons turn grey there and look disabled. Read-only mode passes no sidebar slot.
- An empty palette (every type deprecated, or none defined) shows `<v-notice>` "This ruleset has no node types to add."

### 9.4 Body

- `.node-graph-editor` (plus `--readonly` and `--standard|--wide|--full`) is the root, with `block-size: calc(100cqh - var(--header-bar-height))` and `flex: 1 1 0`. The drawer's `.content` is a size container (`v-drawer.vue:177`) and the sticky header sits inside the scrolling `main`. Set `min-block-size: 25rem`, `overflow: hidden`, `container-type: inline-size`.
- Below 54rem the drawer also renders the palette in a "Node Types" `v-detail` between the header and the body (§9.3), so the 100cqh height alone would overflow `main`. One more unscoped rule, keyed on the stock classes like the width rules, makes that drawer's `main` a flex column (`#dialog-outlet .v-drawer:has(.node-graph-editor) > .content > .main { display: flex; flex-direction: column }`, other children `flex-shrink: 0`), so the body takes exactly what the header and the detail leave, open or closed. Above 54rem the detail is `display: none` and nothing changes.
- Inside it, `.ng-layout` (the shell's own scoped CSS; `theme.css` only supplies the width tokens) is a grid: `minmax(0, 1fr) var(--ng-inspector-width)`. Below a 50rem container width (the `standard` drawer, and any drawer below the 54rem breakpoint, where an 800px window leaves 48rem), stack the inspector under the canvas instead: rows `minmax(0, 1fr) minmax(0, 45%)`. Graphs run left to right, so the canvas needs the full width more than the inspector needs to sit beside it.
- No borders between columns: Directus separates the navigation, main and sidebar with background colour alone (`--theme--navigation--border-width` and `--theme--sidebar--border-width` are 0).

### 9.5 Inspector column

- The column is `.ng-panel` (sidebar background), a flex column. The selection section takes the remaining height and scrolls; the issues section sits below it.
- **Section header** `.ng-panel-header`: the `sidebar-detail` accordion trigger. It is 3.375rem tall, padding-inline 1rem 0.5rem, gap 0.6875rem, `--theme--sidebar--section--toggle--background`/`--foreground`, with the icon in the toggle icon colour.
- **Section body** `.ng-panel-body`: padding 0.875rem 1rem. It sets `--theme--form--row-gap: 1.375rem` and `--theme--form--column-gap: 0.875rem`, so `v-form` fits 22rem (its container query puts every field at full width below 31.25rem).
- **Node selected:** the header shows `<v-icon :name :color="node colour">`, then a heading stack (type label at 0.6875rem/600 subdued; title at 0.875rem/600 foreground-accent, ellipsis), then `<v-icon name="delete" clickable v-tooltip="'Delete'">` with `--v-icon-color-hover: var(--theme--danger)`. Delete appears only when the type is deletable and the editor is editable. The body contains `<v-form :fields :model-value primary-key="+" :disabled="readOnly">`, then the node's issues as compact rows (§9.6).
- **Edge selected:** header icon `trending_flat` (in the edge type's colour, if it has one), the edge type's label as the type label ("Connection" when the type is unknown), title `"<source title> → <target title>"`. The body contains a `<v-select>` of the edge types allowed by the source port (left out when only one is allowed), the edge type's `v-form`, then the edge's issues.
- The selection section's body scrolls on its own under its fixed header (`flex: 1 1 auto; min-block-size: 0; overflow-y: auto; overscroll-behavior: contain`), like an open `sidebar-detail` (`sidebar-detail.vue:117`), and the section takes what the issues section leaves (`flex: 1 1 0`).
- **Nothing selected:** header icon `account_tree` with the same heading stack as a node: "Ruleset" over the ruleset name. The body is the stock information section (`modules/files/components/file-info-sidebar-detail.vue`): a global `dl` with Key and Version, a `v-divider`, a `dl` with Nodes, Connections, Errors and Warnings, another `v-divider`, then the help as plain paragraphs in foreground text (like sidebar page descriptions, `collections.vue:280`; never italic `.type-note`, which Directus keeps for field notes): "Drag from a port to another node to connect.", "Delete or Backspace removes the selection.", "⌘Z undoes, ⌘⇧Z redoes, ⌘S applies and keeps the editor open." Groups sit 1.125rem apart. The dividers get `flex: none` (`v-divider` is `flex: 1 1 0`, `v-divider.vue:40`) and `--v-divider-color: var(--theme--navigation--list--divider--border-color)`, because the default input border colour equals the column background in the dark theme.
- Multiple selection: header "N items selected" with the same clickable `delete` header icon as a single selection when everything selected is deletable (a `secondary` button would be `background-normal` on the `background-normal` column and read as bare text), and plain help text: "2 nodes and 1 connection selected. Select a single element to edit its fields.", plus "Some of the selected nodes cannot be deleted." when that is why the icon is missing.
- Notices in the inspector (deprecated type, unknown type) have no `#title` and are therefore not `multiline`. "This node type has no fields." uses the plain help style.

### 9.6 Issues section

- Toggled from the header button and shown under the inspector, at most 40% of the column height, scrolling on its own.
- The header is `.ng-panel-header` with a `warning` or `error` icon, "Issues", and `.ng-issue-chip--error` / `--warning` counts on the right.
- The body is `<v-list>` with `--v-list-padding: 0`. Each issue is a `v-list-item clickable` with:
  - `<v-list-item-icon><v-icon :name="severity === 'error' ? 'error' : 'warning'" small :color="danger or warning" /></v-list-item-icon>`;
  - `<v-list-item-content>` holding the message (0.8125rem, foreground, up to two lines) and, when it concerns an element, that element's title in 0.75rem subdued.
- Errors come before warnings. Clicking an issue selects the element and calls `focusElement`.
- With no issues: one row with a `check_circle` icon in `--theme--success` and "No issues" in subdued text.

### 9.7 Dialogs

Declare dialogs inside the drawer slot; use `v-dialog` + `v-card`, the Repeater pattern. Declared there, they mount when the drawer opens, so they land after it in `#dialog-outlet` (on top) and in front of it in the Escape queue.

| Dialog | Title | Text | Actions |
|---|---|---|---|
| Cancel with unapplied changes | `unsaved_changes` ("Unsaved Changes") | `discard_changes_copy` | `v-button secondary` `discard_changes`, `v-button` `keep_editing` |
| Apply with errors | "Apply With Errors?" | "This graph has N errors. You can apply it, but saving the item may be rejected." (with Log only or Off enforcement: "You can apply it; this field accepts graphs with errors when the item is saved.") | `v-button secondary` `keep_editing`, `v-button` warning "Apply Anyway" |

## 10. Field row and display

### 10.1 Row anatomy

The row copies the M2O and File rows: `<v-list-item block clickable :disabled :non-editable>` inside `<div class="node-graph-field">`. It is 3.375rem tall with a 2px input border and the input background; hover uses the hover border, and `:focus-within` uses the focus border and `--theme--form--field--input--box-shadow-focus` (`file.vue:395-423`). Contents, left to right:

1. `<v-list-item-icon><div class="ng-field-icon [--filled|--warning]"><v-icon name="account_tree" /></div></v-list-item-icon>`: the 2.25rem file preview tile. Without a value it is background-normal with a subdued icon; `--filled` (has a value) is primary-background with a primary icon; `--warning` (malformed value) is warning-background with a warning icon.
2. `<v-list-item-content><v-text-overflow :text="fieldSummary" /></v-list-item-content>` in the input foreground. The placeholder uses `--v-input-placeholder-color`, falling back to `--theme--foreground-subdued`.
3. Issue chips, only when there are any: `.ng-issue-chip--error` / `--warning`, a 1rem icon plus the count.
4. `.item-actions` (`list-interface-item-actions`: flex, 0.25rem gap, icons in `--theme--form--field--input--foreground-subdued`) with one clickable `v-icon` and a tooltip: `edit` "Edit", `visibility` "View" or `add` "Create". These are icon buttons, as on the M2O and File rows; the label goes in the tooltip and `aria-label`. Clicking anywhere on the row does the same as the icon.

### 10.2 Row states

| State | Row | Tile | Text | Action |
|---|---|---|---|---|
| Loading | `<v-skeleton-loader type="input" />` | | | |
| Empty, editable | normal | plain | placeholder (option, default "No graph yet") | `add` "Create" (seeds the starter graph and opens the editor) |
| Empty, disabled | disabled look (input background-subdued, subdued text) | plain | placeholder | none |
| Value, editable | normal | `--filled` | `fieldSummary` | chips, `edit` |
| Value, disabled (read-only field, archived or locked item) | disabled look, but `non-editable` keeps it clickable as M2O does (`select-dropdown-m2o.vue:197-205`) | `--filled` | `fieldSummary` | chips, `visibility` "View" |
| Malformed value | normal | `--warning`, with a tooltip listing the normalisation problems | summary of the normalised document | `edit` (the editor opens the normalised document) |
| Invalid ruleset | none; `<v-notice type="danger" multiline indent-content>` with the `#title` "This field's ruleset is invalid" and the problems as a monospace list on their own line below it (content `flex-basis: 100%`, spacing of the stock validation notices). A missing ruleset has the title "This field has no ruleset" and the hint "An administrator can set one in the field's interface options in Data Model." instead of a list. | | | |
| Batch edit | none; `<v-notice>` "Batch editing is not supported for node graphs." | | | |

### 10.3 Display

The display shows `<v-text-overflow :text="fieldSummary" />` in table cells. When `meta.errorCount > 0`, put a small (1rem) `error` `v-icon` in `--theme--danger` before it, with a tooltip "N errors". Use `<value-null />` (global) for null values.

## 11. Empty states

| Where | What |
|---|---|
| Canvas, edit | `v-info` icon `account_tree`, "Empty Graph", "Drag a node type onto the canvas to start, or click one to add it to the middle." |
| Canvas, read-only | `v-info` icon `account_tree`, "Empty Graph", "This graph has no nodes." |
| Inspector, nothing selected | ruleset summary and help (§9.5) |
| Issues | one "No issues" row with a success icon |
| Palette | `v-notice` "This ruleset has no node types to add." |
| Field row | placeholder text and `add` (§10.2) |
| Card summary value | left out when empty (§5.4) |

## 12. Light and dark

Nothing in the editor branches on the theme; both modes come from the tokens. These checks matter, with values from the default themes:

- The grid dot (`#e4eaf1` on `#fff`, `#21262e` on `#0d1117`) is meant to be faint, as in Flows.
- The card frame in edit mode (`#e4eaf1` / `#21262e`) is low-contrast by design (it is the Flows tile). Selection, errors and hover are what must stand out, and they do: primary, `#e35169` and `#d3dae4` / `#30363d`.
- Soft issue colours: the error badge is `#e35169` on `#fceef0` / `#22171f`, and the warning badge `#ffa439` on `#fff6eb` / `#25201a`. Directus uses these same pairs for `.danger.rounded` and `.warning.rounded` buttons.
- The selected halo is primary at 20% over the canvas (lavender in light mode, deep violet in dark).
- The edge default `--theme--foreground-subdued` is `#a2b5cd` / `#666672`, visible on both backgrounds without competing with coloured edges.
- Custom themes: the editor follows them automatically. Check by setting a theme override such as a different `borderRadius` or `primary` in Settings → Appearance: cards, handles, chips and the selected halo must all follow.

## 13. Vue Flow theming

The library-specific CSS is `src/canvas/directus-theme.css`. Every selector in it starts at `.node-graph-editor .ng-vueflow` (the canvas root inside the editor body), so nothing there can match outside an open editor. The shared `theme.css` is imported once by the shell (`NodeGraphInterface.vue`) and by the display. The rule: **the library's default theme is removed, not layered under.**

### 13.1 Vue Flow 1.48.2

**Imported:** only `@vue-flow/core/dist/style.css`, which is structural (positions, layers, pointer events) plus a few hard-coded colours that `directus-theme.css` replaces. **Not imported:** `@vue-flow/core/dist/theme-default.css`, which sets light-only `--vf-*` on `:root`, the default `.vue-flow__node-default/-input/-output` cards (#0041d0 / #1a192b / #ff0072 borders), a blue `rgba(0, 89, 220, …)` selection, a white `.vue-flow__edge-textbg` and 6px #555 handles. `@vue-flow/controls` is not used (the header has the buttons), nor `@vue-flow/background` (`.ng-grid` replaces it).

**Data flow.** Vue Flow's store holds as little as possible: one node per document node (id, position, accessible name) and one edge per drawable document edge (id, endpoints). The node and edge components read everything they show (type, title, summary, ports, issues, selection) from the graph document through a context the canvas provides (`src/canvas/context.ts`), so nothing lives only in the library's model. The canvas turns Vue Flow's drag, connect, edge-update, selection and viewport events into the shell's commands, and reconciles the store incrementally when the document changes.

**Mapping onto the shared classes:**

- Another extension on the same page may import `theme-default.css` globally, so the variables it would set are pinned on `.node-graph-editor .ng-vueflow .vue-flow` anyway: `--vf-node-bg: var(--ng-node-background); --vf-node-text: var(--ng-node-foreground); --vf-connection-path: var(--ng-edge-color-default); --vf-handle: var(--ng-port-color-any); --vf-node-color: var(--ng-node-border-color); --vf-box-shadow: var(--ng-node-border-color-selected);` with `background: transparent`, so the `.ng-grid` layer underneath shows through.
- Cards: one custom node type, `ng-node` (`NodeCard.vue`), used by every node, so no `.vue-flow__node-default` rule ever matches. The `.vue-flow__node-ng-node` wrapper stays unstyled (`padding: 0; border: 0; background: transparent; box-shadow: none`) and shows the card's cursor. Vue Flow focuses the wrapper; `theme.css` draws the ring on the card through `:focus-visible > .ng-node`.
- Handles: one `<Handle class="ng-handle">` per resolved port, rendered as siblings of the card. Vue Flow positions them (`.vue-flow__handle-left|right`, `top: 50%` and a −50% translate); `NodeCard` overrides only the offset along the edge (`top: 72 + 18·i px`, or `left` for top and bottom ports), and `.ng-handle` resets Vue Flow's 5px minimum size. Handles sit at `z-index: 1`.
- Handle states come from the canvas's own `canConnect()` verdicts (§6.2), not from Vue Flow's `connecting` and `valid` classes: Vue Flow toggles those on the DOM for edge-end drags too, where it never validates. Every `Handle` gets the canvas's `is-valid-connection`, which answers from the same verdicts, so an invalid port is never snapped to; releasing on one emits no `connect`, and the canvas explains the refusal through the shell's toast (Vue Flow emits `connectEnd` before it clears `connectionEndHandle`, so the port under the pointer is still known).
- Edges: one custom edge type, `ng-edge` (`EdgePath.vue`), which renders the `.ng-edge` group with `getBezierPath`, `getSmoothStepPath({ borderRadius: 10 })` or `getStraightPath`. It never uses `BaseEdge`, `EdgeText` or the `vue-flow__edge-path` class (style.css paints those `#b1b1b7` at 1px, and `#555` when selected), and no `<marker>` defs. Vue Flow passes `targetX` at the target handle's outer edge, so the line and chevron tip end 2px before it. Selected edges are kept last in the store, so they paint above other edges but still under every card (Vue Flow draws each edge in its own SVG before the nodes layer; raising an edge's z-index would lift it over unselected cards).
- Labels go through `<EdgeLabelRenderer>` as `.ng-edge-label`, with `nodrag nopan` so a click on the pill neither drags nor pans; clicking it selects the edge.
- Connection line: the `#connection-line` slot renders `.ng-connection` (`ConnectionPath.vue`). Its valid and invalid states also come from the canvas's verdicts: while an edge end is moved, Vue Flow's own `connectionStatus` only consults the store-level validator, which this canvas never sets (below).
- Selection: `.vue-flow__selection` and `.vue-flow__nodesselection-rect` get the selection box look (§8.1); style.css gives them no colours once theme-default is gone.
- Edge updaters (`.vue-flow__edgeupdater`, the invisible circles at both ends of an edge) use `cursor: move` and are hidden in read-only mode. While a connection is drawn the empty pane shows `crosshair`, as the handles do.
- Minimap: `@vue-flow/minimap` with `class="ng-minimap"`, `:width="200"`, `:height="135"`, `node-color="var(--ng-minimap-node)"`, `node-stroke-color="transparent"`, `:node-border-radius="4"`, a node class function that adds `ng-minimap__node--selected`, and `mask-color="var(--ng-minimap-mask)"`. `var()` in SVG presentation attributes works; Directus does it in `interfaces/_system/system-theme/theme-preview.vue:24-30`. The package's stylesheet is not imported: it only adds a hard-coded `#fff` background and the pan cursors, and the package declares `"sideEffects": false`, so the extensions SDK build would drop a plain CSS import of it anyway. `directus-theme.css` reproduces the cursors, takes the panel's 15px margin away, places the minimap 0.6875rem from the corner and sets the popover background.
- Keyframes `dashdraw` from style.css are global but harmless. `.vue-flow__panel` is not used for the shell's overlays (it adds a 15px margin); they are the `.ng-canvas-*` overlays.

**Library facts the canvas works around:**

- The store-level `isValidConnection` is never set: Vue Flow runs it on every edge passed to `setEdges` / `addEdges` and silently drops the ones it rejects, which would lose stored edges that break a rule. Validation happens per handle while drawing instead.
- Vue Flow's keyboard handling is off (`delete-key-code`, `zoom-activation-key-code` and `pan-activation-key-code` null, `disable-keyboard-a11y`): it listens for its keys on `document`, so Backspace in another drawer would delete the selection. The shell owns the keyboard; Enter or Space on a focused card or edge selects it, and the arrow keys move the selected cards one grid step, as commands.
- Edges whose source or target node is missing cannot be drawn (Vue Flow renders nothing for them). They are left out of the store, stay in the document and are listed in the issues panel (`dangling_edge`). If two elements share an id, only the first is drawn. Edges to undeclared ports are drawn to placeholder handles.
- With snap to grid on, Vue Flow snaps every node when its wrapper mounts, so a stored off-grid position would be drawn somewhere the document does not say. The canvas puts the document's positions back; the next drag snaps the node for real, through a command.
- Vue Flow measures handle bounds when a node's size changes and when a handle mounts, but never drops the bounds of a removed handle or re-measures handles that moved without a size change. When a node's ports change (a repeater branch added, a placeholder appearing), the card calls `updateNodeInternals`.
- Vue Flow builds `[data-id="…"]` attribute selectors from node and handle ids while a connection is drawn, and document ids and port keys are free text. Every id handed to Vue Flow goes through `encodeURIComponent` (a bijection that leaves the generated ids and ordinary port keys unchanged), so a quote in an id cannot break `querySelector` mid-drag.
- There is no API to cancel a connection in progress. On Escape the canvas ends the line (`endConnection`) and ignores the `connect` or `edgeUpdate` Vue Flow may still emit on release. During an edge-end drag Vue Flow keeps the original edge hidden until the mouse button is released.
- Vue Flow's error hook only warns in development builds; the canvas logs its errors to the console.
- Each mounted canvas has its own Vue Flow store, keyed by the editor's instance id plus a mount counter, so two graph fields on one page, or a quick close and reopen, never share one.
- The minimap package adds about 54 KB to the app bundle even when no field turns the minimap on, because the SDK inlines everything.

## 14. Review checklist

Run these against the canvas, with screenshots in light and dark, edit and read-only:

1. In DevTools, no computed colour on any editor element comes from anything but a `--theme--*` variable. Nothing is `#fff`, `#555` or `#b1b1b7`, and no Vue Flow default theme colour shows.
2. A snapped card's corners sit on grid dots; two cards on the same row give a perfectly straight edge; card heights follow §5.1.
3. Handles: free ones are rings, connected ones show ring + dot, and free handles are hidden in read-only mode.
4. Edges are 2px with an open chevron that stops short of the target ring, rounded 10px corners on step edges, and pass under cards.
5. Selected cards show the primary frame and soft halo; errors show a danger frame and badge; deprecated and unknown cards are dashed.
6. The dots fade out in read-only mode; the canvas never scrolls the drawer; the palette never shows outside the drawer sidebar.
7. Switching the user's appearance between light and dark, or changing the project colour, restyles the open editor without a reload.

## 15. Options form

The field's interface options (Data Model → field → Interface) are a custom options component, `src/shared/options-editor/NodeGraphOptions.vue`, built only from stock parts so it reads as part of the field settings drawer. Its CSS is `options-editor.css`; every rule starts at one of its roots: `.node-graph-options` (the options), `.node-graph-options-json` (the JSON drawer body) and `.node-graph-options-menu` (the Load Example menu), because the drawer and the menu are teleported.

| Piece | Imitates | Source |
|---|---|---|
| Root layout | The `form-grid` mixin, in plain CSS: two columns, `--theme--form--row-gap` and `--theme--form--column-gap`, a size container | `styles/mixins/_form-grid.scss` |
| Plain options | A `v-form` over the option fields, as Directus renders an options array (edit dots on values that are set, as in stock options) | `field-detail/shared/extension-options.vue:80-89` |
| Status | `v-notice`: `success` "Valid ruleset: …", `danger` with a `#title` and the problems in a monospace list (`multiline indent-content`, the field row's notice spacing), `info` without a ruleset, `warning` for entries not stored as entered | `components/v-notice.vue`, §10.2 |
| Ruleset actions | Small `secondary` `v-button`s with a left icon, 0.6875rem under the notices, as a Repeater's actions row sits under its list; Load Example opens a `v-menu` list with a description per example | `styles/mixins/_list-interface.scss` `list-interface-actions` |
| Sections | `group-detail` fields (large divider title with a header icon, chevron, edit dot when collapsed with values); Ruleset, Data Types, Node Types and Edge Types start open, the rule sections closed | `interfaces/group-detail/group-detail.vue` |
| Lists | The stock Repeater (`list`) with its primary "Add …" button, row template, drawers and discard dialog | `interfaces/list/list.vue` |
| Field definitions | The stock Repeater's "Edit Fields": the same field set and pickers (`system-interface`, `system-interface-options`, `system-display`, `system-display-options`) in "Interface Options" and "Display Options" groups | `interfaces/list/options.vue:42-208` |
| Explanations | `presentation-notice` fields and field notes (`type-note`, markdown with code for tokens) | `interfaces/presentation-notice` |
| JSON editor | A stock `v-drawer` (icon `data_object`) with header action buttons (Copy, Download, then the primary Apply), the content padding of a Repeater item drawer, notices, and the `input-code` interface in JSON mode with line numbers and wrapping | `interfaces/list/list.vue:351-354`, `interfaces/input-code` |
| Confirmations | `v-dialog` + `v-card`, `secondary` Cancel then the primary action ("Replace", "Discard Changes") | §9.7 |

Copy is plain English in Title Case for buttons and dialog titles, sentence case elsewhere; Directus keys are reused where they match (`apply`, `cancel`, `copy`, `unsaved_changes`, `discard_changes`, `keep_editing`, and the field names of "Edit Fields"). Boolean labels are short ("Allow cycles"), because the checkbox row truncates at half width; the explanation goes in the note.
