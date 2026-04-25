import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Args,
	type AttachArgs,
	type AttachResult,
	createRequest,
	type DetachArgs,
	type KillServerArgs,
	type ListArgs,
	type ResizeArgs,
	type ServerEvent,
	type ServerMessage,
	type ServerResponse,
	type StartArgs,
	type StdinArgs,
	type StdoutArgs,
	type StopArgs,
	type StreamArgs,
	type TermSizeArgs,
	type VersionArgs,
} from "./messages.js";
import { startServer } from "./terminal-server.js";

// Read version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const CLIENT_VERSION = packageJson.version;

export class TerminalClient {
	private socket?: net.Socket;
	private serverSocketPath: string;
	// biome-ignore lint/suspicious/noExplicitAny: Hard to type this without a lot of effort
	private pendingRequests = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void }>();
	private eventHandlers = new Map<string, (event: ServerEvent) => void>();
	private connected = false;
	private connectPromise?: Promise<void>;

	constructor(socketPath?: string) {
		// Explicit arg > env var > historical default. The env var lets a daemon spawned by the
		// auto-spawn path (which inherits env from the client process) bind to the same per-instance
		// socket the client is connecting to.
		this.serverSocketPath =
			socketPath || process.env.TERMINALCP_SOCKET || path.join(os.homedir(), ".terminalcp", "server.sock");
	}

	/**
	 * Connect to the terminal server, starting it if necessary
	 */
	async connect(skipVersionCheck = false, autoStart = true): Promise<void> {
		// If already connecting, wait for that
		if (this.connectPromise) {
			return this.connectPromise;
		}

		// If already connected, return immediately
		if (this.connected) {
			return;
		}

		this.connectPromise = this.doConnect(skipVersionCheck, autoStart);
		return this.connectPromise;
	}

	private async doConnect(skipVersionCheck = false, autoStart = true): Promise<void> {
		// Check if server is already running
		if (await this.isServerRunning()) {
			await this.connectToServer();
			// Check version compatibility (unless explicitly skipped)
			if (!skipVersionCheck) {
				await this.checkServerVersion();
			}
		} else {
			// Only start the server if autoStart is true
			if (!autoStart) {
				throw new Error("No server running");
			}

			// Start the server (will be same version)
			await startServer();

			// Wait for server to start with retries
			let retries = 10;
			while (retries > 0) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				if (await this.isServerRunning()) {
					break;
				}
				retries--;
			}

			if (retries === 0) {
				throw new Error("Failed to start server");
			}

			// Try to connect
			await this.connectToServer();
			// No need to check version - we just started it
		}
	}

	private async checkServerVersion(): Promise<void> {
		try {
			const serverVersion = await this.request({ action: "version" } as VersionArgs);
			if (serverVersion !== CLIENT_VERSION) {
				throw new Error(
					`Server version mismatch: server is v${serverVersion}, client is v${CLIENT_VERSION}. ` +
						`Please run 'terminalcp kill-server' to stop the old server (this will terminate all managed processes).`,
				);
			}
		} catch (err) {
			// If it's already an error about version mismatch, re-throw it
			if (err instanceof Error && err.message.includes("Server version mismatch")) {
				throw err;
			}
			// Otherwise, old server doesn't support version action - must be pre-1.2.2
			throw new Error(
				`Server version mismatch: server is pre-v1.2.2 (doesn't support version check), client is v${CLIENT_VERSION}. ` +
					`Please run 'terminalcp kill-server' to stop the old server (this will terminate all managed processes).`,
			);
		}
	}

	/**
	 * Check if the server is running
	 */
	private async isServerRunning(): Promise<boolean> {
		return new Promise((resolve) => {
			if (!fs.existsSync(this.serverSocketPath)) {
				resolve(false);
				return;
			}
			const socket = net.createConnection(this.serverSocketPath);
			const timeout = setTimeout(() => {
				socket.destroy();
				resolve(false);
			}, 100);

			socket.once("connect", () => {
				clearTimeout(timeout);
				socket.end();
				resolve(true);
			});

			socket.once("error", () => {
				clearTimeout(timeout);
				resolve(false);
			});
		});
	}

	/**
	 * Connect to the running server
	 */
	private async connectToServer(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection(this.serverSocketPath);

			let buffer = "";

			this.socket.on("connect", () => {
				this.connected = true;
				resolve();
			});

			this.socket.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.trim()) {
						try {
							const message: ServerMessage = JSON.parse(line);
							this.handleMessage(message);
						} catch (err) {
							console.error("Failed to parse server message:", err);
						}
					}
				}
			});

			this.socket.on("close", () => {
				this.connected = false;
				this.socket = undefined;

				// Reject all pending requests
				for (const [_id, { reject }] of this.pendingRequests) {
					reject(new Error("Server connection closed"));
				}
				this.pendingRequests.clear();
			});

			this.socket.on("error", (err) => {
				this.connected = false;
				reject(err);
			});
		});
	}

	/**
	 * Handle a message from the server
	 */
	private handleMessage(message: ServerMessage): void {
		switch (message.type) {
			case "response": {
				const response = message as ServerResponse;
				const pending = this.pendingRequests.get(response.id);
				if (pending) {
					this.pendingRequests.delete(response.id);
					if (response.error) {
						pending.reject(new Error(response.error));
					} else {
						pending.resolve(response.result);
					}
				}
				break;
			}
			case "event": {
				const event = message as ServerEvent;
				if (event.event && event.sessionId) {
					const handler = this.eventHandlers.get(event.event);
					if (handler) {
						handler(event);
					}
				}
				break;
			}
		}
	}

	/**
	 * Send a request to the server
	 */
	async request<T extends Args>(
		args: T,
	): Promise<
		T extends StartArgs
			? string
			: T extends StopArgs
				? string
				: T extends StdinArgs
					? void
					: T extends StdoutArgs
						? string
						: T extends StreamArgs
							? string
							: T extends TermSizeArgs
								? string
								: T extends ResizeArgs
									? void
									: T extends AttachArgs
										? AttachResult
										: T extends DetachArgs
											? string
											: T extends ListArgs
												? string
												: T extends KillServerArgs
													? string
													: T extends VersionArgs
														? string
														: unknown
	> {
		if (!this.connected) {
			// Skip version check for kill-server and version commands
			const skipVersionCheck = args.action === "kill-server" || args.action === "version";
			// Only auto-start server for "start" action
			const autoStart = args.action === "start";
			await this.connect(skipVersionCheck, autoStart);
		}

		return new Promise((resolve, reject) => {
			const message = createRequest(args);
			this.pendingRequests.set(message.id, { resolve, reject });
			this.socket?.write(`${JSON.stringify(message)}\n`);

			// Set a timeout for the request
			setTimeout(() => {
				if (this.pendingRequests.has(message.id)) {
					this.pendingRequests.delete(message.id);
					reject(new Error("Request timeout"));
				}
			}, 5000);
		});
	}

	/**
	 * Register an event handler
	 */
	registerEventHandler(event: ServerEvent["event"], handler: (event: ServerEvent) => void): void {
		this.eventHandlers.set(event, handler);
	}

	/**
	 * Close the connection
	 */
	close(): void {
		if (this.socket) {
			this.socket.end();
		}
		this.connected = false;
		this.connectPromise = undefined;
	}
}
