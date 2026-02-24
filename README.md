# CodexMonitor1·

![CodexMonitor](screenshot.png)

CodexMonitor is a Web app for orchestrating multiple Codex agents across local workspaces, backed by a local Rust service. It provides a sidebar to manage projects, a home screen for quick actions, and a conversation view backed by the Codex app-server protocol.

## Features

### Workspaces & Threads

- Add and persist workspaces, group/sort them, and jump into recent agent activity from the home dashboard.
- Spawn one `codex app-server` per workspace, resume threads, and track unread/running state.
- Worktree and clone agents for isolated work; worktrees live under the app data directory (legacy `.codex-worktrees` supported).
- Thread management: pin/rename/archive/copy, per-thread drafts, and stop/interrupt in-flight turns.
- Optional remote backend (daemon) mode for running Codex on another machine.

### Composer & Agent Controls

- Compose with queueing plus image attachments (picker, drag/drop, paste).
- Autocomplete for skills (`$`), prompts (`/prompts:`), reviews (`/review`), and file paths (`@`).
- Model picker, collaboration modes (when enabled), reasoning effort, access mode, and context usage ring.
- Dictation with hold-to-talk shortcuts powered by the browser Web Speech API (with graceful fallback when unsupported).
- Render reasoning/tool/diff items and handle approval prompts.

### Git & GitHub

- Diff stats, staged/unstaged file diffs, revert/stage controls, and commit log.
- Branch list with checkout/create plus upstream ahead/behind counts.
- GitHub Issues and Pull Requests via `gh` (lists, diffs, comments) and open commits/PRs in the browser.
- PR composer: "Ask PR" to send PR context into a new agent thread.

### Files & Prompts

- File tree with search, file-type icons, and Reveal in Finder/Explorer.
- Prompt library for global/workspace prompts: create/edit/delete/move and run in current or new threads.

### UI & Experience

- Resizable sidebar/right/plan/terminal/debug panels with persisted sizes.
- Responsive layouts (desktop/tablet/phone) with tabbed navigation.
- Sidebar usage and credits meter for account rate limits plus a home usage snapshot.
- Terminal dock with multiple tabs for background commands (experimental).
- Web update checks that guide users to GitHub Releases downloads, debug panel copy/clear, sound notifications, and a reduced transparency toggle.

## Requirements

- Node.js + npm
- Codex installed on your system and available as `codex` in `PATH`
- Git CLI (used for worktree operations)
- GitHub CLI (`gh`) for the Issues panel (optional)

Local backend options (choose one):
- Recommended: let `codex-monitor` download a prebuilt `codex_monitor_web` binary on first run (no Rust needed).
- Advanced: install your own backend binary and point `codex-monitor` at it via `--backend-path` / `CODEX_MONITOR_BACKEND_PATH`.
- Dev-only: run the backend from source via `cargo` (requires Rust toolchain).

If the `codex` binary is not in `PATH`, update the backend to pass a custom path per workspace.
If you build the backend from source and hit native build errors, run:

```bash
npm run doctor
```

## Getting Started

### Install from npm (recommended)

```bash
npm install -g @abigmiu/codex-monitor
codex-monitor
```

Runtime requirements:
- Codex CLI (`codex`) available in `PATH`

Useful flags:
- `--backend-only` / `--frontend-only`
- `--listen 127.0.0.1:4732`
- `--data-dir ~/.codexmonitor-web`
- `--token dev-token` (or `--no-token`)
- `--frontend-port 5173`
- `--backend-path /path/to/codex_monitor_web`
- `--backend-cache-dir ~/.codexmonitor-web` (where the backend binary is cached)

Backend download configuration:
- `CODEX_MONITOR_BACKEND_URL`: direct URL to a platform-specific backend binary
- `CODEX_MONITOR_BACKEND_RELEASE_BASE`: base URL for release downloads (by default taken from `package.json` `codexMonitor.backendReleaseBase`)
- `CODEX_MONITOR_BACKEND_RELEASE_TAG`: defaults to `v<package-version>`
- `CODEX_MONITOR_BACKEND_ASSET`: defaults to `codex_monitor_web-<platform>-<arch>[.exe]`
- `CODEX_MONITOR_BACKEND_CACHE_DIR`: where to store downloaded binaries
- `CODEX_MONITOR_SKIP_BACKEND_DOWNLOAD=1`: disable auto-download (CI/offline)
- `CODEX_MONITOR_BACKEND_INSTALL_STRICT=1`: make install-time download failures fail the npm install

