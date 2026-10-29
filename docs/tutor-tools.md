# Tutor tools: assessment and plan

Goal: let the student ask the tutor to manage every record in the library (files, folders, artifacts, annotations, bookmarks, glossary, sessions, tests) with the same safety the UI has. This document records what the tutor can do today, what is missing, and the plan.

## Today

The tutor is one agent loop (`worker/tutor-agent.ts`) driven by the durable runner (`worker/tutor-runner.ts`). Each model step can call tools; a reply has at most 20 model calls.

| Tool               | Kind  | Limits                                                                 |
| ------------------ | ----- | ---------------------------------------------------------------------- |
| `read_segments`    | Read  | Only the references selected for the question and its attachments      |
| `read_concepts`    | Read  | Only glossary revisions supplied in the question context               |
| `list_concepts`    | Read  | Same context                                                           |
| `practice_summary` | Read  | Practice statistics of the selected references                         |
| `create_bookmark`  | Write | Explicit request only; evidence must be available; up to 3 per reply   |
| `search_glossary`  | Read  | The whole glossary, by name, alias or synonym                          |
| `create_artifact`  | Write | Selected references as sources; generated after the reply; 2 per reply |
| `save_artifact`    | Write | Explicit request only; a selected source with an artifact; 1 per reply |
| `save_concept`     | Write | Create, refine, add a meaning or evidence; up to 5 per reply           |
| `browse_library`   | Read  | Metadata of every folder and file (ids, states, prepared); no contents |
| `list_notes`       | Read  | Notes or bookmarks of the conversation's study session                 |
| `manage_files`     | Write | Create folders; rename, move, archive, restore; trash and delete ¹     |
| `manage_notes`     | Write | Create, edit and delete ¹ notes and bookmarks of the session           |
| `merge_concepts`   | Write | Merge one concept into another ¹                                       |
| `start_test`       | Write | A test in the session from prepared files, with the tutor's guidance   |

¹ Proposed only: a card under the reply asks the student to confirm or cancel, and only the click runs it. The library tools share a limit of 12 actions per reply.

Writes go through internal Library routes (`/internal/tutor-*`) and run only while the turn is still active and not being steered, so a stopped or redirected reply never writes. Library actions (`worker/tutor-actions.ts`) call the same routes as the app, so its checks apply unchanged; each is recorded under the reply as a line of its action log, and a retried call returns what the first one did.

## Gaps by record

| Record                | The tutor can                 | Missing                                  |
| --------------------- | ----------------------------- | ---------------------------------------- |
| Files and folders     | List, organise, trash, delete | Prepare, upload                          |
| Artifacts             | Create, write a new version   | Read other versions, restore a version   |
| Annotations (notes)   | List, create, edit, delete    | Captures and drawings                    |
| Bookmarks             | List, create, edit, delete    |                                          |
| Glossary              | Search, create, refine, merge | Link, archive, delete, unlinked clean-up |
| Sessions and tabs     | Nothing                       | List, open files, rename                 |
| Tests, quizzes, cards | Statistics, start a test      | List, read results                       |

## Principles

1. **Library-wide reading is a decision, not a default.** Today the tutor sees only what the student selects. Managing records needs a metadata view of the whole library (names, folders, states, counts) while file contents stay scoped to selected references.
2. **Three kinds of tools.** Read tools run freely. Reversible writes (rename, move, archive, edit) run directly and record an undo entry. Destructive actions (deleting any record, concept clean-up) never run directly: the tool returns a pending action that the chat shows as a confirmation card, and only the student's click executes it.
3. **Same code paths as the UI.** Each tool calls the worker function behind the matching UI route (for example `deleteConcepts`, `orphanSnapshot`, `purgeTargets`), so validation, versions and transactions stay identical.
4. **Bounded and replay-safe.** Every write is idempotent per turn and request, limited per reply, and listed in an action log under the reply: what changed, with undo where possible.

## One tutor or specialised agents

- **One agent with every tool.** Simplest, but about forty tools would sit in every step's prompt, which costs tokens and makes wrong tool choices more likely.
- **Tool groups per turn.** The tutor keeps its read tools; a cheap intent check (or the student's mention of files, glossary, notes…) attaches only the matching group: Library, Glossary, Study records or Practice. It keeps one loop, one checkpoint format and the current runner.
- **Specialist sub-agents.** The tutor delegates a task to a Librarian, Glossary curator, Study records or Practice agent, each with its own prompt and small tool set, and gets back a summary and action log. This is best for multi-step jobs (reorganise a folder, curate a whole glossary). But every specialist must checkpoint inside the same durable turn and share its 20-call budget, which is the largest change to the runner.

**Recommendation:** start with tool groups. Measure wrong tool choices and step-budget exhaustion on real conversations. Move a group to a sub-agent only when its tasks need planning across many records; the Glossary curator is the likely first.

## Phases

0. **Done:** `save_concept` with chat origin; the unlinked-concept view and clean-up in the glossary UI.
1. **Glossary group and the shared infrastructure.** Confirmation cards, the action log with undo, and tools: `search_concepts`, `update_concept`, `link_concepts`, `merge_concepts`, `archive_concept`, `list_unlinked_concepts`, `clean_up_unlinked_concepts` (confirmation).
2. **Library group.** `search_library` (metadata), rename, move, archive, restore, prepare, and delete (confirmation, offering the concepts that cite only those files, as the UI does).
3. **Study records group.** Notes and bookmarks: list, create, edit, delete. Artifact versions: list, restore.
4. **Practice group.** Tests, quizzes and cards. Then decide on specialist sub-agents from the phase 1–3 measurements.

## Decisions for the owner

- May the tutor read metadata for the whole library without the student selecting references?
- Which actions need a confirmation card, and which may run directly with undo?
- Per-reply limits for each write kind.
- Whether specialists may use a cheaper model than the tutor.
