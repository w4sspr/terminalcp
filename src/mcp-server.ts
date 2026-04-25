import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Args } from "./messages.js";
import { TerminalClient } from "./terminal-client.js";

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (fs.existsSync(socketPath)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`terminalcp daemon socket did not appear at ${socketPath} within ${timeoutMs}ms`);
}

export async function runMCPServer(): Promise<void> {
	// Per-session isolation: each MCP instance gets its own daemon at a unique socket path
	// keyed by this process's PID. Closes the door on cross-session interference (one Claude
	// Code window's cleanup can no longer touch another window's daemon).
	const socketPath = path.join(os.tmpdir(), `terminalcp-mcp-${process.pid}.sock`);

	// Spawn the dedicated daemon as a non-detached child so its lifecycle is bound to ours.
	// Three layers of cleanup: (1) explicit kill below on SIGTERM/SIGINT/exit; (2) daemon's
	// own idle timeout (defaults to 30min, gated on no-running-sessions so long builds aren't
	// killed); (3) socket path is per-PID, so even leaks don't collide with other sessions.
	const daemonScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
	const daemon = spawn(process.execPath, [daemonScript, "--server"], {
		env: {
			...process.env,
			TERMINALCP_SOCKET: socketPath,
		},
		// stderr inherits so daemon errors surface in the MCP server's stderr (visible in
		// Claude Code's MCP debug logs). stdin/stdout ignored — the daemon only talks via socket.
		stdio: ["ignore", "ignore", "inherit"],
		detached: false,
	});

	daemon.on("error", (err) => {
		console.error("[terminalcp] daemon spawn error:", err);
	});
	daemon.on("exit", (code, signal) => {
		console.error(`[terminalcp] daemon exited (code=${code}, signal=${signal})`);
	});

	// Idempotent kill helper, registered on every shutdown signal we care about.
	let killed = false;
	const killDaemon = (): void => {
		if (killed) return;
		killed = true;
		try {
			daemon.kill("SIGTERM");
		} catch {
			// Already dead — ignore.
		}
	};
	process.on("exit", killDaemon);

	// Block until the daemon has bound its socket. Without this, the first TerminalClient
	// request would race the daemon's `listen()` and trigger the auto-spawn fallback path,
	// which would create a *second* daemon (orphaned) at the same socket path.
	try {
		await waitForSocket(socketPath, 5000);
	} catch (err) {
		console.error("[terminalcp] daemon failed to start within 5s:", err);
		killDaemon();
		throw err;
	}

	const serverClient = new TerminalClient(socketPath);

	const server = new Server(
		{
			name: "terminalcp",
			version: "1.0.0",
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	// Define the terminal tool
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: "terminalcp",
				description: `Control background processes with virtual terminals. IMPORTANT: Always clean up processes with "stop" action when done.

Examples:
  Start dev server: {"action": "start", "command": "npm run dev", "cwd": "/path/to/project"}
  Send text with Enter: {"action": "stdin", "id": "proc-123", "data": "npm test\\r"}
  Send arrow keys: {"action": "stdin", "id": "proc-123", "data": "echo hello\\u001b[D\\u001b[D\\u001b[Dhi \\r"}
  Send Ctrl+C: {"action": "stdin", "id": "proc-123", "data": "\\u0003"}
  Stop process: {"action": "stop", "id": "proc-abc123"}
  Stop all processes: {"action": "stop"}

  Get terminal screen: {"action": "stdout", "id": "proc-123"}  # Current view + scrollback
  Get last 50 lines: {"action": "stdout", "id": "proc-123", "lines": 50}
  Get all output ever: {"action": "stream", "id": "proc-123"}  # From process start
  Get new output only: {"action": "stream", "id": "proc-123", "since_last": true}  # Since last stream call

Output modes:
  stdout: Terminal emulator output - returns the rendered screen as user would see it.
          Limited to 10K lines scrollback. Best for: interactive tools, TUIs, REPLs, debuggers.

  stream: Raw process output - returns all text the process has written to stdout/stderr.
          Strips ANSI codes by default (set strip_ansi: false to keep). No limit on history.
          With since_last: true, returns only new output since last stream call on this process.
          Best for: build logs, test output, monitoring long-running processes.

Common escape sequences for stdin:
  Enter: \\r or \\u000d
  Tab: \\t or \\u0009
  Escape: \\u001b
  Backspace: \\u007f
  Ctrl+C: \\u0003
  Ctrl+D: \\u0004
  Ctrl+Z: \\u001a

  Arrow keys: Up=\\u001b[A Down=\\u001b[B Right=\\u001b[C Left=\\u001b[D
  Navigation: Home=\\u001b[H End=\\u001b[F PageUp=\\u001b[5~ PageDown=\\u001b[6~
  Delete: \\u001b[3~ Insert: \\u001b[2~
  Function keys: F1=\\u001bOP F2=\\u001bOQ F3=\\u001bOR F4=\\u001bOS
  Meta/Alt: Alt+x=\\u001bx (ESC followed by character)

Interactive examples:
  Vim: stdin "vim test.txt\\r" → stdin "iHello\\u001b:wq\\r" → stdout
  Python: start "python3 -i" → stdin "2+2\\r" → stdout
  Build monitoring: start "npm run build" → stream (since_last: true) → repeat
  Interrupt: stdin "sleep 10\\r" → stdin "\\u0003" (Ctrl+C)

Note: Commands run via bash -c. Use absolute paths, not aliases.`,
				inputSchema: {
					type: "object",
					properties: {
						args: {
							type: "object",
							properties: {
								action: {
									type: "string",
									enum: ["start", "stop", "stdout", "stdin", "list", "stream", "term-size", "kill-server"],
									description: "The action to perform",
								},
								command: {
									type: "string",
									description: "Command to execute (required for 'start' action)",
								},
								cwd: {
									type: "string",
									description: "Working directory for the process (optional for 'start' action)",
								},
								name: {
									type: "string",
									description: "Human-readable name for the session (optional for 'start' action)",
								},
								id: {
									type: "string",
									description:
										"Process ID (required for 'stdout', 'stdin', 'stream', 'term-size' actions; optional for 'stop' - if omitted, stops all processes)",
								},
								data: {
									type: "string",
									description:
										"String to send to stdin with escape sequences (e.g., '\\r' for Enter, '\\u001b[A' for Up arrow)",
								},
								lines: {
									type: "number",
									description: "Number of lines to retrieve (optional for 'stdout' action)",
								},
								since_last: {
									type: "boolean",
									description:
										"Only return output since last stream read (optional for 'stream' action, defaults to false)",
								},
								strip_ansi: {
									type: "boolean",
									description:
										"Strip ANSI escape codes from output (optional for 'stream' action, defaults to true)",
								},
							},
							required: ["action"],
							additionalProperties: false,
						},
					},
					required: ["args"],
					additionalProperties: false,
				},
			},
		],
	}));

	// Handle terminal tool calls
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name !== "terminalcp") {
			throw new Error(`Unknown tool: ${request.params.name}`);
		}
		const args = request.params.arguments?.args as Args;
		if (!args || typeof args !== "object") {
			throw new Error("Invalid arguments: expected JSON object");
		}

		try {
			const result = await serverClient.request(args);
			return {
				content: [
					{
						type: "text",
						text: result || "",
					},
				],
			};
		} catch (error) {
			// Handle cases where server is not running - but NOT for start actions (let auto-start work)
			if (error instanceof Error && (error.message === "No server running" || error.message === "Request timeout")) {
				if (args.action === "list") {
					return {
						content: [
							{
								type: "text",
								text: "No active sessions",
							},
						],
					};
				} else if (args.action === "start") {
					// Don't catch errors for start actions - let the terminal client auto-start
					throw error;
				} else {
					return {
						content: [
							{
								type: "text",
								text: `Error: No terminal server running. Use "list" to check status or start a process to auto-start the server.`,
							},
						],
					};
				}
			}
			throw error;
		}
	});

	// Cleanup on exit — both signals tear down client and daemon before exiting.
	const shutdown = (signal: string) => {
		console.error(`Shutting down MCP server (${signal})...`);
		serverClient.close();
		killDaemon();
		process.exit(0);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	// Start the server
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`terminalcp MCP server running on stdio (daemon socket: ${socketPath})`);
}
