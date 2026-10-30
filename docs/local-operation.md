# Run locally and keep your data

## Requirements

- Node.js 22.13+ and npm.
- Nothing else for the Worker: `npm ci` installs Cloudflare's local Workers runtime (`wrangler`, which runs `workerd`) with the project.
- ffmpeg and ffprobe on PATH for audio/video preparation. Reading other files does not require them.
- Your own Meta Model API key for inference. Reading and organizing files needs no key.
- Optional: Muse Code CLI matching `@muse-code/sdk` (currently 1.4.13), configured for your Meta account. Its absence does not stop the library or Model API processing.

## Start

```sh
git clone https://github.com/filetelierb/tailored-library.git
cd tailored-library
npm ci
npm start
```

The repository is private during development; cloning requires access until the owner chooses to share it. Open **http://127.0.0.1:9876**. `npm start` builds the interface and launches the local Workers runtime plus the Node media companion; the app answers within seconds. After a UI build, `npm run dev` starts those processes directly. Worker changes reload by themselves; interface changes need `npm run build`. If the runtime stops unexpectedly, the launcher starts it again while the companion keeps running. For frontend development, run `npm run dev:ui` in another terminal and use port 5173; it proxies `/api` to the Worker.

On first launch, add a Meta key or choose **Explore without AI**. Settings lets you replace/remove the key and change the analysis model or interface language. Model calls send the selected content to `https://api.meta.ai`; the frontend never receives the saved key. A valid Meta billing setup and model access may be necessary. No OpenAI account or key is used.

## Persistence contract

Normal **Ctrl+C → `npm start`** retains your data. Wait for the launcher to finish its graceful shutdown before restarting. There is no automatic reset on start.

| Location              | Contents                                                                                                                                                                                                                                                                   | Retained after stop/start                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `.wrangler/state/`    | Originals in local object storage, library metadata, sessions/tabs, saved conversations, interactive parameters, notes, bookmarks, progress, reviewed/archive state, attempts, glossary proposals, processing checkpoints, generated material, captions and saved Meta key | Yes                                        |
| `.local/processing/`  | Original working copies, normalized chunks, normalization manifests, optional code proposals                                                                                                                                                                               | Yes                                        |
| `.local/bridge-token` | Random local companion credential                                                                                                                                                                                                                                          | Yes                                        |
| `.dev.vars`           | Companion credential passed to the Worker; no Meta key is written here by the UI                                                                                                                                                                                           | Yes                                        |
| Browser local storage | Selected session, onboarding preference, selected interface preferences and selected conversation and unsent drafts                                                                                                                                                        | Yes in the same browser profile and origin |

All these paths are ignored by Git. A normal update or build does not remove them. `.local` and `.wrangler` have owner-only directory permissions when launched by the app. The saved Meta key is local plaintext storage, not an encrypted keychain; protect the machine and backups. The app is single-user and binds to loopback. Do not expose it to a network without adding authentication.

Do **not** delete `.wrangler/state` or run a cleanup command if you want to keep your library: that is a destructive reset. Do not move the application to a different working directory without copying the persistence folders. Model changes and source code rebuilds leave stored data in place; incompatible schema changes require a deliberate migration.

## Back up or move

1. Stop the app with Ctrl+C so storage is not changing.
2. Copy `.wrangler/state/`, `.local/`, and `.dev.vars` to a protected backup. These contain private files and credentials. Keep the Worker name and Durable Object class names stable; they participate in stored-object identity. Browser-only preferences are separate; sessions, notes, positions, saved conversations, interactive parameters and source files are in the Worker's local state.
3. Restore those directories into the same relative locations in the project before restarting. Keep the `wrangler` version compatible with the stored format.

The repository alone is not a backup of your library. No user documents, transcripts or keys are pushed to GitHub.

## Keep the library on an external disk

Recorded lectures are large (about 800 MB each), so the library can keep its data in another folder, such as an external disk:

```sh
npm run move-data -- "/Volumes/MyDisk/courses/library"   # with the app stopped: copies the current library
npm run dev                                                # uses that folder from now on
```

Or start a new library there with `npm run dev -- --data "/Volumes/MyDisk/courses/library"`. The folder is remembered in `.local/config.json`; it then holds `state/` (what `.wrangler/state/` held, including the saved Meta key) and `processing/` (what `.local/processing/` held). The companion credential stays in the project. Settings shows the folder in use.

- With the disk disconnected, the app does not start: it says the disk is not mounted rather than begin an empty library on the internal disk. A remembered folder must still contain `tailored-library.json`, which marks it as a library.
- macOS asks before a program uses a removable volume. If the start says access was denied, allow your terminal under System Settings › Privacy & Security › Files and Folders › Removable Volumes.
- `move-data` copies and checks that file counts and sizes match before switching. It leaves the previous copy in place; delete it yourself once the library opens from the new folder.

