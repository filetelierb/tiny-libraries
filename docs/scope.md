# Product scope

## Outcome

Import a recording and a companion document, study them side by side, navigate evidence-linked chapters, answer a mini quiz, and receive an interactive explanation grounded in observed answers. All library state is local; Meta performs requested inference remotely.

## Workspace inventory and decisions

| Surface     | Intended behavior                                                      | Standalone change                                                             |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Shell       | Full-height library, collapsible file and study panels                 | Remove global header, breadcrumbs, dashboard and course navigation            |
| Catalog     | Nested folders, normalized search, file-type icons, upload, rename     | Local files with stable UUIDs; no institution-specific taxonomy               |
| Lifecycle   | Archive/restore without losing notes, references or progress           | Preserve identity; no permanent-delete action in initial UI                   |
| Sessions    | Create, name, resume, multiple saved sessions                          | Persist tabs, active file, split file, location and notes per session         |
| Tabs        | Open, select, close, overflow, two resources side by side              | Preserve selection across reload; recover when source is archived             |
| Media       | Audio/video, seek, speed, captions, chapter navigation                 | Local range-serving and normalized chunked transcription                      |
| Documents   | PDF, text, Markdown, images                                            | Local originals; page/section/image locators, clear unsupported-format errors |
| Study tools | Notes, bookmarks, reviewed state, glossary                             | Explicit scope to selected files/session; no cross-course dependencies        |
| Chapters    | Evidence-linked explanations and mini quizzes                          | Validate citation IDs and source version before publication                   |
| Practice    | Deterministic multiple choice, short-answer rubric, immutable attempts | Hide solutions until submission; show evidence limits in review               |
| Artifacts   | Versioned comparisons, diagrams, signal explorer                       | Validated data specifications; no arbitrary script execution                  |
| Assistant   | Source-scoped explanation and tools, streamed progress                 | Meta model tool loop; chat supports the workflow                              |
| Settings    | Local credential setup, model choices, interface language              | Meta key add/replace/remove; English and Spanish                              |

## AI processing contract

1. Validate supported type and size, save immutable original, assign a source version.
2. Normalize video/audio with ffmpeg in a local companion process; mono PCM16 WAV, 16 kHz, chunks below the currently documented 10-minute/32 MB ASR caps. Product target: 60 minutes; validate actual bounds at runtime.
3. Persist each chunk, transcript and restored global timestamps before advancing. A restart reuses confirmed steps; retries never imply a failed network request incurred no charge.
4. Generate original-language VTT and SRT; translate to English or Spanish with stable cue IDs and timing.
5. Analyze text, PDF pages and visual evidence with Muse Spark; use Muse Wonder for more demanding synthesis. Generate structured chapters, questions and glossary candidates, validate all references, and retain the originating source version and model ID.
6. Publish independently useful partial results. Translation failure does not hide the transcript. Jobs support queued/running/partial/completed/failed/cancelled and explicit retry.
7. Record attempts, calculate scores in application code, and recommend reinforcement from observed evidence. With zero attempts, report insufficient evidence.

## Architecture

React/TypeScript frontend → same-origin celld Worker → local library Durable Object plus per-job Durable Objects and R2 originals/outputs. A loopback-only Node companion performs ffmpeg/PDF work and hosts optional Muse Code SDK sessions. The SDK needs a matching `muse` CLI and is not a speech-to-text SDK or a Workers-native library.

Direct Meta Model API calls handle speech, structured extraction and bounded function tools. Muse Code SDK handles optional code-authoring sessions in a separate workspace with default-denied approvals. Do not run it inside the main library object or give generated programs access to credentials.

Store keys backend-only and redact API responses. The initial app is single-user and binds to loopback; a network-accessible, multi-user deployment needs authentication and tenant isolation before release. Never upload existing private library content or credentials to the public repository.

## Priorities

**P0:** library workspace, local persistence, five input types, recoverable media processing, translated subtitles, validated chapters/quizzes/glossary, notes/bookmarks, observed-attempt review and one interactive artifact. English and Spanish UI, credential replacement, errors and real progress belong to P0.

**P1:** Muse-generated miniapplication with preview, explicit publish, isolated execution, persistent bounded state, versioned release, restart test and authorized source links. Implement only after P0 is verified. A template artifact is not evidence that arbitrary generated-code execution is isolated.

**Deferred:** institutional adapters, real-time transcription, word-level alignment, broad app publishing, multi-user collaboration, marketplace, model training, clinical interpretation, calendar/course administration, automatic YouTube downloading, unrestricted remote URL ingestion and third-party account migration.

## Acceptance

- A01: >10-minute recording spans multiple chunks with coherent global timestamps.
- A02: induced failure/restart resumes confirmed steps without duplicate published results.
- A03: video/audio/PDF/image/text each produce appropriate source locators.
- A04: translated captions retain cue identity and timing; original remains available.
- A05: reject unresolvable chapter/question references before publishing.
- A06: prepared terms become concepts without a review step; a known term gains the new file as a source, keeping its definition. Each concept records whether it was added manually, from the chat or from file analysis.
- A07: local endpoints reject foreign origins/hosts; no remote multi-user isolation is claimed.
- A08: deterministic artifact interaction works and survives refresh.
- A09: attempt scores and review evidence agree; zero attempts yields no mastery claim.
- A10 (P1): a published miniapp retains state after restart and has verified isolation.
- A11: replace/remove Meta key; no key in frontend bundle, logs, or repository.
- A12: sessions/tabs/archive/bookmarks/notes survive restart; interface works in both languages and narrow viewports.

Product limits and acceptance targets are requirements to verify, not statements that all functionality is implemented. See the development record for current evidence.
