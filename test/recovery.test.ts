import assert from "node:assert";
import * as fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface MCPResult {
	content: Array<{ type: string; text: string }>;
}

describe("Daemon recovery", () => {
	let client: Client;
	let transport: StdioClientTransport;

	before(async () => {
		// Daemon-spawn path inside mcp-server resolves index.js — we need the compiled file.
		if (!fs.existsSync("dist/index.js")) {
			throw new Error("dist/index.js missing — run `bun run build` first");
		}
		transport = new StdioClientTransport({
			command: "node",
			args: ["dist/index.js", "--mcp"],
			env: process.env as Record<string, string>,
		});

		client = new Client({ name: "recovery-test", version: "1.0.0" }, { capabilities: {} });
		await client.connect(transport);
	});

	after(async () => {
		try {
			await client.callTool({ name: "terminalcp", arguments: { args: { action: "stop" } } });
		} catch (_err) {
			// Ignore
		}
		await client.close();
	});

	it("should auto-respawn the daemon after kill-server, transparently to the next call", async () => {
		// Baseline: daemon is up and responsive.
		const first = (await client.callTool({
			name: "terminalcp",
			arguments: { args: { action: "start", command: "echo before-kill", name: "before-kill" } },
		})) as MCPResult;
		assert.strictEqual(first.content[0].text, "before-kill", "baseline start should succeed");

		// Tear down the daemon. kill-server sends a response, then process.exit(0)s.
		// The MCP server stays alive; only its daemon child dies.
		try {
			await client.callTool({ name: "terminalcp", arguments: { args: { action: "kill-server" } } });
		} catch (_err) {
			// Some transports surface the post-response close as a tool error; that's fine.
		}

		// Give the daemon a moment to actually exit and the socket close to propagate
		// up to the MCP server's TerminalClient.
		await new Promise((r) => setTimeout(r, 300));

		// Next tool call should transparently auto-respawn the daemon — no /mcp reconnect needed.
		const second = (await client.callTool({
			name: "terminalcp",
			arguments: { args: { action: "start", command: "echo after-kill", name: "after-kill" } },
		})) as MCPResult;
		assert.strictEqual(second.content[0].text, "after-kill", "post-kill start should auto-respawn the daemon");

		// And the new daemon should be fully usable.
		const list = (await client.callTool({
			name: "terminalcp",
			arguments: { args: { action: "list" } },
		})) as MCPResult;
		assert.ok(list.content[0].text.includes("after-kill"), "list should see the post-kill session");
	});
});
