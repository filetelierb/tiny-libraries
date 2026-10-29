# Tailored Library

A local, open-source workspace that turns your recordings and documents into a library you can study: source-linked chapters, subtitles, practice, concepts, and interactive explanations powered by Meta models.

**Status:** active development. See [scope](docs/scope.md), [hackathon requirements](docs/hackathon.md), and [development record](docs/development.md).

English is the default interface language; Spanish is available in Settings. Files, sessions, and progress stay on your machine. AI processing sends selected material to Meta Model API. Bring your own Meta API key; add, replace, or remove it in Settings.

Tutor Web search is optional and off by default. Enable **Web** for an individual question to allow Meta to use the question, conversation and selected material in external search queries. The choice turns off after sending; saved questions and explicit retries retain their original permission. Web citations link to external sources and are labelled separately from your library evidence.

## Run locally

Install Node.js 22.13+, [celld](https://github.com/denoland/celld), and ffmpeg for audio/video. Then:

```sh
npm ci
npm start
```

The tutor runs as a [Muse Code](https://dev.meta.ai) agent when the `muse` command matching `@muse-code/sdk` (1.4.14) is installed:

```sh
curl -fsSL https://dev.meta.ai/install.sh | sh
```

Without it, or for questions with **Web** on, the tutor calls the Meta Model API directly with the same tools.

Open **http://127.0.0.1:9876**. The launcher starts the local runtime and media companion together. Stopping and starting preserves files and study data in `.celld/dev/` and `.local/`. See [local operation and backups](docs/local-operation.md) before moving or resetting data.

Development remains private until the owner chooses to share the repository. Its MIT license describes the intended source distribution; it does not make private GitHub content publicly accessible.

## Project boundaries

One library, saved study sessions, and a focused reading workspace. No course administration, institutional accounts, calendars, or cloud service subscription.

## License

MIT. Dependencies retain their respective licenses. Meta services and model licenses have their own terms.
