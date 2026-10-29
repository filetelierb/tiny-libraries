# Development record

Record actual implementation and validation as it lands. Commit dates remain actual dates. A new repository does not itself prove novelty; submissions must identify new contributions and exclude pre-existing material from claims of event work.

## 26 October 2026

- Reviewed participant guide, organizer Discord rules, questions and office hours.
- Defined Library surfaces and lifecycle contracts for the standalone implementation.
- Verified celld local-mode persistence and the separation between Muse Code SDK and Model API.
- Established product boundaries, priorities and acceptance criteria.
- Owner directed that development remain private until an explicit sharing decision. Repository visibility changed to private and verified.

### Implemented and verified

- Headerless English/Spanish workspace: local uploads, nested file paths, archive/restore, sessions, tabs, split viewing, media/PDF/text/image readers, notes, bookmarks and reviewed state.
- celld v0.6.3 with local originals and metadata, per-job durable processing, recovery checkpoints and a loopback-only Node companion for media and provider transport.
- ffmpeg conversion and chunking, actual-duration chunk offsets, timestamped video frames and visual PDF-page evidence. Original files remain intact.
- Meta structured study generation, original and translated VTT/SRT, validated source references, bounded assistant tools, single-choice scoring, explicit-rubric short-answer feedback, glossary conflict proposals and signal/comparison artifacts.
- Actual stop/start verification retained original SHA-256, archive/review flags, session tab, note, bookmark and position.
- Live Meta tests used authored sampling text and a short synthetic-speech recording. Text generated three chapters, three questions, four terms and a signal specification. Audio transcription and Spanish translation completed with matching cue identities and times. A later guide included both single-choice and short-answer questions; a short answer was evaluated with a rubric explanation.
- A live assistant response invoked `read_segments` and cited its selected source. Quiz solutions and private rubrics were absent from public learning responses.
- Browser checks covered the English/Spanish switch, desktop reading and a 390×844 layout. English and the default viewport were restored.
- 21 local tests passed, covering reference validation, hidden solutions, schema restrictions, ASR request shape/timing, translation identity checks, rubric ambiguity, glossary conflict preservation and real audio/video/PDF normalization.

### Runtime corrections

- The tested celld runtime rejected direct transfer of an R2-owned stream into outbound fetch. The companion now streams originals through a fixed loopback API path, with source/version checks.
- Provider transport runs in the companion. It uses bounded requests/responses, timeouts, a fixed Meta host and a local bearer credential; model keys remain backend-only.
- Meta strict output requires all schema properties and rejects `oneOf`. Required nullable fields and equivalent `anyOf` alternatives now match the observed API contract.
- `.local` is explicitly excluded from celld's watcher so normalized files do not cause application reloads during processing.

### Current limits

- This is a working local prototype, not a claim that every intended interaction is complete.
- The >10-minute local test uses a 611-second generated tone recording to verify real splitting and coherent offsets. The live speech test is short; multi-chunk ASR accuracy and recovery under all failure modes are not certified.
- The speech sample included a recognition repetition. No word-error-rate or general transcription-quality claim is made.
- Multi-user access and network exposure are outside the current local-only implementation.
- Generated-code execution, sandbox isolation, explicit miniapp publishing and a persistent published release remain conditional follow-up work. Muse Code SDK integration is present, but its live session path is unverified because the matching CLI is not installed.
- Final submission eligibility, public visibility, contributor listing, demo video and portal submission remain outstanding event tasks. Repository visibility stays private until the owner explicitly requests sharing.

### Directory and split workspace increment

