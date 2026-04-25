import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import * as pty from "node-pty";

// Logs land at ~/.terminalcp/logs/${name}-${timestamp}.log via two paths: a one-shot exit dump
// (MCP attached the whole time) or a tee-on-disconnect stream (MCP gone mid-session). Override
// dir via TERMINALCP_LOG_DIR.
export function getLogDir(): string {
	return process.env.TERMINALCP_LOG_DIR || path.join(os.homedir(), ".terminalcp", "logs");
}

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function fileTimestamp(d: Date): string {
	return d.toISOString().replace(/[:.]/g, "-");
}

function logPathFor(logDir: string, proc: { id: string; startedAt: Date }): string {
	return path.join(logDir, `${sanitizeName(proc.id)}-${fileTimestamp(proc.startedAt)}.log`);
}

function closeStream(proc: ManagedTerminal): void {
	if (!proc.logStream) return;
	try {
		proc.logStream.end();
	} catch {
		// stream already destroyed — fine
	}
	proc.logStream = undefined;
}

class WriteQueue {
	private queue = Promise.resolve();

	enqueue(writeFn: () => Promise<void> | void): void {
		this.queue = this.queue
			.then(() => writeFn())
			.catch((error) => {
				console.error("WriteQueue error:", error);
			});
	}

	async drain(): Promise<void> {
		await this.queue;
	}
}

export interface ManagedTerminal {
	id: string;
	command: string;
	cwd: string;
	process: pty.IPty;
	terminal: XtermTerminalType;
	startedAt: Date;
	rawOutput: string;
	lastStreamReadPosition: number;
	terminalWriteQueue: WriteQueue;
	ptyWriteQueue: WriteQueue;
	running: boolean;
	exitCode?: number;
	/**
	 * Active write stream for tee'd persistence. Only set after beginPersistRunningSessions has
	 * fired (i.e., all MCP clients disconnected while this session was running). When active, every
	 * PTY chunk is also written here. On session exit the stream is closed and the file is final.
	 */
	logStream?: fs.WriteStream;
}

export class TerminalManager {
	private processes = new Map<string, ManagedTerminal>();
	private outputHandlers = new Map<string, (sessionId: string, data: string) => void>();

	/**
	 * Start a new process with virtual terminal
	 */
	async start(command: string, options?: { cwd?: string; name?: string }): Promise<string> {
		const id = options?.name || `proc-${crypto.randomBytes(6).toString("hex")}`;
		if (this.processes.has(id)) {
			throw new Error(`Session '${id}' already exists`);
		}

		const terminal = new xterm.Terminal({
			cols: 80,
			rows: 24,
			scrollback: 10000,
			allowProposedApi: true,
			convertEol: true,
		});

		const proc = pty.spawn(process.env.SHELL || "/bin/bash", ["-c", command], {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd: options?.cwd || process.cwd(),
			env: {
				...process.env,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				FORCE_COLOR: "1",
			} as { [key: string]: string },
		});

		const processEntry: ManagedTerminal = {
			id,
			command,
			cwd: options?.cwd || process.cwd(),
			process: proc,
			terminal,
			startedAt: new Date(),
			rawOutput: "",
			lastStreamReadPosition: 0,
			terminalWriteQueue: new WriteQueue(),
			ptyWriteQueue: new WriteQueue(),
			running: true,
		};

		proc.onData((data) => {
			processEntry.terminalWriteQueue.enqueue(async () => {
				processEntry.rawOutput += data;
				// Tee path D: if persistence has been turned on for this session, mirror each PTY chunk
				// to disk as it arrives. Wrapped so a broken stream can't take down the daemon.
				if (processEntry.logStream) {
					try {
						processEntry.logStream.write(data);
					} catch (err) {
						console.error(`[terminalcp] log stream write error for ${id}:`, err);
						processEntry.logStream = undefined;
					}
				}
				await new Promise<void>((resolve) => {
					terminal.write(data, () => resolve());
				});
				const handler = this.outputHandlers.get(id);
				if (handler) {
					handler(id, data);
				}
			});
		});

		proc.onExit((exitCode) => {
			const code = exitCode.exitCode;
			const signal = exitCode.signal;
			const exitMsg = `\n[Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}]\n`;

			// Mark process as not running
			processEntry.running = false;
			processEntry.exitCode = code;

			processEntry.terminalWriteQueue.enqueue(async () => {
				processEntry.rawOutput += exitMsg;
				// Persist the exit message into a tee'd stream too, before we close it.
				if (processEntry.logStream) {
					try {
						processEntry.logStream.write(exitMsg);
					} catch {
						// Ignore — closing anyway.
					}
				}
				await new Promise<void>((resolve) => {
					terminal.write(exitMsg, () => resolve());
				});
				// Two paths for log persistence on exit:
				//   - If a tee stream is active (D), close it cleanly.
				//   - Otherwise (A), do a one-shot dump of the full rawOutput. This is the common
				//     case when Claude Code stayed attached the whole time — we still want a recovery
				//     log on disk for the user to grep/cat later.
				if (processEntry.logStream) {
					closeStream(processEntry);
				} else {
					this.writeFinalLog(processEntry).catch((err) => {
						console.error(`[terminalcp] final log dump failed for ${id}:`, err);
					});
				}
			});
		});

		this.processes.set(id, processEntry);
		return id;
	}

