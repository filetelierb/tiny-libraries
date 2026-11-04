# Tiny Libraries

A local, open-source workspace that turns your recordings and documents into a library you can study: source-linked chapters, subtitles, practice, concepts, and interactive explanations powered by Meta models.

**Status:** active development. See [scope](docs/scope.md), [hackathon requirements](docs/hackathon.md), and [development record](docs/development.md).

English is the default interface language; Spanish is available in Settings. Files, sessions, and progress stay on your machine. AI processing sends selected material to Meta Model API. Bring your own Meta API key; add, replace, or remove it in Settings.

Tutor web search is on by default and can be turned off in Settings. When your files and glossary do not cover a question, the tutor may send search queries based on it to Meta and shows external sources under their own heading, with links. The **Web** button still asks for a web search on an individual question. Web citations link to external sources and are labelled separately from your library evidence.

## Run locally

Install Node.js 22.13+ and ffmpeg for audio/video. The local Workers runtime (`wrangler`) comes with `npm ci`. Then:

```sh
npm ci
npm start
```

The tutor runs as a [Muse Code](https://dev.meta.ai) agent when the `muse` command matching `@muse-code/sdk` (1.4.14) is installed:

```sh
curl -fsSL https://dev.meta.ai/install.sh | sh
```

Without it, the tutor calls the Meta Model API directly with the same tools; only questions with **Web** on can then search the web.

Open **http://127.0.0.1:9876**. The launcher starts the local runtime and media companion together. It answers within seconds. Stopping and starting preserves files and study data in `.wrangler/state/` and `.local/`. See [local operation and backups](docs/local-operation.md) before moving or resetting data.

Development remains private until the owner chooses to share the repository. Its MIT license describes the intended source distribution; it does not make private GitHub content publicly accessible.

## Project boundaries

One library, saved study sessions, and a focused reading workspace. No course administration, institutional accounts, calendars, or cloud service subscription.

## License

MIT. Dependencies retain their respective licenses. Meta services and model licenses have their own terms.
