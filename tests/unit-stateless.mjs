// Stateless provider: one query per round, driven by a fake queryFn (no subscription use).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { createStatelessStreams, cliSessionId, CONTINUE_PROMPT, classifyError, effortFor } from "../src/stateless/index.js";

const MODEL = { id: "sonnet", api: "x", provider: "p", name: "s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1e5, maxTokens: 1e4, reasoning: true };
const TOOLS = [{ name: "add", description: "add", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }];
const PREFIX = "mcp__custom-tools__";
let root, claudeDir, sessionDir, seq = 0;
before(() => { root = mkdtempSync(join(tmpdir(), "stateless-")); claudeDir = join(root, "claude"); sessionDir = join(root, "cwd"); });
after(() => rmSync(root, { recursive: true, force: true }));

const sys = { role: "system", content: "You are terse." };
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const asst = (...calls) => ({ role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c, name: "add", arguments: { a: 1, b: 2 } })), api: "x", provider: "p", model: "sonnet", usage: {}, stopReason: "toolUse", timestamp: 2 });
const res = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "add", content: [{ type: "text", text }], isError: false, timestamp: 3 });

const ev = (event) => ({ type: "stream_event", event });
const start = (usage = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }) => ev({ type: "message_start", message: { id: "msg1", usage } });
const textBlock = (i, t) => [ev({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }), ev({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } }), ev({ type: "content_block_stop", index: i })];
const toolBlock = (i, id, json) => [ev({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name: PREFIX + "add", input: {} } }), ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 3) } }), ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(3) } }), ev({ type: "content_block_stop", index: i })];
const delta = (stop, out = 9) => ev({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: out } });

/** A fake query: yields `msgs`, then optionally throws like the SDK does after error_max_turns. */
function fake(msgs, { throwAfter } = {}) {
	const calls = [];
	const queryFn = (args) => {
		calls.push(args);
		return (async function* () { for (const m of msgs) yield m; if (throwAfter) throw new Error(throwAfter); })();
	};
	return { queryFn, calls };
}
const mk = (queryFn) => createStatelessStreams({ sessionDir, claudeDir, queryFn });
async function run(streams, messages, opts = {}) {
	const s = streams.streamSimple(MODEL, { messages }, { tools: TOOLS, sessionId: `s${++seq}`, ...opts });
	const events = [];
	for await (const e of s) events.push(e);
	return { events, msg: await s.result(), types: events.map((e) => e.type) };
}
const MAX_TURNS = { type: "result", subtype: "error_max_turns", is_error: false, usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } };
const OK = { ...MAX_TURNS, subtype: "success" };

/** Write the file Claude Code would have left after a tool_use round: denial tool_results. */
function seedDenied(piId, ids) {
	const s = createSession({ projectPath: sessionDir, claudeDir, sessionId: cliSessionId(piId), model: "sonnet" });
	s.importMessages([
		{ role: "user", content: "add things" },
		{ role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: PREFIX + "add", input: { a: 1, b: 2 } })) },
		{ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "denied by hook", is_error: true })) },
	]);
	s.save();
	return getSessionPath(cliSessionId(piId), sessionDir, claudeDir);
}
const records = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const chain = (p) => records(p).map((r) => `${r.uuid}>${r.parentUuid}`).join();

