// Stateless provider: one query per round, driven by a fake queryFn (no subscription use).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { createStatelessStreams, cliSessionId, CONTINUE_PROMPT, patchToolResults } from "../src/stateless/index.js";

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

describe("session store", () => {
	const okFake = () => fake([start(), ...textBlock(0, "ok"), delta("end_turn"), OK]);
	const withDebug = (queryFn, extra = {}) => { const log = []; return { streams: createStatelessStreams({ sessionDir, claudeDir, queryFn, debug: (m) => log.push(m), ...extra }), log }; };
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
		s.forget("fg");
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
});