- Added durable empty directories, nested creation, atomic subtree rename, inherited archive state and recoverable Trash. A shared directory tree serves the catalog, resource picker and upload destinations.
- Context menus escape scrolling bounds, retain keyboard/focus behavior inside nested dialogs, and remain clickable beside overlay scrollbars. Tree collapse state and a 121px scroll offset survived reload, including a hidden mobile drawer.
- Split tabs save independent ratios and focused sources. Pointer/keyboard resizing, equal-width reset, swapping, targeted replacement and narrow-screen source selection were verified. Hidden authored audio paused when switching panes.
- Notes, draft text, bookmarks and tutor actions target the focused source. A 4.5-second audio bookmark and a zero-position document bookmark retained their own source IDs. A live tutor reply used `read_segments`, cited its requested source and remained attached to it after focus/directory changes.
- All 38 tests, type checks, production build and diff checks passed. An actual runtime stop/start retained directories, file hashes, independent split ratios/focus, notes, bookmarks, positions, saved tutor history and configured credential status.
- Browser file attachment automation was unavailable under the existing Chrome extension permissions. Destination picker behavior was checked in the browser; actual upload transport, stable directory identity after rename, exact bytes, invalid paths and concurrent duplicate creation were verified through the local API.

### Tutor conversations and session controls

- Added independent durable conversations within sessions, explicit persistent source references, file mentions, title editing, source-linked Markdown replies and browser-retained drafts. Existing saved histories receive stable conversation identities without duplicating their messages.
- Live Meta/browser checks verified source-free study help, grounded source reads, clickable evidence, reference add/remove, keyboard mention selection, conversation creation/history switching and session renaming. A completed request ID returned the same two-message result; a parallel turn was rejected and a title edit made during generation survived.
- All 43 tests, type checks and production build passed. Full runtime stop/start retained five conversations/eight messages, sessions, directories, original file hashes and configured credential status. The browser restored the selected conversation and its unsent draft.
- Split entry and restoration now hide/unpin side panels while preserving widths, with explicit drawer reopening and pin controls.

### Media player controls

- Added shared audio/video controls with five-second buttons/keyboard seeking, every quarter-step playback speed from 0.25x to 4x, volume, captions and browser fullscreen. Bookmark markers seek to saved timestamps; chapter markers retain actual evidence intervals and use separate rows when those intervals overlap.
- Browser checks covered muted audio, an authored silent video, byte ranges, bookmark/chapter seeking, 2.25x/3.75x speeds, caption switching without position reset, fullscreen entry/exit, idle hiding and keyboard reveal. At 390px, controls stayed within the viewport and hidden-pane audio paused.
- Session switching now captures the current media position before unmount; the verified 5.741051-second position remained attached to the previous session. Browser reload restored source preferences, bookmarks and position.
- All 46 tests, type checks and production build passed. Physical touch gestures remain unverified; the configured browser automation exposes pointer/keyboard input only. Reduced motion disables the controls transition.

### Continuous PDF reader

- Added a locally bundled PDF.js reader with continuous pages, a selectable text layer, actual page counts, bounded previous/next/input navigation and independent per-document zoom preferences. Fit width, fit page and 25–300% zoom use each page’s dimensions. Raster rendering is limited to nearby pages with a bounded pixel budget.
- An authored three-page PDF with mixed portrait/landscape sizes passed browser checks for continuous scroll, page limits, native text selection, fit modes, 390px layout, viewport resizing and reload. A second document retained an independent 50% setting while the first restored fit-page/page two.
- Fixed responsive page tracking to use visible page coverage and retain the current page when the viewport changes. Bundled fonts, character maps, decoders, worker and licenses are served locally; the optional Vite UI proxies these assets to the local runtime.
- All 48 tests, type checks and production build passed. Selection-linked study actions and persisted page drawing remain separate reader work.

### Runtime shutdown

- Fixed a shutdown race that could leave the local celld node listening after its development supervisor exited. The launcher now sends the supervisor its graceful interrupt, isolates its process group, and keeps the companion available until the supervisor finishes. Repeated shutdown signals are idempotent.
- Verified Ctrl+C exits cleanly and releases both local ports. The following launch retained all eight original hashes, session/directory metadata, conversations and configured credential status.

### Source annotations and question context

Added independent revisioned annotations, structured rich text, local PNG captures, editable drawing strokes and PDF overlays. Existing text notes migrate with stable identities. Current/all-resource filters, source jumps, tutor-response conversion and recoverable annotation deletion are available in the study panel.

