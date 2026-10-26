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
