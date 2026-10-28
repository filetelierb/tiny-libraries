# Design system

## Visual language

A formal academic workspace with warm ivory backgrounds, near-white paper, dark blue-gray text and deep teal actions. Serif typography runs through the catalog, reading surface, study tools and dialogs. Amber identifies folders. Media sits on a dark blue-green stage. No global header: the resource tab strip is the workspace's top edge.

## Tokens and primitives

`src/design/tokens.css` is the source of truth. Use semantic colors, 4px spacing increments, thin borders and soft shadows confined to floating controls and overlays. Use the system Times New Roman/Times serif stack for body text: 16px body, 14px controls, 12px secondary labels, and 17px long-form reading text. Dialog, card and sheet titles use Geist (`--font-heading`) at 16px/500; locators and code use Geist Mono (`--font-mono`). Both load from Google Fonts, the only remote origins the content security policy allows, with system sans and monospace fallbacks when offline. Primary teal is reserved for actions, selection and links.

Buttons use outlined pill shapes; reader actions share one capsule with a separate focus action. Resource tabs have rounded paper tops. Reviewed files use a teal outline check-circle. Context menus use leading outline icons, soft amber hover states and a clear grouping rule. Reading surfaces remain plain, without a decorative grid or promotional empty-state slogan.

Primitives: Button (default/primary/ghost/danger), IconButton with required accessible label, Badge, Empty, and native-dialog Modal with focus containment and Escape support. Feature components consume tokens rather than hardcode additional palettes.

### Files

- `src/design/tokens.css`: every value with a name. Colors (semantic, success, amber, paper and the media stage), the type scale (`--font-size-2xs` 10px through `--font-size-heading` 20px) and weights, radii (`--radius-2xs` 2px to `--radius-pill`), shadows (`--shadow-xs` to `--shadow-2xl`, plus `--paper-shadow`; `--ink-rgb` and `--shadow-rgb` for tinted variants) and the layer order (`--z-*`).
- `src/design/components.css`: styles of the primitives and shared patterns: buttons, icon buttons, badges, search fields, segmented controls, action menus, dialogs, empty, loading and recovery states.
- `src/styles.css`: feature layout and styles, written with those tokens. A few one-off sizes remain literal (9px marker labels, 12.5–12.8px compact controls and large display numbers).

New UI uses tokens and primitives first; add a token when a value repeats, and keep the `--z-*` list as the single place that orders layers.

## Layout and interaction

- Desktop: independently pinned library and study panels with persisted, bounded widths. Separators support pointer and keyboard resizing. Resource tabs remain scrollable; each split tab saves its own ratio and focused source.
- Below 1024px, a split-source selector shows one mounted viewer at full width and pauses hidden media. Side panels become dismissible overlays; inputs remain 16px.
- Active file/tab/panel state is explicit. Use teal backgrounds for selection and text plus icons for statuses; color alone must never carry meaning.
- Study tools share one horizontal text-tab strip. Overflow scrolls; arrows and Home/End move selection and focus. All eight tools remain available. Empty reading space offers file exploration and the study panel; sample material is available under Add files.
- The shared reader toolbar names its target source. Clicking/focusing a pane or using the target selector changes its bookmark, note, tutor, reviewed and download actions. Pane focus never changes the other source's position.
- One directory tree serves catalog management, resource selection and upload destinations. Empty folders persist. Menu surfaces sit outside the scrolling tree, stay within viewport bounds, support arrow/Home/End navigation and return focus on Escape.
- Keyboard-visible focus uses a 2px ring. Respect reduced motion. Long filenames truncate visually while retaining titles and accessible names.
- Dialogs communicate local persistence and remote AI use. First launch offers a credential form and an option to explore the library without running AI.
- English and Spanish strings share a typed dictionary; language persists and updates the document language.
