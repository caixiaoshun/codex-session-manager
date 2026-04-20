# Codex Session Manager

> A local desktop tool for reviewing and permanently deleting Codex Desktop session records.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0d756c)
![Electron](https://img.shields.io/badge/Electron-desktop-245f9f)
![License](https://img.shields.io/badge/license-MIT-green)

Codex Session Manager helps you inspect local Codex conversation records, separate archived and unarchived sessions, group sessions by workspace, and remove selected local records from files, indexes, and SQLite databases.

## Highlights

- Scan the default `~/.codex` directory or choose another Codex Home.
- Distinguish unarchived sessions in `sessions` from archived sessions in `archived_sessions`.
- Display sessions as a workspace tree, with directory-level select all and per-session selection.
- Search by title, path, session ID, first user message, or workspace.
- Preview the delete plan before removing local artifacts.
- Delete JSONL session files, `session_index.jsonl` entries, and SQLite records.
- Show live delete progress and refresh the list after deletion.
- Package the app for Windows, macOS, and Linux with GitHub Actions.

## How It Works

Codex stores local conversation data in several places under `~/.codex`. This app scans:

| Location | Purpose |
| --- | --- |
| `sessions/` | Active, unarchived JSONL session files |
| `archived_sessions/` | Archived JSONL session files |
| `session_index.jsonl` | Session index and display names |
| `state_5.sqlite` | Thread metadata and related state |
| `logs_2.sqlite` | Local logs tied to thread IDs |

When you delete selected sessions, the app removes the JSONL files, rewrites the session index, deletes matching SQLite rows, and can run SQLite cleanup with `VACUUM`.

## Requirements

- Node.js 24 for development and CI builds.
- npm.
- Python 3 available as `python` or `py -3` for SQLite cleanup at runtime.
- Codex Desktop local data under `~/.codex`.

## Install

```bash
npm install
```

## Run Locally

```bash
npm start
```

## Test

```bash
npm test
```

The test suite creates a temporary `.codex` fixture, scans it, deletes a session, and verifies that files, indexes, and SQLite rows are removed.

## Package Locally

Create a Windows NSIS installer:

```bash
npm run dist:win
```

Create a macOS DMG for Intel:

```bash
npm run dist:mac:x64
```

Create a macOS DMG for Apple Silicon:

```bash
npm run dist:mac:arm64
```

Create a Linux AppImage:

```bash
npm run dist:linux
```

Run macOS packaging on macOS. The generated installers are written to `dist/`.

This project now produces release-ready distributables instead of directory archives:

| Platform | Output |
| --- | --- |
| Windows | NSIS installer `.exe` |
| macOS | `.dmg` |
| Linux | `.AppImage` |

## Safety Notes

- Close Codex Desktop before deleting sessions. SQLite files may be in use while Codex is running.
- Deleted JSONL files are removed directly and do not go through the recycle bin.
- SQLite cleanup reduces local database remnants but does not guarantee forensic erasure on SSDs.
- This app only manages local Codex records. It does not delete any remote copies or external backups.
- Current CI bundles are unsigned. For public distribution, add Windows code signing and macOS signing/notarization.

## Project Structure

```text
.
+-- .github/workflows/build.yml
+-- scripts/sqlite_worker.py
+-- src
|   +-- codexStore.js
|   +-- main.js
|   +-- preload.js
|   +-- renderer
|       +-- index.html
|       +-- renderer.js
|       +-- styles.css
+-- test/codexStore.test.js
+-- package.json
+-- README.md
```

## Development Notes

- Main process code lives in `src/main.js`.
- Filesystem and SQLite logic lives in `src/codexStore.js`.
- Renderer UI code lives in `src/renderer/`.
- SQLite cleanup is delegated to `scripts/sqlite_worker.py` to use Python's standard `sqlite3` module.

## License

MIT. See [LICENSE](./LICENSE).
