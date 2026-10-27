/**
 * Provider core against a fully mocked Agent SDK: event mapping, tool-round parking/release,
 * steer-before-release ordering, replay/crash fallback, abort gotcha, idle TTL, tool-set change.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createClaudeBridgeProvider } from "../src/core/index.js";
import { mockQuery, transcript, tool, user, assistantToolCall, toolResult, msgStart, textBlock, toolUseBlock, msgEnd, ev, collect, tick, mcpCall } from "./lib/mock-sdk.mjs";

const MODEL_ID = "claude-haiku-5-5";
// What the host hands streamSimple: a full pi-ai model entry resolved through this provider.
const MODEL = { ...getModels("anthropic").find((m) => m.id === MODEL_ID), api: "claude-bridge", provider: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function setup(opts = {}) {
	const mock = mockQuery();
	const provider = createClaudeBridgeProvider({ queryFn: mock.queryFn, sweepOrphans: false, checkAuth: false, ...opts });
	const run = (context, options) => provider.streamSimple(MODEL, context, options);
	return { provider, mock, run };
}
const types = (events) => events.map((e) => e.type);
const lastEv = (events) => events.at(-1);

describe("core event mapping", () => {
	it("maps a text answer to start/text_*/done with usage", async () => {
		const { run, mock, provider } = setup();
		const p = collect(run(transcript({ messages: [user("hi")] })));
		mock.calls[0].push(msgStart(), textBlock(0, "hello"), msgEnd("end_turn", 11));
		const events = await p;
		assert.deepEqual(types(events), ["start", "text_start", "text_delta", "text_end", "done"]);
		const done = lastEv(events);
		assert.equal(done.reason, "stop");
		assert.deepEqual(done.message.content, [{ type: "text", text: "hello" }]);
		assert.deepEqual([done.message.usage.input, done.message.usage.output, done.message.usage.cacheRead, done.message.usage.cacheWrite, done.message.usage.totalTokens], [5, 11, 100, 7, 123]);
		provider.shutdown();
	});

	it("maps thinking blocks", async () => {
		const { run, mock, provider } = setup();
		const p = collect(run(transcript({ messages: [user("hi")] })));
		mock.calls[0].push(msgStart(),
			ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
			ev({ type: "content_block_stop", index: 0 }),
			textBlock(1, "ok"), msgEnd("end_turn"));
		const events = await p;
		assert.deepEqual(types(events), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
		assert.equal(lastEv(events).message.content[0].thinkingSignature, "sig");
		provider.shutdown();
	});

	it("maps max_tokens to length", async () => {
		const { run, mock, provider } = setup();
		const p = collect(run(transcript({ messages: [user("hi")] })));
		mock.calls[0].push(msgStart(), textBlock(0, "cut"), msgEnd("max_tokens"));
		assert.equal(lastEv(await p).reason, "length");
		provider.shutdown();
	});

	it("maps tool_use to toolcall_* then done{toolUse}, stripping the MCP prefix", async () => {
		const { run, mock, provider } = setup();
		const p = collect(run(transcript({ messages: [user("add")] })));
		mock.calls[0].push(msgStart(), toolUseBlock(0, "toolu_1", "mcp__durable__add", '{"a":17,"b":25}'), msgEnd("tool_use"));
		const events = await p;
		assert.deepEqual(types(events), ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
		const end = events.find((e) => e.type === "toolcall_end");
		assert.deepEqual(end.toolCall, { type: "toolCall", id: "toolu_1", name: "add", arguments: { a: 17, b: 25 } });
		assert.equal(lastEv(events).reason, "toolUse");
		provider.shutdown();
	});

	it("passes SDK options: no builtins, MCP tools allowed, API key stripped, model id", async () => {
		const { run, mock, provider } = setup({ env: { ANTHROPIC_API_KEY: "sk-secret", PATH: "/bin" } });
		void collect(run(transcript({ messages: [user("hi")] })));
		const { options } = mock.calls[0];
		assert.deepEqual(options.tools, []);
		assert.equal(options.strictMcpConfig, true);
		assert.deepEqual(options.allowedTools, ["mcp__durable__add"]);
		assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(options.model, `${MODEL_ID}[1m]`); // measured-good 1M id via the long-context policy
		assert.equal(options.systemPrompt, "You are a test.");
		provider.shutdown();
	});
});