Backend release asset naming (recommended):
- macOS: `codex_monitor_web-darwin-arm64`, `codex_monitor_web-darwin-x64`
- Linux: `codex_monitor_web-linux-arm64`, `codex_monitor_web-linux-x64`
- Windows: `codex_monitor_web-win32-x64.exe`

Note: the npm install step runs a `postinstall` hook that downloads the backend binary. If you install with `--ignore-scripts`, the download is skipped and the backend will be fetched on first run instead (unless you disable downloads).

### Install from local source

```bash
npm install
npm run build
npm install -g .
# or: npm link
codex-monitor
```

If you use `npm link`, logs can show your local repo path (symlink behavior). A published npm install will run from global `node_modules`.

### Manual dev mode (backend + Vite)

1) Start backend:

```bash
cd src-tauri
TMPDIR=../.tmp cargo run --bin codex_monitor_web -- \
  --listen 127.0.0.1:4732 \
  --data-dir ~/.codexmonitor-web \
  --token dev-token
```

2) Start frontend:

```bash
VITE_CODEX_MONITOR_API_BASE=http://127.0.0.1:4732 \
VITE_CODEX_MONITOR_TOKEN=dev-token \
npm run dev
```

3) Build frontend assets:

```bash
npm run build
```

### Publish to npm

```bash
npm login
npm run pack:check
npm publish --access public
```

## Type Checking

Run the TypeScript checker (no emit):

```bash
npm run typecheck
```

Note: `npm run build` also runs `tsc` before bundling the frontend.

## Project Structure

```
src/
  features/         feature-sliced UI + hooks
  platform/         web platform adapters (rpc/dialog/opener/file src/etc.)
  services/         RPC wrapper used by features
  styles/           split CSS by area
  types.ts          shared types
src-tauri/
  src/bin/codex_monitor_web.rs   web backend (WS JSON-RPC + HTTP file endpoint)
  src/shared/                     shared backend logic reused from daemon
```

## Notes

- Workspaces persist to `workspaces.json` under the app data directory.
- App settings persist to `settings.json` under the app data directory (Codex path, default access mode, UI scale).
- Feature settings are supported in the UI and synced to `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`) on load/save. Stable: Collaboration modes (`features.collaboration_modes`), personality (`personality`), Steer mode (`features.steer`), and Background terminal (`features.unified_exec`). Experimental: Collab mode (`features.collab`) and Apps (`features.apps`).
- On launch and on window focus, the app reconnects and refreshes thread lists for each workspace.
- Threads are restored by filtering `thread/list` results using the workspace `cwd`.
- Selecting a thread always calls `thread/resume` to refresh messages from disk.
- CLI sessions appear if their `cwd` matches the workspace path; they are not live-streamed unless resumed.
- The web backend uses `codex app-server` over stdio; see `src-tauri/src/bin/codex_monitor_web.rs`.
- Codex sessions use the default Codex home (usually `~/.codex`); if a legacy `.codexmonitor/` exists in a workspace, it is used for that workspace.
- Worktree agents live under the app data directory (`worktrees/<workspace-id>`); legacy `.codex-worktrees/` paths remain supported, and the app no longer edits repo `.gitignore` files.
- UI state (panel sizes, reduced transparency toggle, recent thread activity) is stored in `localStorage`.
- Custom prompts load from `$CODEX_HOME/prompts` (or `~/.codex/prompts`) with optional frontmatter description/argument hints.

## Web RPC Surface

Frontend calls live in `src/services/tauri.ts` and map to RPC methods handled by `src-tauri/src/bin/codex_monitor_web.rs`. Core commands include:

- Workspace lifecycle: `list_workspaces`, `add_workspace`, `add_worktree`, `remove_workspace`, `remove_worktree`, `connect_workspace`, `update_workspace_settings`.
- Threads: `start_thread`, `list_threads`, `resume_thread`, `archive_thread`, `send_user_message`, `turn_interrupt`, `respond_to_server_request`.
- Reviews + models: `start_review`, `model_list`, `account_rate_limits`, `skills_list`.
- Git + files: `get_git_status`, `get_git_diffs`, `get_git_log`, `get_git_remote`, `list_git_branches`, `checkout_git_branch`, `create_git_branch`, `list_workspace_files`.
