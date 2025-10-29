# Wingman V2

Wingman V2 orchestrates AI agent sessions (Codex, Claude, Goose, OpenCode) from a single Bun-powered control plane.

## Getting Started

Install dependencies:

```bash
bun install
```

Launch the orchestration server (defaults to port `3600` unless `PORT` is set):

```bash
bun start
```

Visit `http://localhost:<PORT>/home` for the session dashboard or `/live` for the tabbed, real-time view.

## Environment

| Variable         | Description                                                                    | Default                 |
|------------------|--------------------------------------------------------------------------------|-------------------------|
| `PORT`           | Primary Wingman UI/API port                                                    | `3600`                  |
| `AGENT_PORTS`    | Starting port assigned to agent subprocesses                                   | `3700`                  |
| `AGENT_MAX`      | Total number of concurrent agent ports available                               | `10`                    |
| `DIRECTORY_DEF`  | Working directory used when launching agent subprocesses                       | `~/code`                |
| `FOLDERACCESS`   | Comma-separated directories exposed to file browsers and pickers               | `DIRECTORY_DEF`         |
| `AGENT_MODE`     | Switch orchestration mode; set to `tmux` to launch via `agentapi-tmux`         | `standard`              |
| `AGENTAPI_BIN`   | Absolute path to the AgentAPI binary used to host each agent                   | `./out/agentapi` or `./out/agentapi-tmux` when `AGENT_MODE=tmux` |
| `CLAUDE_CLI`     | Executable invoked for Claude sessions (override if not simply `claude`)       | `claude`                |
| `GOOSE_CLI`      | Executable invoked for Goose sessions                                          | `goose`                 |
| `CODEX_CLI`      | Executable invoked for Codex sessions (Wingman passes `--type=codex` as well)  | `codex`                 |
| `OPENCODE_CLI`   | Executable invoked for OpenCode sessions                                       | `opencode`              |
| `AGENTAPI_ALLOWED_ORIGINS` | Value passed to AgentAPI `--allowed-origins`                         | `*`                     |
| `AGENTAPI_ALLOWED_HOSTS`   | Value passed to AgentAPI `--allowed-hosts`                           | `localhost,127.0.0.1,[::1]` |

## Workflow Overview

- `Home` view lists active sessions and lets you start or stop agents.
- `Live` view shows each running session in tabs, streams logs, displays the agent conversation transcript, and lets you send new prompts directly to the active agent.
- All agents launch as subprocesses with dedicated ports allocated from the configured range.

Refer to `docs/architecture.md` for a deeper dive into directory responsibilities and runtime flow.