describe("core error events", () => {
	const failWith = async (feed) => {
		const { run, mock, provider } = setup();
		const p = collect(run(transcript({ messages: [user("hi")] })));
		feed(mock.calls[0]);
		const events = await p;
		provider.shutdown();
		return lastEv(events);
	};
	it("assistant.error rate_limit → retryable text", async () => {
		const e = await failWith((c) => c.push(msgStart(), { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "slow down" }] } }, ...msgEnd("end_turn")));
		assert.equal(e.type, "error");
		assert.match(e.error.errorMessage, /^rate limit \(429\)/);
	});
	it("failed result with usage-limit text → quota exceeded", async () => {
		const e = await failWith((c) => c.push({ type: "result", subtype: "success", is_error: true, result: "5-hour limit reached ∙ resets 3pm" }));
		assert.match(e.error.errorMessage, /^quota exceeded/);
	});
	it("process ending mid-round → connection lost", async () => {
		const e = await failWith((c) => c.end());
		assert.match(e.error.errorMessage, /connection lost/);
	});
	it("a thrown query() surfaces as an error event", async () => {
		const provider = createClaudeBridgeProvider({ queryFn: () => { throw new Error("spawn ENOENT"); }, sweepOrphans: false, checkAuth: false });
		const events = await collect(provider.streamSimple(MODEL, transcript({ messages: [user("hi")] })));
		assert.deepEqual(types(events), ["start", "error"]);
		assert.match(lastEv(events).error.errorMessage, /ENOENT/);
	});
	it("an already-aborted signal short-circuits without spawning", async () => {
		const { run, mock } = setup();
		const events = await collect(run(transcript({ messages: [user("hi")] }), { signal: AbortSignal.abort() }));
		assert.equal(lastEv(events).reason, "aborted");
		assert.equal(mock.calls.length, 0);
	});
});