describe("stateless provider", () => {
	it("single tool call: error_max_turns + tool_use is a normal toolUse stop; one message; config is fixed", async () => {
		const f = fake([start(), ...textBlock(0, "Let me add."), ...toolBlock(1, "toolu_1", '{"a":17,"b":25}'), delta("tool_use"), MAX_TURNS], { throwAfter: "Claude Code returned an error result: Reached maximum number of turns (1)" });
		const { types, msg } = await run(mk(f.queryFn), [sys, user("add 17+25")]);
		assert.deepEqual(types, ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
		assert.equal(msg.stopReason, "toolUse");
		assert.deepEqual(msg.content[1], { type: "toolCall", id: "toolu_1", name: "add", arguments: { a: 17, b: 25 } });
		assert.equal(msg.content[0].text, "Let me add.");
		assert.equal(msg.usage.cacheRead, 100); assert.equal(msg.usage.cacheWrite, 7); assert.equal(msg.usage.output, 9); assert.equal(msg.usage.input, 2);
		assert.equal(f.calls.length, 1);
		const { prompt, options: o } = f.calls[0];
		assert.equal(o.resume, undefined); assert.ok(o.sessionId);
		assert.equal(o.maxTurns, 1); assert.deepEqual(o.tools, []); assert.deepEqual(o.settingSources, []);
		assert.equal(o.cwd, sessionDir); assert.equal(o.systemPrompt, "You are terse.");
		assert.equal(o.permissionMode, "bypassPermissions"); assert.equal(o.includePartialMessages, true);
		assert.deepEqual(o.settings, { includeGitInstructions: false });
		assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(prompt, "add 17+25");
	});

	it("never runs the MCP handler: the hook denies every call", async () => {
		const f = fake([start(), ...toolBlock(0, "t1", '{"a":1,"b":2}'), delta("tool_use"), MAX_TURNS]);
		await run(mk(f.queryFn), [sys, user("go")]);
		const o = f.calls[0].options;
		assert.deepEqual(Object.keys(o.mcpServers), ["custom-tools"]);
		const [{ matcher, hooks }] = o.hooks.PreToolUse;
		assert.equal(matcher, ".*");
		const out = await hooks[0]({ tool_name: PREFIX + "add" });
		assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
	});

	it("parallel calls: both denial records patched with real results, chain untouched, CONTINUE prompt", async () => {
		const p = seedDenied("par", ["ta", "tb"]);
		const before = chain(p);
		const f = fake([start(), ...textBlock(0, "3 and 7"), delta("end_turn"), OK]);
		const piId = "par";
		const { msg } = await run(mk(f.queryFn), [sys, user("add things"), asst("ta", "tb"), res("ta", "RESULT=3"), res("tb", "RESULT=7")], { sessionId: piId });
		assert.equal(msg.stopReason, "stop");
		const o = f.calls[0];
		assert.equal(o.options.resume, cliSessionId(piId)); assert.equal(o.options.sessionId, undefined);
		assert.equal(o.prompt, CONTINUE_PROMPT);
		const results = records(p).filter((r) => r.type === "user" && Array.isArray(r.message?.content)).flatMap((r) => r.message.content).filter((b) => b.type === "tool_result");
		assert.deepEqual(results.map((b) => [b.tool_use_id, b.content, b.is_error]), [["ta", "RESULT=3", undefined], ["tb", "RESULT=7", undefined]]);
		assert.equal(chain(p), before);
	});

	it("steer: user text after the results becomes the prompt", async () => {
		const p = seedDenied("steer", ["t1"]);
		const f = fake([start(), ...textBlock(0, "ok"), delta("end_turn"), OK]);
		await run(mk(f.queryFn), [sys, user("add things"), asst("t1"), res("t1", "RESULT=3"), user("Task update: stage shipped")], { sessionId: "steer" });
		assert.equal(f.calls[0].prompt, "Task update: stage shipped");
		assert.ok(readFileSync(p, "utf8").includes("RESULT=3"));
	});

	it("missing file: built from the transcript with real tool_use/tool_result records", async () => {
		const piId = "rebuild";
		const p = getSessionPath(cliSessionId(piId), sessionDir, claudeDir);
		assert.equal(existsSync(p), false);
		const f = fake([start(), ...textBlock(0, "done"), delta("end_turn"), OK]);
		await run(mk(f.queryFn), [sys, user("add"), asst("tx"), res("tx", "RESULT=42")], { sessionId: piId });
		assert.ok(existsSync(p));
		const blocks = records(p).filter((r) => r.message && Array.isArray(r.message.content)).flatMap((r) => r.message.content);
		assert.ok(blocks.some((b) => b.type === "tool_use" && b.id === "tx" && b.name === PREFIX + "add"));
		assert.ok(blocks.some((b) => b.type === "tool_result" && b.tool_use_id === "tx" && JSON.stringify(b.content).includes("RESULT=42")));
		assert.equal(f.calls[0].options.resume, cliSessionId(piId));
		assert.equal(f.calls[0].prompt, CONTINUE_PROMPT);
	});

	it("abort: closes that query and ends with an 'aborted' error", async () => {
		let closed = 0;
		const queryFn = () => {
			const it = { close: () => { closed++; release(); }, [Symbol.asyncIterator]() { return this; }, next: () => new Promise((r) => { release = () => r({ done: true, value: undefined }); }) };
			return it;
		};
		let release;
		const ac = new AbortController();
		const s = mk(queryFn).streamSimple(MODEL, { messages: [sys, user("hi")] }, { sessionId: "ab", signal: ac.signal });
		setTimeout(() => ac.abort(), 20);
		const events = [];
		for await (const e of s) events.push(e);
		const last = events.at(-1);
		assert.equal(last.type, "error"); assert.equal(last.reason, "aborted");
		assert.equal((await s.result()).errorMessage, "aborted");
		assert.equal(closed, 1);
	});

	it("thinking, usage and a real error result map to pi events", async () => {
		const think = [ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }), ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }), ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }), ev({ type: "content_block_stop", index: 0 })];
		const f = fake([start(), ...think, ...textBlock(1, "hi"), delta("end_turn", 33), OK]);
		const { types, msg } = await run(mk(f.queryFn), [user("x")]);
		assert.deepEqual(types, ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
		assert.equal(msg.content[0].thinkingSignature, "sig"); assert.equal(msg.usage.output, 9);
		const bad = fake([start(), { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] }]);
		const r = await run(mk(bad.queryFn), [user("x")]);
		assert.equal(r.types.at(-1), "error"); assert.match(r.msg.errorMessage, /boom/);
	});

	it("forget deletes the session file; dispose is a no-op", async () => {
		const p = seedDenied("gone", ["t"]);
		const s = mk(fake([]).queryFn);
		s.forget("gone"); s.dispose();
		assert.equal(existsSync(p), false);
	});
});

