// Fully mocked Agent SDK `query()` for provider-core tests: no network, no CLI, no subscription.
// Each call yields a controllable query handle; the test plays the CLI by pushing SDK messages.
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

export const tool = (name = "add") => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
});

export function transcript({ system = "You are a test.", tools = [tool()], messages }) {
	return normalizeContext({ systemPrompt: system, tools, messages });
}
export const user = (content) => ({ role: "user", content, timestamp: 0 });
export const assistantToolCall = (id, name, args) => ({
	role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }],
	api: "claude-bridge", provider: "claude-bridge", model: "m", usage: {}, stopReason: "toolUse", timestamp: 0,
});
export const toolResult = (id, name, text, isError = false) => ({
	role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0,
});

/** SDK stream_event helpers (what includePartialMessages emits). */
export const ev = (event) => ({ type: "stream_event", event, parent_tool_use_id: null });
export const msgStart = (usage = { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }) => ev({ type: "message_start", message: { id: "m1", usage } });
export const textBlock = (index, text) => [
	ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
	ev({ type: "content_block_stop", index }),
];
export const toolUseBlock = (index, id, name, json) => [
	ev({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }),
	ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 3) } }),
	ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(3) } }),
	ev({ type: "content_block_stop", index }),
];
export const msgEnd = (stop_reason, output_tokens = 9) => [
	ev({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens } }),
	ev({ type: "message_stop" }),
];

export function mockQuery() {
	const calls = [];
	const queryFn = ({ prompt, options }) => {
		const inbox = []; // messages the host wrote to CLI stdin (park mode)
		const queue = [];
		let wake = null;
		let ended = false;
		const call = { prompt, options, inbox, closed: false, push, end, mcp: options.mcpServers?.durable };
		function push(...msgs) { queue.push(...msgs.flat()); wake?.(); wake = null; }
		function end() { ended = true; wake?.(); wake = null; }
		if (prompt && typeof prompt !== "string") void (async () => { for await (const m of prompt) inbox.push(m); })();
		const it = {
			async *[Symbol.asyncIterator]() {
				while (true) {
					while (!queue.length && !ended) await new Promise((r) => (wake = r));
					if (!queue.length) return;
					yield queue.shift();
				}
			},
			close() { call.closed = true; end(); },
		};
		calls.push(call);
		return Object.assign(it, { __call: call });
	};
	return { queryFn, calls };
}

/** Drive the in-process MCP server like the SDK does; resolves when the (parked) handler returns. */
export async function mcpCall(server, name, toolUseId, args = {}) {
	const pending = new Map();
	const transport = { start: async () => {}, close: async () => {}, send: async (m) => pending.get(m.id)?.(m) };
	await server.instance.connect(transport);
	let n = 0;
	const request = (method, params) => new Promise((resolve) => { const id = ++n; pending.set(id, resolve); transport.onmessage({ jsonrpc: "2.0", id, method, params }); });
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return { request, call: (id = toolUseId, n2 = name) => request("tools/call", { name: n2, arguments: args, _meta: { "claudecode/toolUseId": id } }), list: () => request("tools/list", {}) };
}

export async function collect(stream) {
	const events = [];
	for await (const e of stream) events.push(e);
	return events;
}
export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