## A project from a course

Every project keeps its files in the library's data folder. **New project → From a course** starts one from a downloaded course in the courses folder (`coursesDir` in `.local/config.json`, set when courses are downloaded). It lists each sub-folder with readable files, and each course inside a site folder such as `see/`, with its videos, documents and size. The name starts as the course title. Then choose what to bring in:

- **Files only**: the course's files are copied into the library with their folders (`Handouts/`, `Lectures/Lecture 01/…`), ready to prepare from scratch. **Prepare once copied** can queue the videos or every file, which uses your Meta key.
- **With prepared material**: offered when the course carries prepared material. Transcripts, subtitles, chapters with their mini quizzes, the glossary, the artifact, pictures and flashcards come ready; nothing is prepared again. Files the material does not cover stay ready to prepare.

Copying runs in the background, one file after another, and resumes if the app restarts; the project's card on the home page shows how far it has come. While files are prepared, a line above the library's files names the file under way and its step (or how many are under way), how many wait and how many need attention, and opens the preparation queue; each file being prepared shows a spinner beside its name, a clock and its place in line while it waits, or an alert if it stopped. Two files are prepared at a time across the app; the others wait their turn in the order they were queued. A file that finishes shows its chapters and practice without reloading. The course folder is never changed by the copy, and deleting the project leaves it as it is.

**Save prepared material with the course**, on the card of a project made from a course, writes the project's prepared material to `.tailored-library/` inside the course folder (hidden, so it is never listed as a course file). It is matched to files by their place in the course and their size, so a file that changed is prepared again. Your progress, notes, conversations, card reviews and edits to the glossary are never part of it; saving again replaces the earlier copy.

A course that already has a project is shown but cannot be chosen; delete that project first to start again from the course.

## Open courseware

`npm run courses` lists, downloads and imports courses whose material is openly licensed. The first source is Stanford Engineering Everywhere (`see`), licensed CC BY-NC-SA 4.0 unless an item says otherwise.

```sh
npm run courses -- list see
npm run courses -- show see EE261                     # lectures, durations and download sizes
npm run courses -- download see EE261 --lectures 1-3 --to /Volumes/MyDisk/courses
npm run courses -- import "/Volumes/MyDisk/courses/see/EE261 – The Fourier Transform and its Applications" --prepare videos
```

- `download` takes every handout, assignment, exam and transcript, and the videos of the lectures named with `--lectures` (`1-3`, `1,4,7`, `all`; none by default). `--no-transcripts` and `--no-materials` leave those out. It checks free space first, resumes interrupted files, and remembers the `--to` folder.
- A course folder holds `Handouts/`, `Assignments/`, `Exams/` and `Lectures/Lecture 01/…` as the course page lists them, plus `course.json` (what was downloaded) and `SOURCE.md` (source, instructor and license). Links to other sites are not downloaded.
- `import` needs the app running and the course in the courses folder. It makes a project from the course as **New project → From a course** does: the app copies the files with their folders; other kinds (zip, gif) are left out. `--prepare videos` or `--prepare all` queues preparation once they are copied, which uses your Meta key; follow it in the preparation queue. `--project <name>` instead uploads copies into an existing project, under a folder named for the course, and skips files already there, so it can be repeated after downloading more lectures.

Downloaded courses stay on your disk and are never part of the repository. Attribute the course and its source when you show the material, for example in a demo.

## Directories and split workspaces

Use **New folder** at the root or **Create subfolder** from a folder's `+` menu. The same tree and folder actions are available in resource pickers and upload destinations. Empty folders persist. Renaming a parent changes descendant paths while preserving directory/file identities and saved study links. A selected upload destination follows its directory identity through a rename.

**Archive** hides a directory and its descendants from the active tree and pickers. Restoring it preserves each file's individual archive choice. **Delete** asks for confirmation, offers **Archive instead**, and then deletes the item or subtree permanently, with its originals and study data; there is no Trash. The confirmation lists concepts that cite only the deleted files, to delete with them. Restore an archived parent before writing into its descendants.

Entering or restoring a split tab hides and unpins both side panels while preserving their widths; reopen them as drawers or pin them explicitly. Each split tab saves its width ratio and selected source. Drag its central divider, use arrow keys (Shift for larger steps), Home/End for limits, or double-click/press Enter for equal widths. The shared toolbar follows the clicked/focused pane; **Tools target** also selects the owner explicitly. Notes, bookmarks, tutor responses and reader positions remain tied to source identity. On narrow screens, select one full-width source; hidden media pauses.