const assistantMsg = (id, content, extra = {}) => ({ type: "assistant", message: { id, role: "assistant", content, ...extra } });
const tu = (id, input = { a: 1, b: 2 }, name = PREFIX + "add") => ({ type: "tool_use", id, name, input });
const asErr = (msg) => ({ role: "assistant", stopReason: "error", errorMessage: msg });

describe("stateless robustness: ported upstream fixes", () => {
	it("non-streaming fallback: a whole assistant message under a new id after a stalled stream reaches pi, abandoned blocks dropped", async () => {
		const stalled = [start(), ev({ type: "message_start", message: { id: "msgA", usage: {} } }), ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "dead", name: PREFIX + "add", input: {} } }), ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a"' } })];
		const f = fake([...stalled, assistantMsg("msgB", [{ type: "text", text: "recovered" }, tu("live")], { stop_reason: "tool_use" }), MAX_TURNS]);
		const { msg } = await run(mk(f.queryFn), [sys, user("go")]);
		assert.equal(msg.stopReason, "toolUse");
		assert.deepEqual(msg.content.map((b) => b.type + ":" + (b.id ?? b.text)), ["text:recovered", "toolCall:live"]);
		assert.deepEqual(msg.content[1].arguments, { a: 1, b: 2 });
	});

	it("fallback with no stream events at all emits the whole message; same-id assistant after a stream is ignored", async () => {
		const only = await run(mk(fake([assistantMsg("m1", [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "text", text: "hi" }]), OK]).queryFn), [user("x")]);
		assert.deepEqual(only.types, ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
		const dup = await run(mk(fake([start(), ...textBlock(0, "once"), delta("end_turn"), assistantMsg("msg1", [{ type: "text", text: "once" }]), OK]).queryFn), [user("x")]);
		assert.equal(dup.msg.content.length, 1);
	});

	it("restreamed message_start drops the abandoned stream's blocks", async () => {
		const f = fake([start(), ...textBlock(0, "partial"), ev({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }),
			ev({ type: "message_start", message: { id: "msg2", usage: {} } }), ...textBlock(0, "final"), delta("end_turn"), OK]);
		const { msg } = await run(mk(f.queryFn), [user("x")]);
		assert.deepEqual(msg.content.map((b) => b.text), ["final"]);
	});

	it("a tool call is dispatched only when its block closes (#146): a cut-off call never reaches pi", async () => {
		const f = fake([start(), ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "cut", name: PREFIX + "add", input: {} } }), ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":1' } }), OK]);
		const { msg, types } = await run(mk(f.queryFn), [user("x")]);
		assert.equal(msg.stopReason, "stop");
		assert.equal(msg.content.length, 0);
		assert.ok(!types.includes("toolcall_end"));
		const g = fake([start(), ...toolBlock(0, "ok", '{"a":1}'), delta("tool_use"), MAX_TURNS]);
		const r = await run(mk(g.queryFn), [user("x")]);
		assert.equal(r.types.indexOf("toolcall_end") > r.types.indexOf("toolcall_start"), true);
	});

	it("tool names map in/out of the mcp__custom-tools__ namespace; unserved tools are skipped", async () => {
		const f = fake([start(), ...toolBlock(0, "t1", '{"a":1}'), ...toolBlock(1, "t2", '{}').map((e) => JSON.parse(JSON.stringify(e).replace("custom-tools__add", "custom-tools__nope"))), delta("tool_use"), MAX_TURNS]);
		const { msg } = await run(mk(f.queryFn), [user("x")]);
		assert.deepEqual(msg.content.map((b) => b.name), ["add"]);
		const up = fake([start(), ...toolBlock(0, "t3", '{}').map((e) => JSON.parse(JSON.stringify(e).replace("custom-tools__add", "CUSTOM-TOOLS__ADD"))), delta("tool_use"), MAX_TURNS]);
		assert.deepEqual((await run(mk(up.queryFn), [user("x")])).msg.content.map((b) => b.name), ["add"]);
	});

	it("top-level anyOf/oneOf/allOf in a tool schema is flattened before it reaches Claude Code", async () => {
		const schema = { type: "object", properties: { op: { type: "string" } }, anyOf: [{ type: "object", properties: { x: { type: "string" } } }, { type: "object", properties: { y: { type: "string" } } }] };
		const f = fake([start(), ...textBlock(0, "k"), delta("end_turn"), OK]);
		await run(mk(f.queryFn), [user("x")], { tools: [{ name: "u", description: "d", parameters: schema }] });
		const server = f.calls[0].options.mcpServers["custom-tools"];
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const inst = server.instance ?? server;
		await inst.connect(st);
		const client = new Client({ name: "t", version: "1" });
		await client.connect(ct);
		const tool = (await client.listTools()).tools[0];
		for (const k of ["anyOf", "oneOf", "allOf"]) assert.ok(!(k in tool.inputSchema));
		assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["op", "x", "y"]);
		await client.close();
	});

	it("<synthetic> failure notice becomes an error (not output); partial blocks dropped", async () => {
		const f = fake([start(), ...textBlock(0, "x"), assistantMsg("syn", [{ type: "text", text: "API Error: 529 overloaded" }], { model: "<synthetic>" }), { ...OK, is_error: false }]);
		const { events, msg } = await run(mk(f.queryFn), [user("x")]);
		assert.equal(events.at(-1).type, "error");
		assert.match(msg.errorMessage, /overloaded/);
		assert.equal(isRetryableAssistantError(msg), true);
		assert.ok(!msg.content.some((b) => /529/.test(b.text ?? "")));
	});
});