Verification: 54 tests, TypeScript and production build pass. Browser checks covered rich Markdown/table/list/link editing, saved page and video-frame captures, drawing undo, source filtering and Trash/restore. A clean runtime stop/start retained nine annotation records, three PNG hashes and eight original-file hashes. Real Meta calls answered selected PDF passages with scoped citations, both alongside persistent references and with none; the reference lists stayed unchanged. API checks rejected stale source context and preserved idempotent completed request replay. Advanced drawing/attachment tools and broader accessibility checks remain in progress.

### Shared source records and bookmarks

File annotations now remain available across study sessions while retaining creator provenance. An inline directory filter selects open session resources with per-file counts, all/none and search. Unbound notes stay in their creator session.

Added labeled personal bookmarks, edit, origin filters, count badges and recoverable Trash. Existing bookmark locators migrate with stable identities. A bounded Meta bookmark tool saves actual source-linked Suggested records on explicit requests; source/version checks and deterministic request/location identities protect writes. Annotation queries exclude bookmark records, and playback markers follow the bookmark origin filter.

Browser/API/live Meta checks verified cross-session editing, source jumps, checkbox filters, personal bookmark lifecycle, a saved Meta bookmark at PDF page two and exact playback seeking to 4.5 seconds. The active file’s count remains independent of filtering. Unit tests cover mixed-kind pagination, migration, source-bounded actions and the three-location write limit.

### Automatic concepts, origins and unlinked-concept clean-up

Removed the glossary suggestion review. Preparing a file now turns each of its glossary terms into a concept, or adds the file as a source of an existing concept with the same name or alias, without proposals. Files prepared earlier are processed once on the first glossary request. Concepts record their origin: added manually, added from the chat (a new `save_concept` tutor tool, used only on explicit request) or from file analysis; older entries infer theirs from whether they cite a file.

Permanently deleting a file or folder lists the concepts that cite only those files and deletes the checked ones in the same transaction. The glossary gains a creation filter and a "Not linked to any file" view: concepts that cite no existing file (archived and trashed files count) and are not connected through synonyms or relations to one that does. Clean up deletes them, with their history and the links other concepts kept to them.

Verification: unit tests cover one-time ingestion and origin tagging, linking without proposals, orphan detection through relations, concepts left behind by a delete, the clean-up route and link removal; type checks and build pass. The browser showed origin badges, the creation filter and the unlinked view on the local library.

### No Trash; a chat-first tutor panel

Deleting is now permanent. Files and folders are deleted from their menu after a confirmation that offers archiving instead and lists concepts that cite only them; the Trash section is gone. Annotations and bookmarks are deleted permanently too, annotations with their captures; their deleted views are gone. Records trashed before this change stay hidden.

The tutor panel drops the active-file row and its tools menu (chapters, practice and review still open from their own entry points) and the Tutor heading. The chat always shows; writing in it before any conversation exists starts a new conversation in the session with that message. History and New conversation float at the top right; History rows can be renamed.

Verification: 266 tests, type checks and build pass. In the browser, a message sent from the empty chat created a conversation in the session and received a cited reply, and History listed it.

### Long sources: split and overlap

Tested with a real course: Stanford EE261 (syllabus, formula sheet, problem set and solutions, lecture 1 transcript, the 428-page course reader and the 52-minute, 842 MB lecture 1 video).

- **Long documents.** PDFs may have up to 1,000 pages (was 100). A source longer than one analysis window (200,000 characters) is analysed in consecutive windows; each repeats the last two segments of the previous one as context, and chapters made only from that context are dropped. Each window is its own checkpointed job step, shown as `n/total` progress. A final outline call regroups the windows' sections into up to 12 chapters for the whole source; questions and glossary terms are taken from each window in turn, so practice and the glossary cover the whole source. Short sources keep the single call.
- **Recordings.** Up to 4 hours (was 60 minutes). The audio is extracted once and cut into chunks that own consecutive 5-minute spans and carry 20 seconds of each neighbour; each transcribed turn stays with the chunk that owns its midpoint, so speech at a boundary is neither cut nor repeated.
- **Translation.** A caption batch whose cue identities come back changed is retried in halves; a cue that still fails keeps its original text instead of failing the whole job. Lecture 1 had failed here before the study guide was written.