describe("core tool rounds: park mode", () => {
	async function round1(h, extra = []) {
		const msgs = [user("add 17 25")];
		const p = collect(h.run(transcript({ messages: msgs })));
		h.mock.calls[0].push(msgStart(), toolUseBlock(0, "toolu_1", "mcp__durable__add", '{"a":17,"b":25}'), msgEnd("tool_use"));
		await p;
		return [...msgs, assistantToolCall("toolu_1", "add", { a: 17, b: 25 }), ...extra];
	}

	it("keeps ONE query across rounds and releases the parked handler with the result", async () => {
		const h = setup();
		const msgs = await round1(h);
		// the CLI calls the MCP tool; the handler must park (nothing executes)
		const client = await mcpCall(h.mock.calls[0].mcp, "add", "toolu_1");
		let settled = false;
		const call = client.call().then((r) => { settled = true; return r; });
		await tick();
		assert.equal(settled, false, "handler parks until the host returns a result");

		const p2 = collect(h.run(transcript({ messages: [...msgs, toolResult("toolu_1", "add", "42")] })));
		const reply = await call;
		assert.deepEqual(reply.result.content, [{ type: "text", text: "42" }]);
		assert.equal(h.mock.calls.length, 1, "no second query spawned");
		h.mock.calls[0].push(msgStart(), textBlock(0, "forty-two"), msgEnd("end_turn"));
		const events = await p2;
		assert.equal(lastEv(events).reason, "stop");
		assert.equal(lastEv(events).message.content[0].text, "forty-two");
		h.provider.shutdown();
	});

	it("handles a result that lands before the handler is invoked", async () => {
		const h = setup();
		const msgs = await round1(h);
		const p2 = collect(h.run(transcript({ messages: [...msgs, toolResult("toolu_1", "add", "42", true)] })));
		await tick();
		const client = await mcpCall(h.mock.calls[0].mcp, "add", "toolu_1");
		const reply = await client.call();
		assert.equal(reply.result.isError, true);
		h.mock.calls[0].push(msgStart(), textBlock(0, "x"), msgEnd("end_turn"));
		await p2;
		h.provider.shutdown();
	});

	it("writes a steer to CLI stdin BEFORE releasing the tool result", async () => {
		const h = setup();
		const msgs = await round1(h);
		const client = await mcpCall(h.mock.calls[0].mcp, "add", "toolu_1");
		const order = [];
		const call = client.call().then(() => order.push("result"));
		const p2 = collect(h.run(transcript({ messages: [...msgs, toolResult("toolu_1", "add", "42"), user("say PINEAPPLE")] })));
		await call;
		const inbox = h.mock.calls[0].inbox;
		assert.equal(inbox.length, 2); // initial prompt + steer
		assert.equal(inbox[1].message.content, "say PINEAPPLE");
		assert.equal(inbox[1].priority, "next");
		assert.deepEqual(order, ["result"]); // steer was already in inbox when the result released
		h.mock.calls[0].push(msgStart(), textBlock(0, "PINEAPPLE"), msgEnd("end_turn"));
		await p2;
		h.provider.shutdown();
	});

	it("does not kill the parked query when the finished call's signal aborts later", async () => {
		const h = setup();
		const ac = new AbortController();
		const p = collect(h.run(transcript({ messages: [user("add")] }), { signal: ac.signal }));
		h.mock.calls[0].push(msgStart(), toolUseBlock(0, "toolu_1", "mcp__durable__add", '{"a":1,"b":2}'), msgEnd("tool_use"));
		await p;
		ac.abort(); // host aborts the call's signal after done
		await tick();
		assert.equal(h.mock.calls[0].closed, false);
		assert.equal(h.provider.liveQueries, 1);
		h.provider.shutdown();
	});

	it("aborting a streaming call closes the query and ends the stream as aborted", async () => {
		const h = setup();
		const ac = new AbortController();
		const p = collect(h.run(transcript({ messages: [user("hi")] }), { signal: ac.signal }));
		h.mock.calls[0].push(msgStart());
		await tick();
		ac.abort();
		const events = await p;
		assert.equal(lastEv(events).reason, "aborted");
		assert.equal(h.mock.calls[0].closed, true);
		assert.equal(h.provider.liveQueries, 0);
	});

	it("idle TTL kills an unclaimed parked query", async () => {
		const h = setup({ idleTtlMs: 20 });
		await round1(h);
		assert.equal(h.provider.liveQueries, 1);
		await tick(60);
		assert.equal(h.mock.calls[0].closed, true);
		assert.equal(h.provider.liveQueries, 0);
	});

	it("a tool-set change forces a fresh query instead of continuing the parked one", async () => {
		const h = setup();
		const msgs = await round1(h);
		const ctx = transcript({ tools: [tool("add"), tool("mul")], messages: [...msgs, toolResult("toolu_1", "add", "42")] });
		const p2 = collect(h.run(ctx));
		assert.equal(h.mock.calls.length, 2);
		assert.equal(h.mock.calls[0].closed, true);
		assert.deepEqual(h.mock.calls[1].options.allowedTools, ["mcp__durable__add", "mcp__durable__mul"]);
		h.mock.calls[1].push(msgStart(), textBlock(0, "ok"), msgEnd("end_turn"));
		await p2;
		h.provider.shutdown();
	});

	it("parks two parallel tool calls and releases both from one transcript tail", async () => {
		const h = setup();
		const p = collect(h.run(transcript({ messages: [user("go")] })));
		h.mock.calls[0].push(msgStart(), toolUseBlock(0, "t1", "mcp__durable__add", '{"a":1,"b":2}'), toolUseBlock(1, "t2", "mcp__durable__add", '{"a":3,"b":4}'), msgEnd("tool_use"));
		await p;
		const client = await mcpCall(h.mock.calls[0].mcp, "add", "t1");
		const c1 = client.call();
		const c2 = client.call("t2");
		const assistant = { ...assistantToolCall("t1", "add", { a: 1, b: 2 }) };
		assistant.content.push({ type: "toolCall", id: "t2", name: "add", arguments: { a: 3, b: 4 } });
		const p2 = collect(h.run(transcript({ messages: [user("go"), assistant, toolResult("t1", "add", "3"), toolResult("t2", "add", "7")] })));
		const [r1, r2] = await Promise.all([c1, c2]);
		assert.equal(r1.result.content[0].text, "3");
		assert.equal(r2.result.content[0].text, "7");
		assert.equal(h.mock.calls.length, 1);
		h.mock.calls[0].push(msgStart(), textBlock(0, "done"), msgEnd("end_turn"));
		await p2;
		h.provider.shutdown();
	});
});

