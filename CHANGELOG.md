# Changelog

This is the **fork's** changelog. It tracks changes that diverge from upstream
[`badlogic/terminalcp`](https://github.com/badlogic/terminalcp). Each entry has
a corresponding upstream PR — the fork retires when they all land.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This fork does not yet cut its own releases; entries land directly on `main`.

## [Unreleased]

### Added

- **Per-session daemon isolation.** Each MCP server spawns its own daemon at
  `${TMPDIR}/terminalcp-mcp-${pid}.sock` instead of sharing
  `~/.terminalcp/server.sock`, so cleanup or `kill-server` in one client no
  longer affects another. CLI commands keep using the historical singleton
  path. (`351859d`)
- **Idle-timeout daemon shutdown.** Daemon self-exits after 30 min of
  (no clients **and** no running sessions). Long-running builds outlive their
  MCP client; idle daemons self-clean. Configurable via
  `TERMINALCP_IDLE_TIMEOUT_MS` and `TERMINALCP_IDLE_CHECK_INTERVAL_MS`.
  (`351859d`)
- **Session log persistence.** Every session's output is teed to
  `~/.terminalcp/logs/${name}-${timestamp}.log` via two complementary write
  paths: a final dump on session exit, and a tee-on-disconnect stream when
  the last MCP client drops while a session is still running. Recoverable
  output even if the daemon dies before the user can read it.
  (`21d78af`)
- **`terminalcp logs` CLI.** `logs` lists newest-first with age + size,
  `logs <name>` cats the newest matching log, `logs --rm` deletes all.
  Operates on files directly — no daemon required.
  (`21d78af`)
- **Log retention.** Daemon performs one-shot TTL cleanup of stale logs at
  startup. Default 7 days; configurable via `TERMINALCP_LOG_RETENTION_DAYS`
  (set to `0` to disable). Log directory configurable via
  `TERMINALCP_LOG_DIR`.
  (`21d78af`)
- **`test/recovery.test.ts`.** End-to-end recovery test: spawn MCP, start a
  session, `kill-server`, sleep, start another session — asserts success and
  that `list` sees the new session. Recovery completes in ~500 ms.
  (`6bdfa0c`)

### Changed

- **`node-pty` bumped from `^1.0.0` to `1.2.0-beta.12`.** Required for macOS 26
  Tahoe compatibility; pre-bump version returns `posix_spawnp failed` even on
  `/bin/zsh` in `/tmp`. The beta cycle exists for exactly this fix.
  (`a766864`)

### Fixed

- **Cached `connectPromise` no longer poisons subsequent calls.** The
  `TerminalClient` was caching a rejected `connectPromise` and returning the
  same error in ~9 ms for every later request, so a single autospawn timeout
  required restarting the MCP server. Promise is now cleared via `.finally`
  when an attempt settles unsuccessfully.
  (`6bdfa0c`)
- **`connectPromise` cleared on socket close.** Without clearing, a
  post-close `request()` saw the old fulfilled promise, skipped `doConnect`,
  and wrote to an undefined socket → `Request timeout`.
  (`6bdfa0c`)
- **Autospawn retry budget extended from 1 s to 5 s.** Detached node startup
  on macOS under load can exceed 1 s; new budget matches `mcp-server.ts`'s
  `waitForSocket`.
  (`6bdfa0c`)
- **`TERMINALCP_SOCKET` propagated through autospawn.** A per-PID-isolated MCP
  server's autospawn was silently respawning the daemon at the singleton path
  instead of the per-PID path, so recovery never found the new daemon.
  (`6bdfa0c`)

### Cross-cutting

- Existing test suite (`tsx --test`) and Biome `check` pass on every commit.
- All env-var contracts default to the historical behavior when unset, so
  upstream usage is unaffected.

## How this fork is structured

Each change lives on its own branch off upstream `main`, stacked in
chronological order on `main`:

| Branch | Commit | Upstream PR |
| --- | --- | --- |
| `macos26-nodepty-bump` | `a766864` | [badlogic/terminalcp#4](https://github.com/badlogic/terminalcp/pull/4) |
| `per-session-isolation-and-idle-timeout` | `351859d` | [badlogic/terminalcp#5](https://github.com/badlogic/terminalcp/pull/5) |
| `session-logs-with-recovery` | `21d78af` | [badlogic/terminalcp#6](https://github.com/badlogic/terminalcp/pull/6) |
| `fix-daemon-autorespawn` | `6bdfa0c` | [badlogic/terminalcp#7](https://github.com/badlogic/terminalcp/pull/7) |

PR descriptions and pre-merge checks live in [README §Fork notes](README.md#fork-notes).
