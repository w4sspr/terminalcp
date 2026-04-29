# terminalcp

> [!NOTE]
> **Maintained fork.** This is a fork of [badlogic/terminalcp](https://github.com/badlogic/terminalcp) with macOS 26 Tahoe compatibility and three robustness improvements. See [Fork notes](#fork-notes) below — each change has its own upstream PR, and the fork retires when they land.

https://github.com/user-attachments/assets/e19a83da-e446-4ccd-9028-9c1cc0e09a5e

Let AI agents control interactive command-line tools like a human would.

## What it does

terminalcp enables AI agents to spawn and interact with any CLI tool in real-time - from debuggers like LLDB and GDB to other AI coding assistants like Claude Code, Gemini CLI, and Codex. Think of it as Playwright for the terminal: your agent can start processes, send keystrokes, read output, and maintain full interactive sessions with tools that normally require human input.

Key capabilities:
- Debug code step-by-step using command-line debuggers (LLDB, GDB, pdb)
- Collaborate with other AI tools by running them as subprocesses
- Interact with REPLs (Python, Node, Ruby), database shells, and system monitors
- Control any interactive CLI that expects human input
- Run multiple processes simultaneously without blocking the agent
- Users can attach to AI-spawned processes from their own terminal, similar to screen/tmux. Watch what the AI is doing in real-time or jump in to help!

Two output modes for different use cases:
- **Terminal mode (stdout)**: Returns the rendered screen with full scrollback - perfect for TUIs like vim, htop, or interactive debuggers where visual layout matters
- **Stream mode**: Returns raw output with optional ANSI stripping and incremental reading - ideal for build processes, server logs, and high-volume output where you only need new data

Each process runs in a proper pseudo-TTY with full terminal emulation, preserving colors, cursor movement, and special key sequences - exactly as if a human were typing at the keyboard. Processes run in the background, so your agent stays responsive while managing long-running tools.

In addition to the MCP server, terminalcp comes with a CLI that can be used like tmux. You can also use the underlying technology in your NodeJS apps to drive CLI tools as part of your apps or tests. See below.

## Fork notes

This fork tracks `badlogic/terminalcp@1.3.3` plus four focused patches and one drive-by cleanup, each filed as its own upstream PR. Every behavioral change came from a specific failure I hit running terminalcp daily for AI-driven workflows.

### 1. macOS 26 Tahoe compatibility — `node-pty` bump

`node-pty 1.1.0` returns `posix_spawnp failed` on macOS 26 (kernel 25.3.0) even for `/bin/zsh` in `/tmp`. Direct `pty.spawn` under both node and bun reproduced, isolating the failure to bundled `node-pty`. Pinning `1.2.0-beta.12` (the beta cycle that exists for Tahoe) fixes it on first try.

- Branch: [`macos26-nodepty-bump`](https://github.com/w4sspr/terminalcp/tree/macos26-nodepty-bump)
- Upstream PR: [badlogic/terminalcp#4](https://github.com/badlogic/terminalcp/pull/4)

### 2. Per-session daemon isolation + idle timeout

The shared `~/.terminalcp/server.sock` singleton meant any `pkill terminalcp.*--server` or `kill-server` in one Claude Code window killed every parallel window's daemon. Each MCP server now spawns its own daemon at `${TMPDIR}/terminalcp-mcp-${pid}.sock`. Daemon self-exits after 30 min of (no clients **and** no running sessions), so long builds keep running after Claude Code closes but idle daemons self-clean.

- Env overrides: `TERMINALCP_SOCKET`, `TERMINALCP_IDLE_TIMEOUT_MS`, `TERMINALCP_IDLE_CHECK_INTERVAL_MS`
- Branch: [`per-session-isolation-and-idle-timeout`](https://github.com/w4sspr/terminalcp/tree/per-session-isolation-and-idle-timeout)
- Upstream PR: [badlogic/terminalcp#5](https://github.com/badlogic/terminalcp/pull/5)

### 3. Session log persistence with recovery

A long Vercel deploy I'd left running died along with the daemon — its output was trapped in dead-daemon memory. Sessions now leave a recovery log at `~/.terminalcp/logs/${name}-${timestamp}.log` via two complementary write paths: a final-state dump on session exit (the common case, MCP attached throughout), and a tee-on-disconnect stream when the last MCP client drops while a session is still running. CLI: `terminalcp logs`, `terminalcp logs <name>`, `terminalcp logs --rm`. Logs auto-prune after 7 days.

- Env overrides: `TERMINALCP_LOG_DIR`, `TERMINALCP_LOG_RETENTION_DAYS`
- Branch: [`session-logs-with-recovery`](https://github.com/w4sspr/terminalcp/tree/session-logs-with-recovery)
- Upstream PR: [badlogic/terminalcp#6](https://github.com/badlogic/terminalcp/pull/6)

### 4. Transparent daemon auto-respawn

After the daemon's idle timeout fires (or it crashes, or someone runs `kill-server`), the next tool call should respawn it without a manual `/mcp reconnect`. Four bugs in the existing client autospawn path were defeating that: a cached failed `connectPromise` poisoned subsequent calls (returning the same error in 9 ms), the promise wasn't cleared on socket close, the 1 s autospawn budget was too tight on Tahoe under load, and `TERMINALCP_SOCKET` wasn't propagated to respawned daemons. `test/recovery.test.ts` asserts end-to-end recovery in ~500 ms.

- Branch: [`fix-daemon-autorespawn`](https://github.com/w4sspr/terminalcp/tree/fix-daemon-autorespawn)
- Upstream PR: [badlogic/terminalcp#7](https://github.com/badlogic/terminalcp/pull/7)

### 5. Drive-by cleanup — remove unreachable `terminal-server.ts` entry

While auditing the codebase, the opus simplification subagent flagged the bottom-of-file `if (import.meta.url === \`file://${process.argv[1]}\`)` block as unreachable: `terminal-server.js` is never the script entry — `terminalcp`'s bin maps to `dist/index.js`, and `index.ts`'s `--server` branch is the canonical daemon entry. Removed 31 lines of dead signal handlers + cleanup that the live path already covers. Pre-existing in upstream; branched independently of #1–#4.

- Branch: [`remove-unreachable-server-entry`](https://github.com/w4sspr/terminalcp/tree/remove-unreachable-server-entry)
- Upstream PR: [badlogic/terminalcp#8](https://github.com/badlogic/terminalcp/pull/8)

### Using the fork while the PRs are pending

```json
{
  "mcpServers": {
    "terminalcp": {
      "command": "node",
      "args": ["/path/to/terminalcp/dist/index.js", "--mcp"]
    }
  }
}
```

```bash
git clone https://github.com/w4sspr/terminalcp.git
cd terminalcp && bun install && bun run build
```

When all five PRs merge upstream, swap your config back to the canonical `npx @mariozechner/terminalcp@latest --mcp` form below.

### Security review

I audited upstream `1.3.3` before installing — no network calls, no `eval`, no env-var exfil, all `child_process.spawn` paths legitimate, socket file mode `0o600`. The two `npm audit` warnings come from dead `@anthropic-ai/*` dependencies that the package never imports (already moved to devDependencies in upstream PR [#2](https://github.com/badlogic/terminalcp/pull/2) by @mindreframer).

## Requirements
- Node.js 20 or newer
- An MCP client (VS Code, Cursor, Windsurf, Claude Desktop, Claude Code, etc.)

## Getting Started

First, install the terminalcp MCP server with your client.

**Standard config** works in most tools:

```json
{
  "mcpServers": {
    "terminalcp": {
      "command": "npx",
      "args": ["@mariozechner/terminalcp@latest", "--mcp"]
    }
  }
}
```

<details>
<summary>Claude Code</summary>

Use the Claude Code CLI to add the terminalcp server:

```bash
claude mcp add -s user terminalcp npx @mariozechner/terminalcp@latest --mcp
```
</details>

<details>
<summary>Claude Desktop</summary>

Follow the MCP install [guide](https://modelcontextprotocol.io/quickstart/user), use the standard config above.

</details>

<details>
<summary>Cursor</summary>

Go to `Cursor Settings` -> `MCP` -> `Add new MCP Server`. Name it "terminalcp", use `command` type with the command `npx @mariozechner/terminalcp@latest --mcp`.

</details>

<details>
<summary>VS Code</summary>

Follow the MCP install [guide](https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_add-an-mcp-server), use the standard config above. You can also install using the VS Code CLI:

```bash
# For VS Code
code --add-mcp '{"name":"terminalcp","command":"npx","args":["@mariozechner/terminalcp@latest","--mcp"]}'
```

After installation, the terminalcp server will be available for use with your GitHub Copilot agent in VS Code.
</details>

<details>
<summary>Windsurf</summary>

Follow Windsurf MCP [documentation](https://docs.windsurf.com/windsurf/cascade/mcp). Use the standard config above.

</details>

<details>
<summary>Other MCP Clients</summary>

For other MCP clients, use the standard config above or install globally:

```bash
npm install -g @mariozechner/terminalcp
```

Then use this config:
```json
{
  "mcpServers": {
    "terminalcp": {
      "command": "terminalcp",
      "args": ["--mcp"]
    }
  }
}
```
</details>

## MCP Usage Examples

The following examples show the JSON arguments to pass to the single `terminalcp` tool exposed by the MCP server. Each example demonstrates different action types and their parameters for managing terminal sessions. The MCP server returns simple plain text responses rather than JSON to minimize token usage.

### Starting and Managing Processes

```json
// Start with auto-generated ID
{"action": "start", "command": "python3 -i"}
// Returns: "proc-3465b9b687af"

// Start with custom name (becomes the ID)
{"action": "start", "command": "npm run dev", "name": "dev-server"}
// Returns: "dev-server"

// Start in specific directory
{"action": "start", "command": "python3 script.py", "cwd": "/path/to/project", "name": "analyzer"}
// Returns: "analyzer"
```

### Interacting with Running Sessions

```json
// Send text with Enter key (\r)
{"action": "stdin", "id": "dev-server", "data": "npm test\r"}
// Returns: ""

// Send arrow keys to navigate (\u001b[D = Left arrow)
{"action": "stdin", "id": "editor", "data": "echo hello\u001b[D\u001b[D\u001b[D\u001b[Dhi \r"}

// Send control sequences
{"action": "stdin", "id": "process", "data": "\u0003"}  // Ctrl+C
{"action": "stdin", "id": "shell", "data": "\u0004"}     // Ctrl+D (EOF)

// Get terminal output (rendered screen)
{"action": "stdout", "id": "dev-server"}
// Returns: Full terminal screen with colors and formatting

// Get last N lines only
{"action": "stdout", "id": "dev-server", "lines": 50}
```

### Monitoring Long-Running Processes

```json
// Get all output as raw stream (ansi codes stripped)
{"action": "stream", "id": "dev-server"}

// Get only new output since last check
{"action": "stream", "id": "dev-server", "since_last": true}

// Keep ANSI color codes
{"action": "stream", "id": "dev-server", "since_last": true, "strip_ansi": false}
```

### Process Management

```json
// List all sessions
{"action": "list"}
// Returns: "dev-server running /Users/you/project npm run dev\nanalyzer stopped /path/to/project python3 script.py"

// Stop specific process
{"action": "stop", "id": "dev-server"}
// Returns: "stopped dev-server"

// Stop ALL processes
{"action": "stop"}
// Returns: "stopped 3 processes"

// Check version compatibility
{"action": "version"}
// Returns: "1.2.2"
```

### Interactive AI Agents Example

```json
// Start Claude with a memorable name
{"action": "start", "command": "/Users/username/.claude/local/claude --dangerously-skip-permissions", "name": "claude"}

// Send a prompt with Enter
{"action": "stdin", "id": "claude", "data": "Write a test for main.py\r"}

// Get the response
{"action": "stdout", "id": "claude"}

// Clean up when done
{"action": "stop", "id": "claude"}
```

### Debugging with LLDB

```json
{"action": "start", "command": "lldb ./myapp", "name": "debugger"}
{"action": "stdin", "id": "debugger", "data": "break main\r"}
{"action": "stdin", "id": "debugger", "data": "run\r"}
{"action": "stdout", "id": "debugger"}  // Get the formatted debugger interface
{"action": "stdin", "id": "debugger", "data": "bt\r"}  // Backtrace
{"action": "stdout", "id": "debugger"}

// Navigate with arrow keys (\u001b[A = Up arrow)
{"action": "stdin", "id": "debugger", "data": "\u001b[A\u001b[A\r"}  // Up, Up, Enter
```

### Build Process Monitoring

```json
{"action": "start", "command": "npm run build", "name": "build"}
// Monitor build progress
{"action": "stream", "id": "build", "since_last": true}
// ... wait a bit ...
{"action": "stream", "id": "build", "since_last": true}  // Get only new output
```

## CLI Usage

terminalcp can also be used as a standalone CLI tool:

```bash
# List all active sessions
terminalcp ls

# Start a new session with a custom name
terminalcp start my-app "npm run dev"

# Attach to a session interactively (Ctrl+B to detach)
terminalcp attach my-app

# Get output from a session
terminalcp stdout my-app
terminalcp stdout my-app 50  # Last 50 lines

# Send input to a session (use :: prefix for special keys)
terminalcp stdin my-app "echo hello" ::Enter
terminalcp stdin my-app "echo test" ::Left ::Left ::Left "hi " ::Enter  # Navigate with arrows
terminalcp stdin my-app ::C-c  # Send Ctrl+C

# Monitor logs
terminalcp stream my-app --since-last

# Stop sessions
terminalcp stop my-app
terminalcp stop  # Stop all

# Maintenance
terminalcp version
terminalcp kill-server
```

## Attaching to Sessions

You can attach to any session from your terminal, e.g. to watch or interact with AI-spawned processes:

1. **AI spawns a process with a name**:
```json
{"action": "start", "command": "python3 -i", "name": "python-debug"}
```

2. **Attach from your terminal**:
```bash
terminalcp attach python-debug
```

3. **Interact directly**:
- Type commands as normal
- Terminal resizing is automatically synchronized
- Press **Ctrl+B** to detach (session continues running)
- Multiple users can attach to the same session simultaneously

This is perfect for debugging what the AI is doing, jumping in to help, or monitoring long-running processes.

## Important Usage Notes

- **MCP Escape Sequences**: Send special keys using escape sequences: `\r` (Enter), `\u001b[A` (Up), `\u0003` (Ctrl+C)
- **CLI Special Keys**: Use `::` prefix for special keys: `::Enter`, `::Left`, `::C-c`
- **Aliases don't work**: Commands run via `bash -c`, so use absolute paths or commands in PATH
- **Process persistence**: Sessions persist across MCP server restarts - manually stop them when done
- **Named sessions**: Use the `name` parameter when starting to create human-readable session IDs

### Common Escape Sequences (for MCP)
```json
// Basic keys
Enter: "\r"          Tab: "\t"         Escape: "\u001b"      Backspace: "\u007f"

// Control keys
Ctrl+C: "\u0003"     Ctrl+D: "\u0004"  Ctrl+Z: "\u001a"      Ctrl+L: "\u000c"

// Arrow keys
Up: "\u001b[A"       Down: "\u001b[B"   Right: "\u001b[C"     Left: "\u001b[D"

// Navigation
Home: "\u001b[H"     End: "\u001b[F"    PageUp: "\u001b[5~"   PageDown: "\u001b[6~"

// Function keys
F1: "\u001bOP"       F2: "\u001bOQ"     F3: "\u001bOR"        F4: "\u001bOS"

// Meta/Alt (ESC + character)
Alt+x: "\u001bx"     Alt+b: "\u001bb"   Alt+f: "\u001bf"
```

## How it works

terminalcp uses a layered architecture for flexibility and persistence:

### Architecture Layers

1. **TerminalManager** - Core library that manages PTY sessions
   - Creates and manages pseudo-TTY processes via node-pty
   - Maintains virtual terminals using xterm.js headless
   - Handles input/output, ANSI sequences, and terminal emulation
   - Provides the programmatic API for all terminal operations

2. **TerminalServer** - Persistent background process
   - Auto-spawns when needed by CLI or MCP
   - Listens on Unix domain socket at `~/.terminalcp/server.socket`
   - Manages all active terminal sessions across clients
   - Sessions persist even when clients disconnect
   - Single server instance handles all terminalcp operations

3. **TerminalClient** - Communication layer
   - Used by both CLI and MCP to talk to TerminalServer
   - Sends commands over Unix socket
   - Receives responses and terminal output
   - Handles connection management and retries

4. **User Interfaces**
   - **MCP Server**: Exposes `terminalcp` tool, uses TerminalClient to communicate with TerminalServer
   - **CLI**: Command-line interface, uses TerminalClient to communicate with TerminalServer
   - Both interfaces provide the same functionality through different entry points

Each process runs in a proper pseudo-TTY with full terminal emulation. Commands are executed through `bash -c` for proper PTY handling, preserving colors, cursor movement, and special key sequences.

### MCP Tool: `terminalcp`

The terminalcp MCP server exposes a single tool called `terminalcp` that accepts JSON commands with different action types. This unified tool design is more efficient than exposing each action as a separate tool, reducing overhead and providing a consistent interface for all terminal operations.

The terminalcp tool accepts a JSON object with different action types:

#### Start a process
```json
{
  "action": "start",
  "command": "npm run dev",
  "cwd": "/path/to/project",  // optional
  "name": "dev-server"  // optional: becomes the session ID
}
```
**Returns**: Session ID string (either the provided name or auto-generated like "proc-3465b9b687af")

#### Stop a process
```json
// Stop a specific process
{
  "action": "stop",
  "id": "proc-abc123"
}

// Stop ALL processes
{
  "action": "stop"
}
```
**Returns**: Confirmation of termination

#### Get terminal screen output (stdout)
```json
{
  "action": "stdout",
  "id": "proc-abc123",
  "lines": 50  // Optional: limit to last N lines
}
```
**Returns**: Rendered terminal buffer with up to 10,000 lines of scrollback history

Use `stdout` for:
- TUI applications (vim, htop, less)
- Interactive debuggers (gdb, lldb)
- REPLs with formatted output
- Any tool where visual formatting matters

Note: If scrollback exceeds viewport, the TUI may handle scrolling internally. To send Page Up/Down keys:
- **MCP**: `{"action": "stdin", "id": "session-id", "data": "\u001b[5~"}` (Page Up) or `"\u001b[6~"` (Page Down)
- **CLI**: `terminalcp stdin session-id ::PageUp` or `::PageDown`
- **TerminalManager**: `await manager.sendInput(id, '\x1b[5~')` (Page Up) or `buildInput('PageUp')`

#### Get raw stream output
```json
{
  "action": "stream",
  "id": "proc-abc123",
  "since_last": true,  // Optional: only new output since last read (default: false)
  "strip_ansi": false  // Optional: keep ANSI escape codes (default: true, codes are stripped)
}
```
**Returns**: Raw output stream with ANSI codes stripped by default (set strip_ansi: false to keep them)

Use `stream` for:
- Incremental log monitoring (with `since_last: true`)
- Build processes and compilation output
- High-volume streaming data
- When you need clean text output without terminal control codes
- Set `strip_ansi: false` only if you need the raw ANSI sequences

#### Send input to a process

Send text and special keys using escape sequences in a string:

```json
{
  "action": "stdin",
  "id": "dev-server",
  "data": "ls -la\r"  // Text with Enter key (\r)
}
```
**Returns**: Empty string

**Examples:**
```json
// Simple text with Enter
{"action": "stdin", "id": "session", "data": "echo hello\r"}

// Navigate with arrow keys
{"action": "stdin", "id": "session", "data": "echo test\u001b[D\u001b[D\u001b[D\u001b[Dhi \r"}

// Control sequences
{"action": "stdin", "id": "session", "data": "\u0003"}  // Ctrl+C
{"action": "stdin", "id": "session", "data": "sleep 10\r"}  // Start sleep
{"action": "stdin", "id": "session", "data": "\u001a"}  // Ctrl+Z to suspend

// Complex interaction (vim)
{"action": "stdin", "id": "session", "data": "vim test.txt\r"}
{"action": "stdin", "id": "session", "data": "iHello World\u001b:wq\r"}  // Insert, type, ESC, save & quit
```

See "Common Escape Sequences" in Important Usage Notes for a complete reference.

#### Get terminal size
```json
{
  "action": "term-size",
  "id": "dev-server"
}
```
**Returns**: String like "24 80 150" (rows, columns, scrollback lines)

#### List all processes
```json
{
  "action": "list"
}
```
**Returns**: Newline-separated list of sessions with format: "id status cwd command"

#### Check server version
```json
{
  "action": "version"
}
```
**Returns**: Version string (e.g., "1.2.2")

#### Kill the terminal server
```json
{
  "action": "kill-server"
}
```
**Returns**: "shutting down"

## Programmatic TUI Control with TerminalManager

The `TerminalManager` class provides a programmatic API for driving TUI applications, useful for automation, testing, or building higher-level abstractions. It handles the complexities of terminal emulation, ANSI sequences, and interactive session management.

### Basic Usage

```typescript
import { TerminalManager } from '@mariozechner/terminalcp';

// Create a manager instance
const manager = new TerminalManager();

// Start a TUI application
const sessionId = await manager.start('vim test.txt', {
  cwd: '/path/to/project',
  name: 'vim-session'
});

// Send keystrokes (using raw escape sequences)
await manager.sendInput(sessionId, 'i');  // Enter insert mode
await manager.sendInput(sessionId, 'Hello, World!');
await manager.sendInput(sessionId, '\x1b');  // ESC key
await manager.sendInput(sessionId, ':wq\r');  // Save and quit

// Or use the buildInput helper for symbolic key names
import { buildInput } from '@mariozechner/terminalcp';
await manager.sendInput(sessionId, buildInput('i', 'Hello, World!', 'Escape', ':wq', 'Enter'));

// Get the rendered terminal screen
const screen = await manager.stdout(sessionId);
console.log(screen);

// Clean up
await manager.stop(sessionId);
```

### Advanced TUI Interaction

```typescript
// Drive interactive debuggers
const debugId = await manager.start('lldb ./myapp');
await manager.sendInput(debugId, 'break main\r');
await manager.sendInput(debugId, 'run\r');

// Wait for output to settle
await new Promise(resolve => setTimeout(resolve, 100));

// Get terminal output
const output = await manager.stdout(debugId);

// Send special keys using escape sequences
await manager.sendInput(debugId, '\x1b[A');  // Up arrow
await manager.sendInput(debugId, '\x1b[B');  // Down arrow

// Or use buildInput helper for readability
import { buildInput } from '@mariozechner/terminalcp';
await manager.sendInput(debugId, buildInput('Up', 'Up', 'Enter'));  // Navigate command history

// Monitor streaming output
const logs = await manager.stream(debugId, { sinceLast: true });
```

### Testing TUI Applications

```typescript
describe('TUI Application Tests', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    manager = new TerminalManager();
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  test('vim navigation', async () => {
    const id = await manager.start('vim');

    // Enter text
    await manager.sendInput(id, 'iHello\x1b');

    // Navigate
    await manager.sendInput(id, 'gg');  // Go to top
    await manager.sendInput(id, 'G');   // Go to bottom

    // Verify screen content
    const screen = await manager.stdout(id);
    expect(screen).toContain('Hello');
  });

  test('interactive REPL', async () => {
    const id = await manager.start('python3 -i');

    // Wait for prompt
    await waitForOutput(manager, id, '>>>');

    // Send command
    await manager.sendInput(id, '2 + 2\r');

    // Check result
    const output = await manager.stdout(id);
    expect(output).toContain('4');
  });
});

async function waitForOutput(
  manager: TerminalManager,
  id: string,
  pattern: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const output = await manager.stdout(id);
    if (output.includes(pattern)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for: ${pattern}`);
}
```

### Common ANSI Sequences for TUI Control

```typescript
// Special keys
const KEYS = {
  ESCAPE: '\x1b',
  ENTER: '\r',
  TAB: '\t',
  BACKSPACE: '\x7f',
  DELETE: '\x1b[3~',

  // Control keys
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  CTRL_Z: '\x1a',
  CTRL_L: '\x0c',  // Clear screen

  // Navigation
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  HOME: '\x1b[H',
  END: '\x1b[F',
  PAGE_UP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',

  // Function keys
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
};

// Example: Navigate a menu-based TUI
await manager.sendInput(id, KEYS.DOWN);
await manager.sendInput(id, KEYS.DOWN);
await manager.sendInput(id, KEYS.ENTER);

// Or use the buildInput helper
import { buildInput } from '@mariozechner/terminalcp';
await manager.sendInput(id, buildInput('Down', 'Down', 'Enter'));
```

### Tips for Driving TUIs

1. **Timing**: TUIs often need time to process input and render. Add small delays between commands when necessary.

2. **Screen vs Stream**: Use `stdout()` for TUIs that maintain a visual layout, `stream()` for scrolling output.

3. **Terminal Size**: Default is 80x24. Some TUIs may behave differently at different sizes.

4. **Input Modes**: Some TUIs distinguish between line mode and character mode. Append `\r` to send Enter when needed.

5. **Scrollback**: The terminal maintains up to 10,000 lines of scrollback. For TUIs with internal scrolling, send Page Up/Down keys (`\x1b[5~` / `\x1b[6~`) instead of relying on scrollback.

## Development

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Run ad-hoc for debugging in VS Code JavaScript Terminal
npx tsx src/index.ts start python python3 -i

# Run tests (uses Node.js built-in test framework)
npm test

# Run specific test file(s)
npx tsx --test test/key-parser.test.ts
npx tsx --test test/key-parser.test.ts test/mcp-server.test.ts

# Run tests matching a pattern
npx tsx --test --test-name-pattern="should handle symbolic keys" test/mcp-server.test.ts

# Run checks (linting, formatting, type checking)
npm run check
```

## Comparison with screen/tmux

### Can you use screen?

Technically yes, but it's significantly more complex and limited. Here's how Claude would try to emulate terminalcp with screen:

#### Starting a process
```bash
# terminalcp
{"action": "start", "command": "python3 -i", "name": "repl"}
# Returns: "repl"

# screen equivalent
screen -dmS repl -L python3 -i
# No feedback on success/failure
```

#### Sending input
```bash
# terminalcp
{"action": "stdin", "id": "repl", "data": "2+2\r"}
# Returns: ""

# screen equivalent
screen -S repl -X stuff $'2+2\n'
# No confirmation the command was received
```

#### Getting output
```bash
# terminalcp
{"action": "stdout", "id": "repl"}
# Returns: Clean, rendered terminal output as string

# screen equivalent  
# Workaround for v4.0.3 bug: attach/detach once per session with expect
expect -c 'spawn screen -r repl; send "\001d"; expect eof' >/dev/null 2>&1
screen -S repl -p 0 -X hardcopy output.txt
cat output.txt
# Note: v4.0.3 has hardcopy bug, needs one-time attach: https://stackoverflow.com/questions/36145175/
```

#### Monitoring changes
```bash
# terminalcp
{"action": "stream", "id": "repl", "since_last": true}
# Returns: Only new output since last check

# screen equivalent
# No built-in way - must diff files or parse screenlog manually
tail -f screenlog.0 | grep "pattern"  # Crude approximation
```

### Can you use tmux?

Similar to screen, tmux can also be used as a replacement for terminalcp. Compared to screen, it is a much better choice.

#### Starting a process
```bash
# terminalcp
{"action": "start", "command": "python3 -i", "name": "repl"}
# Returns: "repl"

# tmux equivalent
tmux new-session -d -s repl python3 -i
# No feedback on success/failure
# If you want to capture output, must set up pipe-pane immediately:
tmux pipe-pane -t repl -o "cat >> /tmp/repl.log"
# WARNING: Any output between session start and pipe-pane activation is lost!
```

#### Sending input
```bash
# terminalcp
{"action": "stdin", "id": "repl", "data": "import os\r"}
# Returns: ""

# tmux equivalent
tmux send-keys -t repl "import os" Enter
# No confirmation the command was received
```

#### Getting output
```bash
# terminalcp
{"action": "stdout", "id": "repl"}
# Returns: Clean, rendered terminal output as string

# tmux equivalent
tmux capture-pane -t repl -p
# Returns: Current visible pane only
# OR with full scrollback:
tmux capture-pane -t repl -p -S -
# Returns: Clean rendered output with scrollback
```

#### Monitoring changes
```bash
# terminalcp
{"action": "stream", "id": "repl", "since_last": true}
# Returns: Only new output since last check

# tmux equivalent
# No built-in incremental reading
# Must be set up when session starts to capture all output
tmux pipe-pane -t repl -o "cat >> /tmp/tmux.log"  # -o flag required to activate
tail -f /tmp/tmux.log  # Still shows everything, not just new
```

### Key differences of screen/tmux

1. **No incremental reading** - Can't easily get "what's new since last check" 
2. **Process lifecycle complexity** - Requires `remain-on-exit` (tmux) to track exit codes, sessions auto-close by default
3. **Initial output loss** - With tmux pipe-pane, any output between session creation and pipe activation is lost (e.g., Python's startup banner)
4. **Version-specific bugs** - screen v4.0.3 (common on macOS) has [broken hardcopy command](https://stackoverflow.com/questions/36145175/)

## License

MIT