# Run locally and keep your data

## Requirements

- Node.js 22.13+ and npm.
- [celld](https://github.com/denoland/celld), tested here with v0.6.3. Its official installer is `curl -fsSL https://celld.dev/install.sh | sh`; review the installer before executing it. The current prebuilt platforms are macOS Apple Silicon and Linux x64/ARM64. Windows users need a supported Linux environment such as WSL2; Windows native support is not claimed.
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

The repository is private during development; cloning requires access until the owner chooses to share it. Open **http://127.0.0.1:9876**. `npm start` builds the interface and launches celld plus the Node media companion. After a UI build, `npm run dev` starts those processes directly. For frontend development, run `npm run dev:ui` in another terminal and use port 5173; it proxies `/api` to celld.

On first launch, add a Meta key or choose **Explore without AI**. Settings lets you replace/remove the key and change the analysis model or interface language. Model calls send the selected content to `https://api.meta.ai`; the frontend never receives the saved key. A valid Meta billing setup and model access may be necessary. No OpenAI account or key is used.

## Persistence contract

Normal **Ctrl+C → `npm start`** retains your data. There is no automatic reset on start.

| Location              | Contents                                                                                                                                                                                                                                                                   | Retained after stop/start                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `.celld/dev/`         | Originals in local object storage, library metadata, sessions/tabs, saved conversations, interactive parameters, notes, bookmarks, progress, reviewed/archive state, attempts, glossary proposals, processing checkpoints, generated material, captions and saved Meta key | Yes                                        |
| `.local/processing/`  | Original working copies, normalized chunks, normalization manifests, optional code proposals                                                                                                                                                                               | Yes                                        |
| `.local/bridge-token` | Random local companion credential                                                                                                                                                                                                                                          | Yes                                        |
| `.dev.vars`           | Companion credential passed to celld; no Meta key is written here by the UI                                                                                                                                                                                                | Yes                                        |
| Browser local storage | Selected session, onboarding preference, selected interface preferences and selected conversation and unsent drafts                                                                                                                                                        | Yes in the same browser profile and origin |

All these paths are ignored by Git. A normal update or build does not remove them. `.local` and `.celld` have owner-only directory permissions when launched by the app. The saved Meta key is local plaintext storage, not an encrypted keychain; protect the machine and backups. The app is single-user and binds to loopback. Do not expose it to a network without adding authentication.

Do **not** use `celld dev --clean`, delete `.celld`, or run a cleanup command if you want to keep your library: that is a destructive reset. Do not move the application to a different working directory without copying the persistence folders. Model changes and source code rebuilds leave stored data in place; incompatible schema changes require a deliberate migration.

## Back up or move

1. Stop the app with Ctrl+C so storage is not changing.
2. Copy `.celld/`, `.local/`, and `.dev.vars` to a protected backup. These contain private files and credentials. Keep the Worker name and Durable Object class names stable; they participate in stored-object identity. Browser-only preferences are separate; sessions, notes, positions, saved conversations, interactive parameters and source files are in celld.
3. Restore those directories into the same relative locations in the project before restarting. Keep the celld version compatible with the stored format.

The repository alone is not a backup of your library. No user documents, transcripts or keys are pushed to GitHub.

## Directories and split workspaces

Use **New folder** at the root or **Create subfolder** from a folder's `+` menu. The same tree and folder actions are available in resource pickers and upload destinations. Empty folders persist. Renaming a parent changes descendant paths while preserving directory/file identities and saved study links. A selected upload destination follows its directory identity through a rename.

**Archive** hides a directory and its descendants from the active tree and pickers. Restoring it preserves each file's individual archive choice. **Delete** asks for confirmation and moves the item or subtree to **Trash**; restore it there. This version does not automatically purge originals or study history. Restore an archived/trashed parent before writing into its descendants.

Entering or restoring a split tab hides and unpins both side panels while preserving their widths; reopen them as drawers or pin them explicitly. Each split tab saves its width ratio and selected source. Drag its central divider, use arrow keys (Shift for larger steps), Home/End for limits, or double-click/press Enter for equal widths. The shared toolbar follows the clicked/focused pane; **Tools target** also selects the owner explicitly. Notes, bookmarks, tutor responses and reader positions remain tied to source identity. On narrow screens, select one full-width source; hidden media pauses.

Directory records, Trash/archive state and split preferences live in celld. Tree expansion/scroll, side-panel preferences and unsaved source-specific note drafts are browser-local and follow the same browser profile and origin.

## Verification

```sh
npm run check
npm test
npm run smoke
# Stop the app, start it again, then:
npm run smoke -- --verify
```

The smoke test creates a small authored fixture and a verification session. It checks actual celld data and original-file hashes across restart. Unit tests mock Meta network responses explicitly; they do not claim real-model quality. See `docs/development.md` for live-inference status and unfinished scope.

## Tutor conversations

Use **Start conversation** without opening a file for general study help. Inside a session, the history button lists conversations; **+** creates another without changing resource tabs. Each conversation has its own name, messages, references and unsent draft. Use a session row’s menu to rename the session. Session previews show the resource and message count.

**Persistent references** controls which prepared files the tutor can access. Add/remove files through the shared library picker or type **@** to mention a file. Changing resource tabs does not change references. Requests use the reference selection captured when sent, so edits made while a reply runs affect the next request. Source citations open the relevant file and quoted evidence. A conversation without references cannot read library files.

Messages and references live in celld. Drafts and the selected conversation live in browser storage for the current origin. Switching conversations or sessions, reloading the browser, and stopping/restarting the app retain them in that profile. Completed request IDs return their recorded reply on retry. Requests interrupted before completion may need an explicit retry; no exactly-once provider-charge guarantee is made.

## Playback controls

The audio/video player includes five-second skip buttons, a seek bar, volume, captions, fullscreen and playback speeds from 0.25x to 4x in quarter steps. Left/Right seeks five seconds while the player is focused; Space/K toggles playback from the player region. Volume and speed fields retain their own keyboard behavior.

Bookmark markers return to saved times. Chapter markers use the source’s actual timing; overlapping evidence intervals appear in separate rows. Caption/speed/volume preferences persist per recording in browser storage, and switching caption language keeps playback position. Position is checkpointed during playback and saved on pause, seek or session navigation.

Video controls hide after three seconds of inactivity during playback. Pointer movement or keyboard focus reveals them; keyboard interaction and slider drags keep them accessible. Audio controls remain visible. Browser fullscreen is independent of workspace focus mode.
