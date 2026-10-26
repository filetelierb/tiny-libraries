# Design system

## Visual language

A warm ivory workspace, near-white paper surfaces, dark blue-gray text, deep teal actions and a restrained amber accent. The reading surface remains quiet; controls are compact and reveal supporting panels on demand. Media sits on a dark blue-green stage. No global header: the resource tab strip is the workspace's top edge.

## Tokens and primitives

`src/design/tokens.css` is the source of truth. Use semantic colors, 4px spacing increments, 0.7rem base radius, thin borders, soft paper shadows, system sans-serif typography and monospaced locators. Bundle no remote fonts. Primary teal is reserved for actions, selection and links; amber identifies folders and highlights.

Primitives: Button (default/primary/ghost/danger), IconButton with required accessible label, Badge, Empty, and native-dialog Modal with focus containment and Escape support. Feature components consume tokens rather than hardcode additional palettes.

## Layout and interaction

- Desktop: optional 300px library, flexible viewer, optional 350px study panel. Resource tabs remain scrollable; split view has two equal columns.
- Tablet/mobile: panels become dismissible overlays, controls remain at least 40px high, inputs 16px, split view stacks vertically.
- Active file/tab/panel state is explicit. Use teal backgrounds for selection and text plus icons for statuses; color alone must never carry meaning.
- Keyboard-visible focus uses a 2px ring. Respect reduced motion. Long filenames truncate visually while retaining titles and accessible names.
- Dialogs communicate local persistence and remote AI use. First launch offers a credential form and an option to explore the library without running AI.
- English and Spanish strings share a typed dictionary; language persists and updates the document language.
