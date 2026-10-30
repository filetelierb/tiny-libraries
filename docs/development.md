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

### Captions in short cues, chat diagrams that fit the panel

- **Captions.** A transcribed turn can run for a minute, and each turn was one cue, so a whole paragraph covered the video. Turns are now split into cues of about two lines (84 characters), keeping words whole and closing a cue at a sentence end once it is half full; each cue gets a share of the turn's time in proportion to its length. New captions are written this way, and the player splits the long cues of captions prepared earlier when a track loads. The player now listens for the track's native load event, which React does not report, so the chosen track is also the only one shown once its cues arrive.
- **Diagrams in chat.** The flow toolbar wraps: the "Select a node to explore" hint moves under the buttons instead of being squeezed to one letter per line by chat text that breaks anywhere. A left-to-right flowchart that would show below 75 % of its size is redrawn top to bottom for the panel; the expanded view and the source shown underneath keep the original direction.

Verification: unit tests cover cue length, contiguous timing, sentence ends, VTT and SRT numbering, and the flowchart direction rewrite; 284 tests, type checks, formatting and build pass. In the browser, the lecture's original track went from 255 cues of up to 1,850 characters to 720 cues of at most 84, with only the chosen track showing. A five-node left-to-right flowchart in a 240-pixel panel went from a 225 × 49 image to a top-to-bottom drawing at 225 × 359, with the hint on its own line.

### The tutor as a Muse Code agent

Each tutor reply can now run as one Muse Code turn instead of a loop of direct model calls:

