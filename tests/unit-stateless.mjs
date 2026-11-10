// Stateless provider: one query per round, driven by a fake queryFn (no subscription use).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { getEventListeners } from "node:events";
import { roundError, timeoutError } from "../src/stateless/errors.js";
import { redact } from "../src/stateless/debuglog.js";
import { createStatelessStreams, cliSessionId, CONTINUE_PROMPT, classifyError, effortFor, replaySystem, childEnv, patchToolResults } from "../src/stateless/index.js";

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
		assert.deepEqual(types, ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
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
		assert.equal(o.prompt, "[Continue from the tool result above.]");
		assert.doesNotMatch(o.prompt, /interrupted/);
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
		await s.forget("gone"); s.dispose();
		assert.equal(existsSync(p), false);
	});

	it("1.4 system messages: tools only via toolsAdded reach the MCP server; removal and replacement by name", async () => {
		const t2 = { name: "mul", description: "mul", parameters: { type: "object", properties: {} } };
		const t1b = { ...TOOLS[0], description: "add v2" };
		const f = fake([start(), ...textBlock(0, "x"), delta("end_turn"), OK]);
		const msgs = [{ role: "system", content: "base", toolsAdded: [TOOLS[0], t2], timestamp: 1 }, user("hi"), { role: "system", content: "", toolsAdded: [t1b], toolsRemoved: [{ name: "mul" }], timestamp: 2 }];
		const s = mk(f.queryFn).streamSimple(MODEL, { messages: msgs }, { sessionId: "tools14" });
		for await (const _ of s);
		const tools = await f.calls[0].options.mcpServers["custom-tools"].instance.server._requestHandlers.get("tools/list")({ method: "tools/list" });
		assert.deepEqual(tools.tools.map((t) => [t.name, t.description]), [["add", "add v2"]]);
	});

	it("a redefined tool (removal + addition of the same name in one message) survives", async () => {
		const v2 = { ...TOOLS[0], description: "add v2" };
		const f = fake([start(), ...textBlock(0, "x"), delta("end_turn"), OK]);
		const msgs = [{ role: "system", content: "base", toolsAdded: [TOOLS[0]], timestamp: 1 }, user("hi"), { role: "system", content: "", toolsRemoved: [{ name: "add" }], toolsAdded: [v2], timestamp: 2 }];
		for await (const _ of mk(f.queryFn).streamSimple(MODEL, { messages: msgs }, { sessionId: "redef" }));
		const tools = await f.calls[0].options.mcpServers["custom-tools"].instance.server._requestHandlers.get("tools/list")({ method: "tools/list" });
		assert.deepEqual(tools.tools.map((t) => [t.name, t.description]), [["add", "add v2"]]);
	});

	it("removing every tool leaves zero tools; the options.tools fallback is ignored once tools were declared", async () => {
		const f = fake([start(), ...textBlock(0, "x"), delta("end_turn"), OK]);
		const msgs = [{ role: "system", content: "base", toolsAdded: [TOOLS[0]], timestamp: 1 }, user("hi"), { role: "system", content: "", toolsRemoved: [{ name: "add" }], timestamp: 2 }];
		for await (const _ of mk(f.queryFn).streamSimple(MODEL, { messages: msgs, tools: TOOLS }, { sessionId: "rmall", tools: TOOLS }));
		assert.equal(f.calls[0].options.mcpServers?.["custom-tools"], undefined);
	});

	it("replaySystem: sections replace, null deletes, render after content; later content appends", () => {
		const r = replaySystem([
			{ role: "system", content: "base", sections: { a: "A1", b: "B1" } },
			user("x"),
			{ role: "system", content: [{ type: "text", text: "more" }], sections: { a: "A2", b: null, c: "C" } },
		]);
		assert.equal(r.prompt, "base\n\nmore\n\nA2\n\nC");
		assert.deepEqual(r.tools, []);
	});

	it("missing sessionId fails the call", async () => {
		const f = fake([]);
		const s = mk(f.queryFn).streamSimple(MODEL, { messages: [user("x")] }, {});
		const events = []; for await (const e of s) events.push(e);
		assert.equal(events.at(-1).type, "error"); assert.match((await s.result()).errorMessage, /sessionId/);
		assert.equal(f.calls.length, 0);
	});

	it("results whose denial record is missing: file deleted and rebuilt from the transcript", async () => {
		const p = seedDenied("nodenial", ["other"]);
		const f = fake([start(), ...textBlock(0, "ok"), delta("end_turn"), OK]);
		await run(mk(f.queryFn), [sys, user("add"), asst("tz"), res("tz", "RESULT=9")], { sessionId: "nodenial" });
		const blocks = records(p).filter((r) => r.message && Array.isArray(r.message.content)).flatMap((r) => r.message.content);
		assert.ok(blocks.some((b) => b.type === "tool_use" && b.id === "tz"));
		assert.ok(!blocks.some((b) => b.tool_use_id === "other"));
		assert.equal(f.calls[0].options.resume, cliSessionId("nodenial"));
	});

	it("two trailing user messages join into one prompt", async () => {
		const f = fake([start(), ...textBlock(0, "ok"), delta("end_turn"), OK]);
		await run(mk(f.queryFn), [sys, user("first"), user("second")]);
		assert.equal(f.calls[0].prompt, "first\n\nsecond");
	});

	it("abort leaves no listener on the signal", async () => {
		const ac = new AbortController();
		const f = fake([start(), ...textBlock(0, "ok"), delta("end_turn"), OK]);
		await run(mk(f.queryFn), [user("x")], { signal: ac.signal });
		assert.equal(getEventListeners(ac.signal, "abort").length, 0);
	});

	it("child env strips credentials and routing, keeps request logging off", () => {
		const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
		const e = childEnv({ ...Object.fromEntries(keys.map((k) => [k, "x"])), KEEP: "1" });
		for (const k of keys) assert.equal(e[k], undefined, k);
		assert.equal(e.KEEP, "1"); assert.equal(e.CLAUDE_CODE_ELEGANT_MEADOW, "0");
	});
});