	/**
	 * Stop a process
	 */
	async stop(id: string): Promise<void> {
		const proc = this.processes.get(id);
		if (!proc) {
			throw new Error(`Process not found: ${id}`);
		}
		// onExit may not fire when we kill directly — close any tee stream now so the file is sealed.
		closeStream(proc);
		proc.process.kill();
		this.processes.delete(id);
	}

	/**
	 * Begin persisting all currently-running sessions to disk. Called by the daemon when its last
	 * MCP client disconnects, so any in-flight session (e.g. a long build that's still running
	 * after Claude Code closed) can be recovered later via `terminalcp logs`. The current rawOutput
	 * is written as the catch-up chunk, then onData appends each new chunk going forward.
	 */
	beginPersistRunningSessions(): void {
		const logDir = getLogDir();
		try {
			fs.mkdirSync(logDir, { recursive: true });
		} catch (err) {
			console.error("[terminalcp] failed to create log dir:", err);
			return;
		}

		for (const proc of this.processes.values()) {
			if (!proc.running || proc.logStream) continue;
			try {
				const logPath = logPathFor(logDir, proc);
				const stream = fs.createWriteStream(logPath, { flags: "w" });
				stream.on("error", (err) => {
					console.error(`[terminalcp] log stream error for ${proc.id}:`, err);
					proc.logStream = undefined;
				});
				// Catch-up: flush everything so far, then onData will append new chunks as they arrive.
				stream.write(proc.rawOutput);
				proc.logStream = stream;
				console.error(`[terminalcp] persisting ${proc.id} to ${logPath}`);
			} catch (err) {
				console.error(`[terminalcp] failed to begin persisting ${proc.id}:`, err);
			}
		}
	}

	/**
	 * One-shot final dump of a session's rawOutput. Used by the exit path when no tee stream was
	 * ever opened — i.e. the common case where Claude Code stayed attached the whole time.
	 */
	private async writeFinalLog(proc: ManagedTerminal): Promise<void> {
		const logDir = getLogDir();
		await fs.promises.mkdir(logDir, { recursive: true });
		await fs.promises.writeFile(logPathFor(logDir, proc), proc.rawOutput);
	}

	/**
	 * Stop all processes
	 */
	async stopAll(): Promise<void> {
		const ids = Array.from(this.processes.keys());
		for (const id of ids) {
			await this.stop(id);
		}
	}