Directory records, archive state and split preferences live in the Worker's local state. Tree expansion/scroll, side-panel preferences and unsaved source-specific note drafts are browser-local and follow the same browser profile and origin.

## Verification

```sh
npm run check
npm test
npm run smoke
# Stop the app, start it again, then:
npm run smoke -- --verify
```

The smoke test creates a small authored fixture and a verification session. It checks the stored data and original-file hashes across restart. Unit tests mock Meta network responses explicitly; they do not claim real-model quality. See `docs/development.md` for live-inference status and unfinished scope.

## Tutor conversations

Use **Start conversation** without opening a file for general study help. Inside a session, the history button lists conversations; **+** creates another without changing resource tabs. Each conversation has its own name, messages, references and unsent draft. Use a session row’s menu to rename the session. Session previews show the resource and message count.

**Persistent references** controls which prepared files the tutor can access. Add/remove files through the shared library picker or type **@** to mention a file. Changing resource tabs does not change references. Requests use the reference selection captured when sent, so edits made while a reply runs affect the next request. Source citations open the relevant file and quoted evidence. A conversation without references can use a passage explicitly attached to its current question; otherwise it has no source-reading tools available.

Messages and references live in the Worker's local state. Drafts and the selected conversation live in browser storage for the current origin. Switching conversations or sessions, reloading the browser, and stopping/restarting the app retain them in that profile. Completed request IDs return their recorded reply on retry. Requests interrupted before completion may need an explicit retry; no exactly-once provider-charge guarantee is made.

## Playback controls

The audio/video player includes five-second skip buttons, a seek bar, volume, captions, fullscreen and playback speeds from 0.25x to 4x in quarter steps. Left/Right seeks five seconds while the player is focused; Space/K toggles playback from the player region. Volume and speed fields retain their own keyboard behavior.

Bookmark markers return to saved times. Chapter markers use the source’s actual timing; overlapping evidence intervals appear in separate rows. Caption/speed/volume preferences persist per recording in browser storage, and switching caption language keeps playback position. Position is checkpointed during playback and saved on pause, seek or session navigation.

Video controls hide after three seconds of inactivity during playback. Pointer movement or keyboard focus reveals them; keyboard interaction and slider drags keep them accessible. Audio controls remain visible. Browser fullscreen is independent of workspace focus mode.

## PDF reading

PDFs open in a continuous page stack with selectable text. The bottom toolbar shows the actual page total and bounds page navigation. Choose **Fit width**, **Fit page**, or 25–300% zoom. Zoom preferences belong to the document; the selected page belongs to the study session. Resizing the reader retains the selected page.

The PDF worker, fonts and decoders are bundled locally. Opening a PDF needs no Meta key or remote viewer. The original remains available through Download.

## Annotations and selected passages

Use **Annotate resource** to write a formatted note and draw on a local PDF-page, video-frame or image capture. The editor supports Markdown, headings, emphasis, lists, links, code and tables. Pen/highlighter strokes, erasing, undo and clear remain editable after saving. PDF drawings appear over their saved page. Captures and originals are separate local objects.

File annotations are shared across study sessions by file identity and retain their creator, page/time and selected quote. **Current resource** shows that file’s annotations. **All resources** gathers annotations for files open in the session, with an inline directory filter, per-file counts and select-all/none controls. Unbound session annotations have a separate checkbox and remain in their original session. Editing a shared note updates the same record. Read, edit, jump to source, or delete an annotation permanently, with its captures. Revision checks reject stale edits from another window. Existing text notes remain available through automatic migration.

Select PDF or document text and choose **Ask tutor** to attach a removable **For this question** context. Its source and quote stay fixed if you change the reader's active tab. A selected passage can be discussed without preparing the entire file. Without a quote, prepare the source first. Persistent conversation references remain unchanged. The exchange records its source/page/time and citations; **Save as annotation** opens an editable note with that context.

Unsent text and question context stay in browser storage. Saved annotations, captures and completed exchanges stay in the Worker's local state across restart. Large conversations ask you to start another conversation before exceeding a local storage record's size; existing history remains intact.

## Bookmarks

Use **Bookmark** in the reader toolbar or **Add bookmark** in the panel to label the current source location. File bookmarks are shared across study sessions. Edit the label, jump to the saved time/page, or delete a bookmark permanently. Existing session bookmarks are migrated automatically without changing their original session records.

The panel filters **All bookmarks**, **Personal**, or **Suggested by Meta**; the same filter applies to playback markers. The navigation count shows the active file’s complete non-deleted total. Ask the tutor to bookmark a selected passage or an evidence-linked study location to create a Suggested bookmark. Its source and locator must resolve to the material available in that question. One reply can save up to three distinct locations; retry identities prevent duplicate records for the same request/location.