describe("session store", () => {
	const okFake = () => fake([start(), ...textBlock(0, "ok"), delta("end_turn"), OK]);
	const withDebug = (queryFn, extra = {}) => { const log = []; return { streams: createStatelessStreams({ sessionDir, claudeDir, queryFn, debug: (e) => { if (e.event === "note") log.push(e.msg); }, ...extra }), log }; };
	const toolResults = (p) => records(p).filter((r) => r.type === "user" && Array.isArray(r.message?.content)).flatMap((r) => r.message.content).filter((b) => b.type === "tool_result");

	it("recovery while a tool_result is pending: file deleted -> rebuilt from the transcript, round works", async () => {
		const p = seedDenied("lost", ["t1"]);
		rmSync(p);
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		const { msg } = await run(streams, [sys, user("add things"), asst("t1"), res("t1", "RESULT=5")], { sessionId: "lost" });
		assert.equal(msg.stopReason, "stop");
		assert.ok(existsSync(p));
		assert.deepEqual(toolResults(p).map((b) => b.tool_use_id), ["t1"]);
		assert.ok(JSON.stringify(toolResults(p)[0].content).includes("RESULT=5"));
		assert.equal(f.calls[0].options.resume, cliSessionId("lost"));
		assert.ok(log.some((l) => l.startsWith("built session")));
	});

	it("steer while results are pending: matching file is verified and patched, no rebuild", async () => {
		const p = seedDenied("steer2", ["a", "b"]);
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		await run(streams, [sys, user("add things"), asst("a", "b"), res("a", "R1"), res("b", "R2"), user("also do X")], { sessionId: "steer2" });
		assert.equal(f.calls[0].prompt, "also do X");
		assert.ok(!log.some((l) => l.includes("rebuilding")), log.join("|"));
		assert.deepEqual(toolResults(p).map((b) => b.content), ["R1", "R2"]);
	});

	it("mismatch (different tool_use ids / message count) -> rebuild, reason reported", async () => {
		const p = seedDenied("mism", ["old"]);
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		await run(streams, [sys, user("add things"), asst("new"), res("new", "RESULT=9")], { sessionId: "mism" });
		assert.ok(log.some((l) => l.includes("rebuilding session") && l.includes("tool_use ids differ")), log.join("|"));
		assert.deepEqual(toolResults(p).map((b) => b.tool_use_id), ["new"]);
		// extra history in the transcript -> count mismatch
		const f2 = okFake();
		const d2 = withDebug(f2.queryFn);
		await run(d2.streams, [sys, user("add things"), asst("new"), res("new", "R"), user("more")], { sessionId: "mism" });
		await run(d2.streams, [sys, user("add things"), asst("new"), res("new", "R"), user("more"), asst("n2"), res("n2", "R2")], { sessionId: "mism" });
		assert.ok(d2.log.some((l) => l.includes("message count")), d2.log.join("|"));
	});

	it("denial record missing in the file -> falls back to a rebuild instead of failing", async () => {
		const p = seedDenied("nodenial", ["t1"]);
		writeFileSync(p, records(p).filter((r) => !(r.type === "user" && JSON.stringify(r).includes("denied by hook"))).map((r) => JSON.stringify(r)).join("\n") + "\n");
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		const { msg } = await run(streams, [sys, user("add things"), asst("t1"), res("t1", "RESULT=1")], { sessionId: "nodenial" });
		assert.equal(msg.stopReason, "stop");
		assert.ok(log.some((l) => l.includes("rebuilding")));
		assert.ok(JSON.stringify(toolResults(p)).includes("RESULT=1"));
	});

	it("a large (~200 KB) result is patched intact", async () => {
		const p = seedDenied("big", ["t1"]);
		const big = "x".repeat(200_000) + "END";
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		await run(streams, [sys, user("add things"), asst("t1"), res("t1", big)], { sessionId: "big" });
		assert.ok(!log.some((l) => l.includes("rebuilding")));
		assert.equal(toolResults(p)[0].content, big);
	});

	it("crash during the patch write: temp left behind, original intact; the next round recovers", async () => {
		const p = seedDenied("crash", ["t1"]);
		const orig = readFileSync(p, "utf8");
		assert.throws(() => patchToolResults(p, new Map([["t1", { content: "R" }]]), { beforeRename: () => { throw new Error("power cut"); } }), /power cut/);
		assert.equal(readFileSync(p, "utf8"), orig);
		assert.ok(existsSync(p + ".tmp"));
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		await run(streams, [sys, user("add things"), asst("t1"), res("t1", "RESULT=2")], { sessionId: "crash" });
		assert.ok(!log.some((l) => l.includes("rebuilding")));
		assert.equal(toolResults(p)[0].content, "RESULT=2");
		assert.equal(existsSync(p + ".tmp"), false);
		// a crash inside a round falls back to a rebuild
		const p2 = seedDenied("crash2", ["t1"]);
		const d2 = withDebug(okFake().queryFn, { patchHook: () => { throw new Error("disk full"); } });
		const r = await run(d2.streams, [sys, user("add things"), asst("t1"), res("t1", "RESULT=3")], { sessionId: "crash2" });
		assert.equal(r.msg.stopReason, "stop");
		assert.ok(d2.log.some((l) => l.includes("patch failed: disk full")));
		assert.ok(JSON.stringify(toolResults(p2)).includes("RESULT=3"));
	});

	it("concurrent rounds on one session serialize; different sessions do not", async () => {
		const seen = [];
		let active = 0, maxActive = 0;
		const queryFn = (args) => (async function* () {
			active++; maxActive = Math.max(maxActive, active); seen.push("start");
			await new Promise((r) => setTimeout(r, 40));
			for (const m of [start(), ...textBlock(0, "ok"), delta("end_turn"), OK]) yield m;
			seen.push("end"); active--;
		})();
		const streams = mk(queryFn);
		await Promise.all([1, 2, 3].map(() => run(streams, [sys, user("hi")], { sessionId: "same" })));
		assert.equal(maxActive, 1); assert.deepEqual(seen, ["start", "end", "start", "end", "start", "end"]);
		maxActive = 0;
		await Promise.all([run(streams, [sys, user("hi")], { sessionId: "o1" }), run(streams, [sys, user("hi")], { sessionId: "o2" })]);
		assert.equal(maxActive, 2);
	});

	it("forget removes file and temp leftovers; idle sweep removes only stale sessions, at most hourly", async () => {
		const pf = seedDenied("fg", ["t"]);
		writeFileSync(pf + ".tmp", "x");
		const s = mk(fake([]).queryFn);
		await s.forget("fg");
		assert.equal(existsSync(pf), false); assert.equal(existsSync(pf + ".tmp"), false);

		const old = seedDenied("old1", ["t"]), fresh = seedDenied("fresh1", ["t"]);
		writeFileSync(old + ".tmp", "x");
		const past = new Date(Date.now() - 8 * 86_400_000);
		utimesSync(old, past, past); utimesSync(old + ".tmp", past, past);
		let t = Date.now();
		const { streams, log } = withDebug(fake([]).queryFn, { now: () => t });
		assert.equal(existsSync(old), false); assert.equal(existsSync(old + ".tmp"), false);
		assert.equal(existsSync(fresh), true);
		assert.ok(log.some((l) => l.includes("idle sweep removed")));
		// not again within the hour
		const old2 = seedDenied("old2", ["t"]);
		utimesSync(old2, past, past);
		t += 30 * 60_000;
		await run(streams, [sys, user("hi")], { sessionId: "sw" });
		assert.equal(existsSync(old2), true);
		t += 31 * 60_000;
		await run(streams, [sys, user("hi")], { sessionId: "sw" });
		assert.equal(existsSync(old2), false);
		// ttl 0 disables
		const old3 = seedDenied("old3", ["t"]);
		utimesSync(old3, past, past);
		withDebug(fake([]).queryFn, { sessionTtlDays: 0 });
		assert.equal(existsSync(old3), true);
	});

	it("an aborted waiter finishes while the holder is still running", async () => {
		let release; const gate = new Promise((r) => { release = r; });
		let n = 0;
		const queryFn = () => (async function* () { if (n++ === 0) await gate; for (const m of [start(), ...textBlock(0, "ok"), delta("end_turn"), OK]) yield m; })();
		const streams = mk(queryFn);
		const holder = run(streams, [sys, user("a")], { sessionId: "lk" });
		await new Promise((r) => setTimeout(r, 20));
		const ac = new AbortController();
		const waiter = run(streams, [sys, user("b")], { sessionId: "lk", signal: ac.signal });
		const third = run(streams, [sys, user("c")], { sessionId: "lk" });
		setTimeout(() => ac.abort(), 20);
		const w = await waiter; // must resolve although the holder is stuck
		assert.equal(w.msg.stopReason, "aborted");
		release();
		assert.equal((await holder).msg.stopReason, "stop");
		assert.equal((await third).msg.stopReason, "stop");
		assert.equal(n, 2);
	});

	it("forget waits for the running round", async () => {
		let release; const gate = new Promise((r) => { release = r; });
		const queryFn = () => (async function* () { await gate; for (const m of [start(), ...textBlock(0, "ok"), delta("end_turn"), OK]) yield m; })();
		const streams = mk(queryFn);
		const p = seedDenied("fgl", ["t1"]);
		const r = run(streams, [sys, user("add things"), asst("t1"), res("t1", "R")], { sessionId: "fgl" });
		await new Promise((x) => setTimeout(x, 20));
		let forgotten = false;
		const f = streams.forget("fgl").then(() => { forgotten = true; });
		await new Promise((x) => setTimeout(x, 30));
		assert.equal(forgotten, false); assert.ok(existsSync(p));
		release(); await r; await f;
		assert.equal(existsSync(p), false);
	});

	it("aborted / errored turns leave records that do not force a rebuild", async () => {
		const piId = "junk";
		const p = seedDenied(piId, ["t1"]);
		const recs = records(p);
		const lastUser = recs.filter((r) => r.type === "user").at(-1);
		const mkRec = (extra, msg) => ({ ...recs.at(-1), uuid: "u-" + Math.random(), parentUuid: recs.at(-1).uuid, ...extra, message: msg });
		const extraRecs = [
			mkRec({ type: "assistant" }, { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error" }] }),
			mkRec({ type: "assistant", isApiErrorMessage: true }, { role: "assistant", content: [{ type: "text", text: "boom" }] }),
			mkRec({ type: "assistant" }, { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }], stop_reason: null }),
			mkRec({ type: "user", isMeta: true }, { role: "user", content: [{ type: "text", text: "meta" }] }),
		];
		void lastUser;
		writeFileSync(p, [...recs, ...extraRecs].map((r) => JSON.stringify(r)).join("\n") + "\n");
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		await run(streams, [sys, user("add things"), asst("t1"), res("t1", "RESULT=1")], { sessionId: piId });
		assert.ok(!log.some((l) => l.includes("rebuilding")), log.join("|"));
		assert.ok(JSON.stringify(toolResults(p)).includes("RESULT=1"));
	});

	it("split assistant records (thinking, then text + tool_use) verify; a retry of a patched round does not rebuild", async () => {
		const piId = "split";
		const p = seedDenied(piId, ["t1"]);
		const recs = records(p);
		const ai = recs.findIndex((r) => r.type === "assistant");
		const a = recs[ai];
		const think = { ...a, uuid: "think-1", parentUuid: a.parentUuid, message: { ...a.message, content: [{ type: "thinking", thinking: "hm", signature: "s" }] } };
		recs[ai] = { ...a, parentUuid: "think-1" };
		recs.splice(ai, 0, think);
		writeFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const msgs = [sys, user("add things"), asst("t1"), res("t1", "RESULT=1")];
		const f = okFake();
		const { streams, log } = withDebug(f.queryFn);
		await run(streams, msgs, { sessionId: piId });
		await run(streams, msgs, { sessionId: piId }); // retry of the same, already patched round
		assert.ok(!log.some((l) => l.includes("rebuilding")), log.join("|"));
		assert.deepEqual(toolResults(p).map((b) => b.content), ["RESULT=1"]);
		assert.equal(f.calls.length, 2);
	});

	it("a verified file is touched so the sweep cannot take it", async () => {
		const p = seedDenied("touch", ["t1"]);
		const past = new Date(Date.now() - 8 * 86_400_000);
		utimesSync(p, past, past);
		await run(mk(okFake().queryFn), [sys, user("add things"), asst("t1"), res("t1", "R")], { sessionId: "touch" });
		assert.ok(Date.now() - statSync(p).mtimeMs < 60_000);
	});

	it("sweep ignores files that are not uuid-named sessions", async () => {
		const odd = join(dirname(seedDenied("oddref", ["t"])), "notes.jsonl");
		const past = new Date(Date.now() - 30 * 86_400_000);
		writeFileSync(odd, "x"); utimesSync(odd, past, past);
		withDebug(fake([]).queryFn, { now: () => Date.now() + 10 * 3_600_000 });
		assert.equal(existsSync(odd), true);
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

	it("a closed tool call of a replaced message is rescued once when no retry re-emits calls (work-wolfpack-7g4ZFMJ)", async () => {
		const f = fake([start(), ...textBlock(0, "dropme"), ...toolBlock(1, "kept", '{"a":1}'), ...toolBlock(2, "kept2", '{"a":2}'),
			ev({ type: "message_start", message: { id: "msg2", usage: {} } }), ...textBlock(0, "after"), delta("end_turn"), MAX_TURNS]);
		const { msg, types } = await run(mk(f.queryFn), [user("x")]);
		assert.equal(msg.stopReason, "toolUse");
		assert.deepEqual(msg.content.map((b) => b.type + ":" + (b.id ?? b.text)), ["text:after", "toolCall:kept", "toolCall:kept2"]);
		assert.equal(types.filter((t) => t === "toolcall_end").length, 2);
	});

	it("an unserved tool name is passed to pi (which answers unknown tool) and logged without its inputs (work-wolfpack-7g4ZFMJ)", async () => {
		const events = [];
		const nope = toolBlock(0, "t2", '{"secret":1}').map((e) => JSON.parse(JSON.stringify(e).replace("custom-tools__add", "custom-tools__nope")));
		const f = fake([start(), ...nope, delta("tool_use"), MAX_TURNS]);
		const { msg } = await run(createStatelessStreams({ sessionDir, claudeDir, queryFn: f.queryFn, debug: (e) => events.push(e) }), [user("x")]);
		assert.equal(msg.stopReason, "toolUse");
		assert.deepEqual(msg.content.map((b) => b.name), ["nope"]);
		const logged = events.filter((e) => e.event === "unserved_tool");
		assert.equal(logged.length, 1);
		assert.equal(logged[0].name, PREFIX + "nope");
		assert.deepEqual(logged[0].served, ["add"]);
		assert.ok(!JSON.stringify(logged[0]).includes("secret"));
	});

	it("tool names map in/out of the mcp__custom-tools__ namespace", async () => {
		const f = fake([start(), ...toolBlock(0, "t1", '{"a":1}'), delta("tool_use"), MAX_TURNS]);
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
		for (const [text, extra] of [["API Error: overloaded_error", {}], ["rate limit reached", {}], ["Server error", { api_error_status: 503 }], ["ECONNRESET connection lost", {}]]) {
			const { msg } = await run(mk(fake([start(), errResult(text, extra)]).queryFn), [user("x")]);
			assert.equal(isRetryableAssistantError(msg), true, `${text} -> ${msg.errorMessage}`);
		}
		for (const [text, extra] of [["Invalid API key. Please run /login", { api_error_status: 401 }], ["invalid_request_error: messages.0: bad", { api_error_status: 400 }], ["authentication_failed 429", {}], ["You've hit your usage limit. Resets at 5pm", { api_error_status: 429 }], ["Claude AI usage limit reached (quota exceeded, billing) resets in 3 hours", {}], ["HTTP 429 too fast", { api_error_status: 429 }]]) {
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

describe("stateless robustness: review fixes", () => {
	it("tool block closed, then message_start re-sent: no toolcall events for the abandoned call; indices match; usage not doubled", async () => {
		const f = fake([start(), ...textBlock(0, "ab"), ...toolBlock(1, "dead", '{"a":1}'),
			ev({ type: "message_start", message: { id: "msg2", usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } }),
			...textBlock(0, "final"), ...toolBlock(1, "live", '{"a":2}'), delta("tool_use"), ev({ type: "message_stop" }), MAX_TURNS]);
		const { events, msg } = await run(mk(f.queryFn), [user("x")]);
		const calls = events.filter((e) => e.type === "toolcall_end");
		assert.deepEqual(calls.map((e) => e.toolCall.id), ["live"]);
		assert.deepEqual(msg.content.map((b) => b.text ?? b.id), ["final", "live"]);
		// every announced *_start index is unique and ends up in the final content or is an ended abandoned block
		const starts = events.filter((e) => /_start$/.test(e.type) && e.type !== "start").map((e) => e.contentIndex);
		assert.equal(new Set(starts).size, starts.length);
		const ended = events.filter((e) => e.type === "text_end").map((e) => e.contentIndex);
		assert.ok(ended.includes(0));
		assert.equal(calls[0].contentIndex, 2); // ab(0) abandoned, final(1), live(2) -> announced indices never reused
		assert.equal(msg.usage.input, 2); assert.equal(msg.usage.cacheRead, 100); assert.equal(msg.usage.output, 9);
	});
	it("a throwing consume handler leaves no running query", async () => {
		let closed = 0, returned = 0;
		const queryFn = () => ({ close: () => { closed++; }, [Symbol.asyncIterator]() { return this; }, return: async () => { returned++; return { done: true }; },
			next: () => Promise.resolve({ done: false, value: { type: "stream_event", get event() { throw new Error("handler boom"); } } }) });
		const { msg } = await run(createStatelessStreams({ sessionDir, claudeDir, queryFn }), [user("x")]);
		assert.equal(msg.stopReason, "error");
		assert.ok(closed >= 1); assert.equal(returned, 1);
	});
	it("an already-aborted signal never starts a query", async () => {
		const c = new AbortController(); c.abort();
		const f = fake([start(), OK]);
		const { msg } = await run(mk(f.queryFn), [user("x")], { signal: c.signal });
		assert.equal(msg.stopReason, "aborted"); assert.equal(f.calls.length, 0);
	});
	it("stop reason: toolUse beats max_tokens; max_tokens alone is length", async () => {
		const a = await run(mk(fake([start(), ...toolBlock(0, "t", '{"a":1}'), delta("max_tokens"), MAX_TURNS]).queryFn), [user("x")]);
		assert.equal(a.msg.stopReason, "toolUse");
		const b = await run(mk(fake([start(), ...textBlock(0, "t"), delta("max_tokens"), OK]).queryFn), [user("x")]);
		assert.equal(b.msg.stopReason, "length");
	});
	it("thinking display only for models that reason", async () => {
		const f = fake([start(), ...textBlock(0, "k"), delta("end_turn"), OK]);
		const s = mk(f.queryFn).streamSimple({ ...MODEL, reasoning: false }, { messages: [user("x")] }, { tools: TOOLS, sessionId: "nr", reasoning: "high" });
		for await (const _ of s);
		assert.equal(f.calls[0].options.extraArgs, undefined);
	});
	it("property: fatal text with digits and transient words stays non-retryable; raw is kept", () => {
		const fatals = ["authentication_failed 429 overloaded 503", "Invalid API key 500 timeout connection reset", "Claude AI usage limit reached|1761700000 resets at 5pm 503", "You've hit your usage limit (429), resets in 3 hours 12345 rate limit", "max_output_tokens 502 server error"];
		for (const t of fatals) {
			const code = /max_output/.test(t) ? "max_output_tokens" : undefined;
			const e = roundError(t, { code, status: /usage/.test(t) ? 429 : undefined });
			assert.equal(e.errorClass, "fatal", t);
			assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: e.message }), false, e.message);
			assert.equal(e.raw, t);
			assert.doesNotMatch(e.message, /rate limit/i);
		}
		assert.match(roundError("Usage limit reached. Resets at 5pm", { status: 429 }).message, /resets at 5pm/i);
		for (const t of ["overloaded_error available balance 0", "rate limit GoUsageLimitError", "Server error FreeUsageLimitError billing"]) {
			const e = roundError(t, { code: "rate_limit" });
			assert.equal(roundError("x", { code: "max_output_tokens" }).errorClass, "fatal");
			assert.equal(e.errorClass, "retryable", t);
			assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: e.message }), true, e.message);
			assert.equal(e.raw, t);
		}
	});
	it("timeout wording uses the real defaults; timers cleared on throw; late timeout after dispose is harmless", async () => {
		assert.match(timeoutError("round", 600_000).message, /within 10 min \(round timeout\)/);
		assert.match(timeoutError("idle", 90_000).message, /for 1\.5 min|for 90 s|1\.5 min/);
		assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: timeoutError("round", 600_000).message }), true);
		const queryFn = () => (async function* () { yield start(); throw new Error("kaboom"); })();
		const { msg } = await run(createStatelessStreams({ sessionDir, claudeDir, queryFn, idleTimeoutMs: 20, roundTimeoutMs: 20 }), [user("x")]);
		assert.match(msg.errorMessage, /kaboom/);
		await new Promise((r) => setTimeout(r, 60)); // no unhandled rejection / second event
	});
	it("debug log: redaction, truncation, mode 0600, sink failure does not stop the file", async () => {
		assert.equal(redact("Authorization: Bearer abc.def-123 x"), "Authorization: Bearer [redacted] x");
		assert.doesNotMatch(redact("key sk-ant-api03-ABCDEFGH"), /ABCDEFGH/);
		assert.doesNotMatch(redact('{"access_token":"s3cr3tvalue"}'), /s3cr3tvalue/);
		assert.ok(redact("x".repeat(10000)).length < 2200);
		const log = join(root, "dbg", "mode.jsonl");
		const queryFn = (a) => { a.options.stderr("Bearer topsecret\n"); return fake([start(), OK]).queryFn(a); };
		await run(createStatelessStreams({ sessionDir, claudeDir, queryFn, debug: () => { throw new Error("sink"); }, debugLogPath: log, env: {} }), [user("x")]);
		// debug as a function alone does not enable the file; enable it via env for this check
		process.env.CLAUDE_BRIDGE_DEBUG = "1";
		try { await run(createStatelessStreams({ sessionDir, claudeDir, queryFn, debug: () => { throw new Error("sink"); }, debugLogPath: log }), [user("x")]); } finally { delete process.env.CLAUDE_BRIDGE_DEBUG; }
		const txt = readFileSync(log, "utf8");
		assert.doesNotMatch(txt, /topsecret/);
		assert.match(txt, /round_end/);
		assert.equal(statSync(log).mode & 0o777, 0o600);
	});
});