	/**
	 * Send input to a process
	 */
	async sendInput(id: string, data: string): Promise<void> {
		const proc = this.processes.get(id);
		if (!proc) {
			throw new Error(`Session not found: ${id}`);
		}

		if (!proc.running) {
			throw new Error(
				`Session ${id} is not running (pid: ${proc.process.pid}, exit code: ${proc.exitCode ?? "unknown"}). Check stdout or stream.`,
			);
		}

		// Scan through string and handle \r specially (unless it's part of \r\n)
		// This helps with some TUI apps that need \r sent separately
		let buffer = "";

		for (let i = 0; i < data.length; i++) {
			if (data[i] === "\r") {
				// Check if next character is \n (Windows line ending)
				if (i + 1 < data.length && data[i + 1] === "\n") {
					// It's \r\n, keep them together
					buffer += "\r\n";
					i++; // Skip the \n since we already added it
				} else {
					// It's a standalone \r, send buffer then \r separately
					if (buffer) {
						const bufferCopy = buffer; // Capture buffer value for closure
						proc.ptyWriteQueue.enqueue(() => {
							proc.process.write(bufferCopy);
						});
						buffer = "";
					}

					// Send \r separately with a small delay
					proc.ptyWriteQueue.enqueue(async () => {
						// Small delay helps some TUIs recognize \r as Enter
						await new Promise((resolve) => setTimeout(resolve, 200));
						proc.process.write("\r");
					});
				}
			} else {
				buffer += data[i];
			}
		}

		// Send any remaining buffer
		if (buffer) {
			const bufferCopy = buffer; // Capture buffer value for closure
			proc.ptyWriteQueue.enqueue(() => {
				proc.process.write(bufferCopy);
			});
		}
		await proc.ptyWriteQueue.drain();
	}

	/**
	 * Get terminal output (rendered)
	 */
	async getOutput(id: string, options?: { lines?: number }): Promise<string> {
		const proc = this.processes.get(id);
		if (!proc) {
			throw new Error(`Process not found: ${id}`);
		}

		// Ensure terminal writes are complete
		await proc.terminalWriteQueue.drain();

		const buffer = proc.terminal.buffer.active;
		const lines = [];
		const endRow = buffer.length;

		// Get all lines first
		for (let i = 0; i < endRow; i++) {
			const line = buffer.getLine(i);
			if (line) {
				lines.push(line.translateToString(true));
			}
		}

		// Remove trailing empty lines
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
			lines.pop();
		}

		// Apply line limit after removing empty lines
		if (options?.lines && lines.length > options.lines) {
			return lines.slice(-options.lines).join("\n");
		}

		return lines.join("\n");
	}

	/**
	 * Get raw output stream
	 */
	async getStream(id: string, options?: { since_last?: boolean; strip_ansi?: boolean }): Promise<string> {
		const proc = this.processes.get(id);
		if (!proc) {
			throw new Error(`Process not found: ${id}`);
		}

		let output: string;
		if (options?.since_last) {
			output = proc.rawOutput.substring(proc.lastStreamReadPosition);
			proc.lastStreamReadPosition = proc.rawOutput.length;
		} else {
			output = proc.rawOutput;
		}

		// Strip ANSI codes by default (can be disabled by setting strip_ansi: false)
		if (options?.strip_ansi !== false && output) {
			output = stripVTControlCharacters(output);
		}

		return output;
	}

	/**
	 * Get terminal size
	 */
	getTerminalSize(id: string): { rows: number; cols: number; scrollback_lines: number } {
		const proc = this.processes.get(id);
		if (!proc) {
			throw new Error(`Process not found: ${id}`);
		}

		return {
			rows: proc.terminal.rows,
			cols: proc.terminal.cols,
			scrollback_lines: proc.terminal.buffer.active.length,
		};
	}

	/**
	 * Resize terminal
	 */
	resizeTerminal(id: string, cols: number, rows: number): void {
		const proc = this.processes.get(id);
		if (!proc) {
			throw new Error(`Process not found: ${id}`);
		}

		proc.process.resize(cols, rows);
		proc.terminal.resize(cols, rows);
	}

	/**
	 * List all processes
	 */
	listProcesses(): Array<{
		id: string;
		command: string;
		cwd: string;
		startedAt: string;
		running: boolean;
		pid?: number;
	}> {
		return Array.from(this.processes.values()).map((p) => ({
			id: p.id,
			command: p.command,
			cwd: p.cwd,
			startedAt: p.startedAt.toISOString(),
			running: p.running,
			pid: p.process.pid,
		}));
	}

	/**
	 * Get a specific process
	 */
	getProcess(id: string): ManagedTerminal | undefined {
		return this.processes.get(id);
	}

	/**
	 * Register an output handler
	 */
	onOutput(sessionId: string, handler: (sessionId: string, data: string) => void): void {
		this.outputHandlers.set(sessionId, handler);
	}

	/**
	 * Unregister an output handler
	 */
	offOutput(sessionId: string): void {
		this.outputHandlers.delete(sessionId);
	}
}