describe("stateless robustness: timeouts", () => {
	function hanging(first = []) {
		let closed = 0, release;
		const queryFn = () => {
			const msgs = [...first];
			return { close: () => { closed++; release?.(); }, [Symbol.asyncIterator]() { return this; },
				next: () => msgs.length ? Promise.resolve({ done: false, value: msgs.shift() }) : new Promise((r) => { release = () => r({ done: true, value: undefined }); }) };
		};
		return { queryFn, closed: () => closed };
	}
	it("idle: no SDK message -> kills the query, retryable 'connection lost' error", async () => {
		const h = hanging([start()]);
		const s = createStatelessStreams({ sessionDir, claudeDir, queryFn: h.queryFn, idleTimeoutMs: 40, roundTimeoutMs: 5000 });
		const { events, msg } = await run(s, [user("x")]);
		assert.equal(events.at(-1).type, "error");
		assert.match(msg.errorMessage, /connection lost: no message from Claude Code for 40 ms \(idle timeout\), query killed/);
		assert.equal(isRetryableAssistantError(msg), true);
		assert.equal(h.closed(), 1);
	});
	it("total: messages keep coming but the round exceeds roundTimeoutMs", async () => {
		let closed = 0;
		const queryFn = () => ({ close: () => { closed++; }, [Symbol.asyncIterator]() { return this; }, next: () => new Promise((r) => setTimeout(() => r({ done: false, value: ev({ type: "ping" }) }), 10)) });
		const s = createStatelessStreams({ sessionDir, claudeDir, queryFn, idleTimeoutMs: 1000, roundTimeoutMs: 80 });
		const { msg } = await run(s, [user("x")]);
		assert.match(msg.errorMessage, /connection lost: round did not finish within 80 ms \(round timeout\), query killed/);
		assert.equal(isRetryableAssistantError(msg), true);
		assert.equal(closed, 1);
	});
	it("a finished round leaves no live timers (process can exit; late timeouts do nothing)", async () => {
		const f = fake([start(), ...textBlock(0, "k"), delta("end_turn"), OK]);
		const s = createStatelessStreams({ sessionDir, claudeDir, queryFn: f.queryFn, idleTimeoutMs: 30, roundTimeoutMs: 30 });
		const { msg } = await run(s, [user("x")]);
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(msg.stopReason, "stop");
	});
});