describe("core tool rounds: replay and crash recovery", () => {
	it("replay mode closes the query at tool_use and rebuilds a fresh one next round", async () => {
		const h = setup({ mode: "replay" });
		const msgs = [user("add 17 25")];
		const p = collect(h.run(transcript({ messages: msgs })));
		assert.equal(h.mock.calls[0].options.maxTurns, 1);
		h.mock.calls[0].push(msgStart(), toolUseBlock(0, "toolu_1", "mcp__durable__add", '{"a":17,"b":25}'), msgEnd("tool_use"));
		await p;
		await tick();
		assert.equal(h.mock.calls[0].closed, true);
		const p2 = collect(h.run(transcript({ messages: [...msgs, assistantToolCall("toolu_1", "add", { a: 17, b: 25 }), toolResult("toolu_1", "add", "42")] })));
		assert.equal(h.mock.calls.length, 2);
		assert.match(h.mock.calls[1].prompt, /\[result of tool call toolu_1 \(add\)\]\n42/);
		h.mock.calls[1].push(msgStart(), textBlock(0, "42"), msgEnd("end_turn"));
		assert.equal(lastEv(await p2).reason, "stop");
	});

	it("park mode with no live query (host restarted) rebuilds from the transcript", async () => {
		const h = setup(); // fresh provider: nothing parked
		const msgs = [user("add 17 25"), assistantToolCall("toolu_1", "add", { a: 17, b: 25 }), toolResult("toolu_1", "add", "42")];
		const p = collect(h.run(transcript({ messages: msgs })));
		assert.equal(h.mock.calls.length, 1);
		await tick();
		assert.match(h.mock.calls[0].inbox[0].message.content, /\[called tool add id=toolu_1/);
		h.mock.calls[0].push(msgStart(), textBlock(0, "42"), msgEnd("end_turn"));
		assert.equal(lastEv(await p).reason, "stop");
		h.provider.shutdown();
	});

	it("a parked query that died between rounds degrades to rebuild", async () => {
		const h = setup();
		const msgs = [user("add")];
		const p = collect(h.run(transcript({ messages: msgs })));
		h.mock.calls[0].push(msgStart(), toolUseBlock(0, "toolu_1", "mcp__durable__add", '{"a":1,"b":2}'), msgEnd("tool_use"));
		await p;
		h.mock.calls[0].end(); // CLI crashed while parked
		await tick();
		assert.equal(h.provider.liveQueries, 0);
		const p2 = collect(h.run(transcript({ messages: [...msgs, assistantToolCall("toolu_1", "add", { a: 1, b: 2 }), toolResult("toolu_1", "add", "3")] })));
		assert.equal(h.mock.calls.length, 2);
		h.mock.calls[1].push(msgStart(), textBlock(0, "3"), msgEnd("end_turn"));
		assert.equal(lastEv(await p2).reason, "stop");
		h.provider.shutdown();
	});

	it("a final answer closes CLI stdin so the process exits", async () => {
		const h = setup();
		const p = collect(h.run(transcript({ messages: [user("hi")] })));
		h.mock.calls[0].push(msgStart(), textBlock(0, "hi"), msgEnd("end_turn"));
		await p;
		h.mock.calls[0].end();
		await tick();
		assert.equal(h.provider.liveQueries, 0);
	});
});

describe("core provider surface", () => {
	it("exposes the model table with zero cost and the provider id as api", async () => {
		const { provider } = setup();
		const models = await provider.getModels();
		assert.ok(models.length > 0);
		assert.ok(models.every((m) => m.provider === "claude-bridge" && m.api === "claude-bridge" && m.cost.input === 0));
	});

	it("auth resolve() is a stub when logged in and undefined when not (getAvailable does not lie)", async () => {
		const out = createClaudeBridgeProvider({ checkAuth: async () => undefined, sweepOrphans: false });
		assert.equal(await out.auth.apiKey.resolve({}), undefined);
		assert.equal(await out.auth.apiKey.check({}), undefined);
		const inn = createClaudeBridgeProvider({ checkAuth: async () => "macOS Keychain", sweepOrphans: false });
		const r = await inn.auth.apiKey.resolve({});
		assert.equal(r.auth.apiKey, "not-used");
		assert.match(r.source, /claude-code-oauth/);
	});
});

describe("core imageBudget option", () => {
	const img = (n) => ({ type: "image", data: "x".repeat(n), mimeType: "image/png" });
	const asst = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 };
	const messages = [user([img(3)]), asst, user([img(3)]), asst, user([img(3)])];
	const sent = async (imageBudget) => {
		const { run, mock, provider } = setup({ imageBudget });
		void collect(run(transcript({ tools: [], messages })));
		await tick();
		const m = await new Promise((r) => { const t = setInterval(() => { if (mock.calls[0].inbox.length) { clearInterval(t); r(mock.calls[0].inbox[0]); } }, 1); });
		provider.shutdown();
		return m.message.content.filter((b) => b.type === "image").length;
	};

	it("an explicit undefined field keeps its default (not NaN/unlimited-by-accident)", async () => {
		assert.equal(await sent({ maxImages: undefined, maxImageBytes: undefined, maxTotalBytes: undefined }), 3);
	});
	it("a given field overrides", async () => {
		assert.equal(await sent({ maxImages: 1 }), 1);
	});
	it("maxImageBytes is clamped to maxTotalBytes", async () => {
		assert.equal(await sent({ maxImageBytes: 1000, maxTotalBytes: 6 }), 2);
	});
});