- **Host.** The local companion starts a `muse serve` process per reply with Spark or Wonder and the effort chosen for the question (Automatic uses medium). The Meta key reaches that process only through its environment; it runs in its own empty folder and home, with shell, file writes, web tools, delegation, background reminders and automatic updates off. Its tools are limited to the tutor's library tools.
- **Tools.** The Worker serves the tutor's existing tools to that process as a small MCP endpoint for the reply's current model step, authorised by a token derived from the companion secret. Every call runs against the reply's saved checkpoint, one at a time with the reply's own steps, so a passage counts as citable only once the agent has read it, and bookmarks, artifacts and concepts keep the same limits and stop checks. Read tools are marked read-only; writes are approved only for the library tools.
- **Reply.** The agent's working remarks stream as progress and are replaced by its final answer, which is saved like any other reply, with citations to what it read and the tools it used. Stop ends the process and keeps the partial text; a steering instruction starts a new agent turn that sees the work already done.
- **Fallback.** Without a matching `muse` installation, or when Web is on (the agent does not offer Meta's hosted search), the companion uses the direct model stream as before.

The unused code-session routes and the trial agent libraries were removed.

Verification: unit tests cover the agent's input (instructions, conversation, question and images), relayed progress and the final answer, Stop, the fallbacks, and an agent calling the tools during its model step with citations limited to what it read; 289 tests, type checks and build pass. In the browser, Spark answered a question across the course reader, the lecture and the glossary in 21 seconds, citing two book pages and a saved concept, and said plainly that the lecture passages did not cover it.

### Upload destination as a path

The Add files dialog shows the destination as a folder path with a Change button. The folder tree opens only when no folder was given (Add files from the library header) or after Change; choosing a folder or the library root closes it again. Opening the dialog from a folder's menu shows that folder directly. Folder menus inside the picker keep creating, renaming, archiving and deleting, but no longer offer Add files.

Verification: type checks, 289 tests and build pass. In the browser, the header's Add files opened the tree, choosing Directory verified/Week 1/Sources closed it to that path, Change reopened it with the folder selected, the picker's folder menu had no Add files, and Add files from the EE261 folder menu opened directly on EE261.

### Concepts: the whole glossary, the web, and a glossary that follows the conversation

Live tests of the Muse Code tutor showed that it only saw the concepts of the files selected for a question, could not search the web, and could save a concept only on request and only with a passage from the library. Now:

- **Glossary search.** A read-only `search_glossary` tool searches the whole glossary by name, alias and linked synonyms and returns each meaning with its review state, evidence and links. Concepts it returns can be cited.
- **Web search when the library falls short.** Settings has "Let the tutor search the web", on by default. The agent may then use Meta's hosted web search when the selected references and the glossary do not cover a question, and puts library material and external sources under separate headings with visible links. The Web button still asks for a search on one question. The direct engine (without Muse Code) only searches when Web is on. This replaces the earlier per-question-only rule.
- **A glossary that follows what the tutor explains.** `save_concept` creates a concept that is missing, refines an unreviewed meaning the question showed to be incomplete, adds a meaning when the term is used in another sense, or attaches passages or links to an existing meaning; otherwise the glossary is left as it is. Reviewed meanings keep their definition, a name already in the glossary is never created twice, edits check the concept's version, and a retried call repeats its change instead of applying it twice. Each meaning written by the tutor records what it rests on (the library, web pages or general knowledge) and its links, shown under the definition in the glossary. Library refusals reach the agent as tool errors it can correct.
- **Labels.** The chat names the glossary tools in "Tools used"; the two separate label lists became one.

Verification: unit tests cover creating, refining, extending and linking concepts, duplicate names, stale versions and reviewed meanings, and the direct stream receiving only model fields; 290 tests, type checks and build pass. In the browser with Spark: "what is aliasing" found the existing concept, cited it and left it unchanged; "what is a wavelet transform" answered from the course first, searched the web, kept "From your library" and "External sources" apart and created the concept with its web link (35 s); a follow-up on moiré in photography explained it as the visible effect of spatial aliasing and created "Moiré" (46 s).

### Artifacts the tutor writes

Asking the tutor for study material (a guide, a summary, a review sheet) now creates a library file instead of a long chat answer:

- **Tool.** `create_artifact` takes the request restated in full, a goal (understand, summarize, review, exam), a length, the student's language and the selected references it draws on. The tutor replies in a sentence; the artifact is written after the reply. Asking to change an artifact the conversation started writes a new version of the same file. `save_artifact` stays for rewriting the guide that came with a prepared source.
- **Generation in stages.** A plan (title, guiding question, introduction, two to seven chapters with objectives, key ideas, widgets and supporting passages), then every chapter in parallel, then a check of each chapter (one heading, enough prose, valid widgets, only supplied passage ids) with one repair round, then assembly. Inline citations become numbered links to a reference list that names each passage's file, page or time. Passages come from the whole of each file, within a shared budget.
- **Durable.** Each stage is saved in the library; a generation whose runner stopped is resumed by the next status request after its lease expires, and a failed one continues from its saved chapters on Retry. A retried tool call returns the generation it already started.
- **A file of its own.** The result is `Title.artifact` in an Artifacts folder, kind `artifact`; every version is kept. It opens in its own reader with the guiding question, widgets, citations that open the cited passage in its file, a version selector, the Markdown source and download. The Artifacts list shows it with the tutor's label. Artifact files are not prepared.
- **In the chat.** The reply shows a card with the stage and the chapters written, then Open; on failure, the error and Retry.

Verification: unit tests cover the passage budget, chapter checks, citation numbering, the stages with a repair, idempotent starts, an unprepared source, retry after a failure and lease takeover; 297 tests, type checks and build pass. In the browser with Spark on the first EE261 lecture: a first request for a guide was answered in the chat, so the tutor's instructions now send requests for study material to the tool. "Save that study guide as an artifact" started a three-chapter artifact, ready in 52 seconds, with 24 citations to 20 lecture passages and 3 widgets; it said plainly that the lecture does not cover sampling. "Make a new version in Spanish with a self-assessment section" wrote version 2 of the same file in 35 seconds; the selector showed version 1 with its banner. The artifact was first written in the app language, so the tool now carries the student's language.

### The tutor manages the library

The tutor can now act on the library when the student asks, through the same routes as the app:

- **Finding records.** `browse_library` lists every folder and file with its id, folder, state and whether it is prepared (metadata only; contents stay limited to the selected references). `list_notes` lists the notes or bookmarks of the conversation's study session.
- **Acting.** `manage_files` creates folders and renames, moves, archives or restores files and folders (a renamed file keeps its extension). `manage_notes` creates notes and bookmarks (Markdown becomes the note's headings, lists, emphasis and math; a passage the tutor read anchors it to its place; citation ids are removed), edits and deletes them. `merge_concepts` merges two glossary concepts. `start_test` starts a test in the session from prepared files, with guidance written from the conversation.
- **Confirmation.** Moving to the trash, deleting and merging are only proposed: a card under the reply names the change, and nothing happens until the student confirms; Cancel discards it. A confirmed deletion also removes the file's stored content, as the app does.
- **Log.** Each reply lists what it changed under the answer; a started test has an Open test button. A repeated call returns what the first did, actions stop when the reply is stopped or redirected, and refusals from the library (a session with an unfinished test, a folder in the trash) come back to the tutor to explain.

Verification: unit tests cover the Markdown conversion, actions through the library routes with the names shown, proposals confirmed or cancelled once, notes limited to the session, starting a test and the agent's validation of tool calls; 304 tests, type checks and build pass. In the browser with Spark: "create a Repaso folder in EE261, move the study guide there and create an empty Prueba tutor folder" did the three actions and the tree updated; "save a note summarising lambda nu = v in three points and delete the Prueba tutor folder" saved an anchored note with a list and math, and proposed the trash, which ran on Confirm. The first note kept the chat's citation ids, which notes now drop. "Start a 12-question test" in a session that already had an unfinished test was refused by the app, and the tutor said so and what to do.

### One way of explaining comparisons

The tutor's plain comparisons worked well, so the method is now shared by the chat, artifacts and glossary (`shared/explanation-style.ts`):

- **Explanations.** Plain language, purpose before mechanics, every term and symbol defined in words. Concepts that are compared or easily confused get: what they have in common and the single difference that separates them; one entry per concept with the same points in the same order (when it applies, what it shows, what you obtain when you compute or use it); and a short analogy or one-line rule for telling them apart.
- **Artifacts.** The plan and every chapter follow the same method; a comparison may put the entries in a compare widget and the analogy in an analogy callout.
- **Glossary.** Definitions stay one to three sentences, and a concept usually understood against another adds one sentence naming it and the difference. Definitions written while preparing a file name a counterpart only when the file discusses it.

Verification: tests check that the tutor's instructions, artifact plans and chapters carry the method; 306 tests and type checks pass. In the browser, "what is the difference between the Fourier series and the Fourier transform?" was answered with the shared purpose and the single difference (periodic or not), parallel entries for each with their formulas and symbols explained, and a rule with an image (a staircase of frequencies that becomes a ramp as the period grows).

### Local runtime: wrangler instead of celld

The app had become slow and unreliable to start. celld kept every superseded storage epoch by default and rebuilt the library from that history on start: the local state had grown to 2.7 GB (0.9 GB of library history across 49 epochs, 0.85 GB of stored files, 0.33 GB of old deployments), the node often missed its own start-up deadline, and the library then took 10 to 15 minutes to answer. The Worker code uses only standard Workers APIs, so the launcher now runs Cloudflare's local runtime (`wrangler dev`, already a project dependency) instead:

- The app answers within a second of starting; its state lives in `.wrangler/state/` as plain SQLite files and stored objects.
- The launcher keeps the media companion running and starts the runtime again if it stops unexpectedly, at most five times in ten minutes.
- No separate runtime installation is needed. The owner chose to start with an empty library, and the old celld data was deleted.

Verification: type checks and 306 tests pass. On `wrangler dev`: uploads of a note and a video, folders, the catalog, video range requests (206 with the requested bytes), a session and a note, and a permanent delete that also removed the stored content all worked; data persisted across a restart; killing the runtime brought it back in a second with the companion still answering. Preparing files and the tutor need the Meta key to be entered again in Settings.

### Setting up a test in steps

The test setup was one long form. It is now four steps with a progress bar at the top, so each screen asks one thing:

- **Material.** Studied files and saved evidence, with the same limits as before (40 files; 6 snapshots, 48 images and 12 MB). The other steps unlock once at least one file or snapshot is chosen, and the footer says so until then.
- **Focus.** What to stress, and earlier reports whose uncertain answers the test should revisit.
- **Format.** Number of questions as a row of choices, and difficulty as four cards that say what each level changes (how blanks are answered, how many pairs a matching question has).
- **Review.** A summary of the choices, each with Edit to jump back, the note on what is sent to Meta, and Prepare assessment.

Choices are still saved per session, a follow-up from a report opens directly on Review, and New starts again from Material. The dialog keeps one height so it does not jump between steps.

Verification: type checks and 306 tests pass. In the browser, the steps stay locked with no prepared file; with the check lifted temporarily, Focus, Format (selected count and difficulty highlighted) and Review (summary, Edit links, missing key notice, disabled Prepare) were checked, then the check was restored.

### Completing sentences from a word bank

Completing a sentence had three forms: radio choices, a selector in the blank, and, for hard questions, typing a term copied from a list, which asked for the same thing as the selector with more effort. All three are now one interaction:

- **Question.** A sentence or short passage with one to three blanks and a word bank: the right word for each blank plus distractors that fit the sentence but are wrong. Easy has one blank and three distractors, medium two blanks and two distractors, hard two or three blanks and three distractors. The model returns the word for each blank in order (`blankAnswers`), which stays private until grading like other solutions.
- **Answering.** Clicking a word fills the next empty blank, or the blank clicked first. Words can be dragged onto a blank, between blanks (the two swap) or back to the bank. A filled blank shows the word with an × to send it back. Empty blanks have a standard width and grow with the word placed in them. Used words stay in the bank, dimmed.
- **Grading.** Each blank counts: two of three right scores two thirds. The report shows the sentence as completed and as it should read, with the placed words in brackets.

Verification: type checks and 307 tests pass, including a new test for blank counts per difficulty, one word per blank, partial answers, partial credit and the solution staying out of the public plan. In the browser, on a sample three-blank question mounted temporarily: clicking a word, choosing a blank and then a word, the ×, and drag events onto a blank, between blanks, back to the bank and onto a filled blank all gave the expected answer; an empty blank measured 126 px and grew to 331 px with a long term.

### Home page: projects and an activity graph

The app now opens on a home page instead of going straight into the library:

- **Projects.** Each project has its own library, sessions, notes, glossary, artifacts and tests. A project is a Durable Object of its own, so nothing is shared between projects except the app settings (the Meta key, language, model), which stay in the first library. The library that existed before projects is the first project, unchanged. Projects can be created and renamed from the home page; each card shows the files, sessions and the last activity, and opens the project at `/projects/<id>`. A Home button in the library panel goes back.
- **Routing.** The app names the open project in a header on every request. Links and media the browser loads by itself (videos, PDFs, downloads) carry it in a cookie, renewed when a tab comes back into view. Processing jobs, the media companion and tutor conversations remember the project they work in. An unknown project id is refused.
- **Activity.** A contribution-style graph shows one square per day for the last year across all projects, with the total, active days and current and longest streaks; hovering a day shows its count per project. Changes the student makes count (uploads, notes, folders, tutor questions, answers, tests); reads, polling, read-only queries, saved playback positions and settings do not. Days are the student's local days.

Verification: type checks and 311 tests pass, including tests for which requests count, the year of whole weeks, levels and streaks. Through the API: a new project starts empty with its own session and folders while the first library keeps its own; an unknown project is refused with 404 and a malformed one with 400; two changes counted on the right day and project, and a rename did not count. In the browser: the home page listed both projects with their counts and showed the day's activity with its tooltip; opening a project showed its empty library; a file uploaded there loaded through the cookie alone and was not found from the first library.

### Activity points: weighted interactions that count once a day

Counting every change treated saving a video position like finishing a test. The graph now scores a fixed list of interactions (`activityKinds` and `activityWeights` in `shared/projects.ts`), each counted once a day for the record it concerns:

| Interaction                                                                 | Counts                                                    | Points |
| --------------------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| Progress saved in a file (position, page, marked reviewed)                  | once a day per file                                       | 1      |
| Flashcard set gone through                                                  | once a day per set, after all its cards are reviewed      | 2      |
| Mini quiz completed (chapter quiz, artifact study questions, reinforcement) | once a day per quiz, after all its questions are answered | 3      |
| Test question answered                                                      | once a day per question                                   | 2      |
| Note, bookmark or concept added or edited                                   | once a day per record                                     | 2      |
| Question or decision for the tutor                                          | every time                                                | 2      |

The Worker classifies each successful request from its route (and, for a few routes, a field of its body such as the question or card); the library names the files whose saved position moved. The day's record keeps which interactions it has already counted, so repeats add nothing. Anything else, such as uploads, folders or renames, scores nothing. The home page shows points, the day's breakdown by interaction and project, and the list above under "How points are counted". Days are stored under a new key, so counts from the earlier rule are not mixed in.

Verification: type checks and 312 tests pass, including the classification of each interaction and once-a-day scoring across kinds and projects. Through the API: two position changes and marking the same file reviewed gave 1 point; an unchanged position, an upload, a folder and a rename gave none; marking a second file reviewed added 1. In the browser, the tooltip showed the points with "Progress saved in a file × 2" and the project, and the scoring list showed the six interactions.

A mini quiz and a flashcard set count as a whole rather than per question or card. With each answer or review, the library reports the quiz or set and how many questions or cards it has (`quizOf`, `deckSize`); the day's record keeps the ones done and adds the points when the last arrives. Saved positions travel the same way, so the library reports all of these in one `X-Activity` header. Verification: 313 tests pass, including a quiz that counts only on its third question and once after that, a set that counts on its second card, and a new day starting over; a position change on a new file still added 1 point through the header.

### The day's points instead of the explanation

Under the activity graph the home page now shows the points logged on a day: today by default, or any day chosen by clicking its square (arrow keys move between days). It lists each interaction with how many times it counted and its points, and the points per project. The scoring rules moved to a "How points are counted" dialog opened from below the graph.

Verification: type checks and 313 tests pass. In the browser, today's log showed 3 points from file progress in one project; clicking 27 October showed its 1 point, the down arrow moved to 28 October with "No points logged on this day", and the dialog listed the six interactions with their rules and points.

### Deleting a project

A project can be deleted from its card on the home page. A dialog says what will be lost (its files and sessions, notes, bookmarks, glossary, artifacts, flashcards, tests and tutor conversations, and its points) and asks for the project's name before deleting. The deletion clears everything the project holds:

- its stored objects: originals, captions, images, note captures, tutor attachments and conversation journals;
- the tutor conversations and processing jobs that belong to it;
- its library storage, then its points in every day of the activity log (a day only that project had is removed) and its entry in the project list.

The library is emptied first, so a deletion that fails part way leaves the project listed and can be repeated. The first library keeps the app settings, the project list and the activity log, so it cannot be deleted.

Verification: type checks and 314 tests pass, including a test that removes a project's points from a shared day and drops a day it had alone. Through the API, deleting a new project with a file, a session and a logged point removed the file's stored object (1 to 0), made the project unknown (404), dropped it from the list and lowered the day from 4 to 3 points; deleting the first library was refused (409). In the browser, the dialog kept the delete button disabled until the name was typed, and the project left the list.
