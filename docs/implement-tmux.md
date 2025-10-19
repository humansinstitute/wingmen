# Integrating Native tmux Management in Wingman

Wingman should spawn every agent subprocess inside tmux so operators can attach directly without shell wrappers. This plan captures the changes needed to make tmux an opinionated, built-in default and to expose helpful metadata for downstream tooling like `wingman cli`.

## Goals
- Require tmux on hosts running the orchestrator and fail fast when it is missing.
- Launch agent subprocesses inside a managed tmux session without relying on wrapper scripts or manual indirection.
- Provide structured naming and metadata so the CLI can enumerate and attach without flooding the operator with noisy sessions.
- Keep the existing HTTP lifecycle semantics (stop via API ➜ terminate tmux window ➜ agent receives `SIGTERM`).

## High-Level Design
1. **tmux prerequisite check**: During startup, verify `tmux` exists and expose a clear error (`wingman requires tmux >= 3.2`).
2. **Single controller session**: Create (or reuse) a tmux session named `wingman-agents`. All agent subprocesses run as windows within this controller session instead of creating one tmux session per agent.
3. **Deterministic window naming**: Use `SESSION_ID` plus the agent type to form the window name (e.g., `codex:1a2b3c4d`). This keeps `tmux list-windows -t wingman-agents` tidy and makes window discovery simple.
4. **Single source of truth**: Keep every agent window inside the shared session so operators have one place to inspect and attach without extra metadata plumbing.
5. **Graceful cleanup**: When a Wingman session stops, close the corresponding tmux window; when the tmux server exits, ensure Wingman releases ports and updates state.

## Implementation Steps

### 1. Detect and Require tmux
- At server bootstrap (`src/server.ts` or a small helper), run `tmux -V` via `Bun.spawnSync`.
- If the command fails, log a fatal message and `process.exit(1)` explaining that tmux must be installed.
- Optionally read the version string to enforce a minimum version if we rely on newer features (e.g., `set -F #{}` format strings).

### 2. Establish the Controller Session
- Extend `ProcessManager` to ensure tmux session `wingman-agents` exists before any agents start:
  ```ts
  Bun.spawn(['tmux', 'new-session', '-d', '-s', 'wingman-agents', '-n', 'controller', '--', 'sleep', 'infinity']);
  tmux set-option -t wingman-agents destroy-unattached off
  ```
- The `controller` window simply idles (e.g., running `sleep infinity`) so the session persists even when no agents are active.
- Make the call idempotent: `new-session -A -d` lets tmux reuse the session if it already exists.

### 3. Launch Agents as tmux Windows
- Replace the direct `Bun.spawn(session.command, …)` call with a tmux `new-window` invocation:
  ```ts
  const tmuxCommand = [
    'tmux',
    'new-window',
    '-t', 'wingman-agents',
    '-n', `${session.agent}:${session.id.slice(0, 8)}`,
    '--',
    'bash',
    '-lc',
    shellescape(session.command),
  ];
  ```
- Wrap the agent command in a login shell (or helper that mimics `bash -lc`) so argv quoting, environment expansion, and PATH resolution behave like the existing `Bun.spawn`. Implement a small adapter (e.g., a `shellescape` helper) that produces a safe string suitable for passing through the shell.
- Capture the pane ID or PID from `tmux display-message -p '#{pane_id}'` to map agent sessions back to `ProcessManager`. Record it alongside the session so stop/cleanup routines target the right window.
- Wire the adapter so `ProcessManager` can still observe exit codes: wait on the tmux pane (e.g., `tmux wait-for` or poll `list-panes`) and propagate failures back to the orchestrator just as the direct spawn did.

### 4. Keep tmux as the Control Plane
- All agent panes live inside the `wingman-agents` session; no additional metadata or environment shims are required.
- Downstream tooling attaches to that session and relies on tmux’s own window naming to identify the target agent. Maintaining deterministic names keeps discovery simple without custom payloads.

### 5. Update Stop & Cleanup Paths
- When `stopSession` runs, send the normal termination signal to the agent, wait for its exit (with a timeout), then issue `tmux kill-window -t wingman-agents:${windowName}` to clean up the pane.
- If an agent terminates on its own, watch for the `pane_dead` event (poll with `tmux list-panes`) or fall back to the process exit promise. Once detected, call `kill-window` to tidy up.
- On orchestrator shutdown (`ctrl+c`), send `tmux kill-session -t wingman-agents` so any lingering windows disappear and metadata is cleared. Afterwards Wingman should release all allocated ports.

### 6. CLI Integration
- Teach `wingman cli` to read the tmux session instead of shelling out to `ps`:
  - List windows: `tmux list-windows -t wingman-agents -F '#{window_name} #{window_id}'`.
  - Attach by running `tmux attach-session -t wingman-agents` (default to the latest window) or `tmux attach -t wingman-agents:${windowName}` for a specific agent.
- Provide an ergonomic alias like `wingman cli attach <session-id>` that maps to `tmux attach -t wingman-agents:<short-id>`.

### 7. User Experience Considerations
- Because all agents share the `wingman-agents` session, the tmux status bar displays them as windows—this avoids cluttering the global `tmux ls` output.
- To prevent the operator’s personal tmux workflow from mixing, document that Wingman uses a dedicated session name and recommend attaching with `tmux switch-client -t wingman-agents` instead of listing all sessions.
- Optionally add a tmux hook that announces new agent windows (e.g., using `display-message`) so operators know when fresh sessions spin up.

## Edge Cases & Follow-Up Tasks
- Handle long session IDs by truncating window names (`slice(0, 8)`) while keeping the full ID in orchestrator state so lookups remain unambiguous.
- Ensure agent commands that already start tmux or expect a TTY still behave correctly—if they require a login shell, pass `tmux new-window … -- bash -lc '<command>'`.
- Document tmux keyboard shortcuts (`Ctrl+b d` to detach) in the CLI help so operators unfamiliar with tmux can exit safely.
- Decide what happens when tmux restarts independently (e.g., after upgrade). Wingman should detect the missing session and recreate it, possibly by reparenting running agents or forcing a restart.

This plan keeps tmux as a first-class dependency, gives Wingman full control over the multiplexer lifecycle, and relies on tmux’s native window management to deliver a straightforward attach/detach flow without extra wrapper scripts.
