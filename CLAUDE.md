# PDF Reader

Tauri 2 desktop app for reading academic PDFs with AI chat, citation lookup, and reference management.

## Configuration

Copy `.env.example` to `.env` (project root) and fill in credentials
(LLM API + Semantic Scholar key). The Rust backend reads it at launch;
the in-app settings panel overrides `.env` values.

## Build & Run

```bash
npm run tauri dev     # Dev mode (requires Rust toolchain + Node)
npm run tauri build   # Production build
```

Requires Docker for GROBID reference extraction (auto-started on launch).

## Project Structure

- `src/` — Vanilla JS frontend (PDF.js, Marked.js)
- `src-tauri/` — Rust backend (Tauri 2 commands)
- `src-tauri/src/commands/` — chat, lookup, storage, filesystem modules

## Conventions

- Make microcommits on changes