Verification: unit tests cover windows and overlap, context-only chapters, the outline merge (omitted, unknown and repeated sections, unique question ids, validation), overlapping audio chunk spans and turn ownership; 272 tests, type checks and build pass. The course reader produced 5 windows and an 8-chapter guide spanning pages 8–404 with 23 questions and 40 terms; the lecture produced 4 timed chapters and 255 caption cues. In the browser, the chapter sheet jumped to page 88 (transform pairs and duality), and the tutor answered a question across the reader and the lecture with page and timestamp citations.

### No focus view

Removed the reader's focus (expand) toggle: it only hid the library panel, which its own toggle already does. The library toggle now always shows, and opening the study panel follows the usual pinning rules.

### Simpler capture editor, review evidence after grading, one concept per name

- **Capture editor.** The toolbar keeps select, highlight, text, pen and arrow. Comment, eraser, redaction, mosaic, spotlight and crop are no longer created; objects of those kinds in earlier drawings still show and can be moved or deleted, and an earlier crop can be reset.
- **Review.** Questions no longer show their source evidence while you answer, since the quotes often contained the answer. Each question's evidence appears with its feedback in the graded report.
- **Glossary names.** Concepts are matched by a key that ignores case, accents, punctuation, plural endings and a trailing abbreviation spelled by the preceding initials, so "Linear operations" joins "Linear operation" and "discrete Fourier transform (DFT)" joins "Discrete Fourier Transform", keeping "DFT" as an alias. Existing concepts sharing a key were merged once into the one added by hand or reviewed, else the one with the most evidence; the others became forwarders, as with a manual merge. Analysis now asks for one singular, canonical name per concept and receives the glossary's existing names so it reuses them.

Verification: unit tests cover the key, abbreviations, ingestion of near-duplicate terms and the one-time merge; 275 tests, type checks and build pass. On the local library the glossary went from 89 to 87 concepts (the DFT and linear-operation pairs). Synonyms with different names, such as "Dirac delta" and "Delta function", remain separate and can be merged by hand.

### Glossary review loop and reconciliation with other files

Preparing a file now has a glossary stage after the study guide, run as checkpointed job steps:

- **Review loop, up to three rounds.** A review call merges candidates that name the same concept (synonyms, abbreviations, plurals, combined "X and Y" entries) under one usual name with aliases, drops notation, generic words and one-off examples, improves vague definitions from the candidates' own wording, and lists important concepts a chapter covers without a term. A fill call defines those from that chapter's segments, and the next round reviews again. The loop ends when nothing is missing, nothing new is defined, or after three reviews. A reviewed term keeps exactly the evidence of the candidates it came from.
- **Reconciliation.** Terms named like an existing concept are matched by name; for the others a call looks for an existing concept with the same meaning under another name. For each match, a decision call sees the concept's meanings with quotes from the files that already support them and chooses to attach the file to a meaning, refine an unreviewed meaning (only if the new definition stays true for those quotes), add a new meaning, or treat it as a different concept. When unsure it adds a meaning rather than rewriting one.
- **Safe application.** The plan travels with the study record. Reviewed meanings are never rewritten; a concept edited since the plan was made, or a new name already taken, falls back to joining concepts by name; every change is a glossary revision with history. A review that fails for a non-retryable reason publishes the terms reviewed so far, and the study guide never waits on the glossary beyond its retries.

The study-guide prompt now asks for glossary candidates that are concepts of the subject, in their usual singular name, rather than just "a glossary".

Verification: unit tests cover review merging and evidence, fill segments and citations, plan safety (reviewed meanings, unconfirmed synonyms, a different concept sharing a name), planned attach, refine and new meaning, the fallback for a changed concept, and the name index and context lookups; 280 tests, type checks and build pass. A short sampling note prepared on the local library produced 8 terms with no notation entries, attached its evidence to the existing Dirac delta, discrete delta, Shah function and aliasing concepts without rewriting them, and added Nyquist rate, bandlimited signal, sinc interpolation and anti-aliasing filter as new concepts.