describe("stateless robustness: error classes, reasoning, logging", () => {
	const errResult = (text, extra = {}) => ({ type: "result", subtype: "error_during_execution", is_error: true, errors: [text], ...extra });
	it("rate limit / quota / overloaded -> retryable; auth / invalid request -> fatal", async () => {
		for (const [text, extra] of [["You've hit your usage limit", { api_error_status: 429 }], ["API Error: overloaded_error", {}], ["rate limit reached", {}], ["Claude AI usage limit reached (quota exceeded, billing)", {}], ["Server error", { api_error_status: 503 }]]) {
			const { msg } = await run(mk(fake([start(), errResult(text, extra)]).queryFn), [user("x")]);
			assert.equal(isRetryableAssistantError(msg), true, `${text} -> ${msg.errorMessage}`);
		}
		for (const [text, extra] of [["Invalid API key. Please run /login", { api_error_status: 401 }], ["invalid_request_error: messages.0: bad", { api_error_status: 400 }], ["authentication_failed 429", {}]]) {
			const { msg } = await run(mk(fake([start(), errResult(text, extra)]).queryFn), [user("x")]);
			assert.equal(isRetryableAssistantError(msg), false, `${text} -> ${msg.errorMessage}`);
			assert.match(msg.errorMessage, /fatal/);
		}
		assert.equal(classifyError("boom"), "unknown");
		assert.equal(classifyError("x", { code: "rate_limit" }), "retryable");
		assert.equal(classifyError("x", { code: "authentication_failed" }), "fatal");
	});
	it("pi reasoning maps to the SDK effort option (+ summarized thinking display)", async () => {
		const f = fake([start(), ...textBlock(0, "k"), delta("end_turn"), OK]);
		await run(mk(f.queryFn), [user("x")], { reasoning: "high" });
		assert.equal(f.calls[0].options.effort, "high");
		assert.equal(f.calls[0].options.extraArgs["thinking-display"], "summarized");
		const g = fake([start(), ...textBlock(0, "k"), delta("end_turn"), OK]);
		await run(mk(g.queryFn), [user("x")]);
		assert.equal(g.calls[0].options.effort, undefined);
		assert.equal(effortFor({ thinkingLevelMap: { xhigh: "xhigh" } }, "xhigh"), "xhigh");
		assert.equal(effortFor({}, "xhigh"), "max");
		assert.equal(effortFor({ thinkingLevelMap: { low: null } }, "low"), undefined);
	});
	it("debug log: JSON lines with session id, prompt kind, timings, usage, stop reason, stderr, kills", async () => {
		const log = join(root, "dbg", "bridge.jsonl");
		const queryFn = (args) => { args.options.stderr("cli says hi\n"); return fake([start(), ...textBlock(0, "k"), delta("end_turn"), OK]).queryFn(args); };
		await run(createStatelessStreams({ sessionDir, claudeDir, queryFn, debug: true, debugLogPath: log }), [user("x")], { sessionId: "logme" });
		const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const byEvent = (e) => lines.find((l) => l.event === e);
		assert.equal(byEvent("round_start").sessionId, cliSessionId("logme"));
		assert.equal(byEvent("round_start").promptKind, "user");
		assert.equal(byEvent("cli_stderr").line, "cli says hi");
		const end = byEvent("round_end");
		assert.deepEqual([end.sessionId, end.promptKind, end.ok, end.stopReason, end.sdkStopReason], [cliSessionId("logme"), "user", true, "stop", "end_turn"]);
		assert.equal(typeof end.firstEventMs, "number"); assert.equal(typeof end.endMs, "number");
		assert.deepEqual(end.usage, { input: 2, output: 9, cacheRead: 100, cacheWrite: 7 });
		assert.ok(byEvent("round_start").ts);
		// kills are logged with the reason
		const log2 = join(root, "dbg", "kill.jsonl");
		const hang = () => ({ close() {}, [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}) });
		await run(createStatelessStreams({ sessionDir, claudeDir, queryFn: hang, debug: true, debugLogPath: log2, idleTimeoutMs: 20 }), [user("x")]);
		const l2 = readFileSync(log2, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(l2.find((l) => l.event === "kill").reason, "idle timeout");
		assert.equal(l2.find((l) => l.event === "round_end").kill, "idle");
		assert.equal(l2.find((l) => l.event === "round_end").ok, false);
	});
	it("without debug or env, nothing is written", async () => {
		const log = join(root, "dbg", "off.jsonl");
		await run(createStatelessStreams({ sessionDir, claudeDir, queryFn: fake([start(), OK]).queryFn, debugLogPath: log }), [user("x")]);
		assert.equal(existsSync(log), false);
	});
});
