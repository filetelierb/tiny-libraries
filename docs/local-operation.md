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
| Browser local storage | Selected session, onboarding preference, selected interface preferences and cached conversation display history                                                                                                                                                            | Yes in the same browser profile and origin |

All these paths are ignored by Git. A normal update or build does not remove them. `.local` and `.celld` have owner-only directory permissions when launched by the app. The saved Meta key is local plaintext storage, not an encrypted keychain; protect the machine and backups. The app is single-user and binds to loopback. Do not expose it to a network without adding authentication.

Do **not** use `celld dev --clean`, delete `.celld`, or run a cleanup command if you want to keep your library: that is a destructive reset. Do not move the application to a different working directory without copying the persistence folders. Model changes and source code rebuilds leave stored data in place; incompatible schema changes require a deliberate migration.

## Back up or move

1. Stop the app with Ctrl+C so storage is not changing.
2. Copy `.celld/`, `.local/`, and `.dev.vars` to a protected backup. These contain private files and credentials. Keep the Worker name and Durable Object class names stable; they participate in stored-object identity. Browser-only preferences are separate; sessions, notes, positions, saved conversations, interactive parameters and source files are in celld.
3. Restore those directories into the same relative locations in the project before restarting. Keep the celld version compatible with the stored format.

The repository alone is not a backup of your library. No user documents, transcripts or keys are pushed to GitHub.

## Verification

```sh
npm run check
npm test
npm run smoke
# Stop the app, start it again, then:
npm run smoke -- --verify
```

The smoke test creates a small authored fixture and a verification session. It checks actual celld data and original-file hashes across restart. Unit tests mock Meta network responses explicitly; they do not claim real-model quality. See `docs/development.md` for live-inference status and unfinished scope.
