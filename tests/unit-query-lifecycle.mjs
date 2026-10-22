// Script only the external SDK; use real child exits and cc-session-io files.
import { it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { digestMessages } from "../src/message-digests.js";
const root = mkdtempSync(join(tmpdir(), "query-lifecycle-"));
process.env.CLAUDE_CONFIG_DIR = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const mod = await import("../src/index.js");
const { __test } = mod;
let provider;
mod.default({ on: () => {}, registerProvider: (_id, value) => { provider = value; }, registerTool: () => {} });
const model = provider.models[0];
const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];
const user = (content) => ({ role: "user", content, timestamp: 1 });
const toolResult = { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "file" }], timestamp: 1 };
const call = (messages, signal) => provider.streamSimple(model, { messages, tools }, { sessionId: "pi", signal });
const tick = () => new Promise(setImmediate);
let scripts, calls;

beforeEach(() => {
	__test.resetSharedSession();
	__test.activeQueryContexts.clear();
	scripts = [];
	calls = [];
	__test.setQuery(({ options, prompt }) => {
		const script = scripts.shift();
		assert.ok(script, "queued external SDK script");
		const id = options.sessionId ?? options.resume;
		const path = getSessionPath(id, options.cwd, root);
		let parent = null;
		if (options.forkSession) {
			const source = readFileSync(getSessionPath(options.resume, options.cwd, root), "utf8").trim().split("\n").map(JSON.parse);
			const cut = source.findIndex((r) => r.uuid === options.resumeSessionAt);
			assert.ok(cut >= 0);
			const kept = source.slice(0, cut + 1).map((r) => ({ ...r, sessionId: id }));
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, kept.map((r) => JSON.stringify(r) + "\n").join(""));
		}
		if (existsSync(path)) parent = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.uuid).at(-1)?.uuid;
		const record = (role, content, uuid) => {
			const builder = createSession({ projectPath: options.cwd, sessionId: id });
			if (role === "assistant") builder.addAssistantMessage(content);
			else builder.addUserMessage(content);
			const value = { ...builder.records[0], ...(uuid ? { uuid } : {}), parentUuid: parent };
			parent = value.uuid;
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, JSON.stringify(value) + "\n");
			return value;
		};
		const childCode = `const fs=require('fs'),crypto=require('crypto'); process.on('SIGTERM',()=>{setTimeout(()=>{if(${Boolean(script.late)}){const p=${JSON.stringify(path)};const r=fs.readFileSync(p,'utf8').trim().split('\\n').map(JSON.parse).filter(r=>r.uuid).at(-1);fs.appendFileSync(p,JSON.stringify({type:'attachment',uuid:crypto.randomUUID(),parentUuid:r.uuid,sessionId:${JSON.stringify(id)},attachment:{type:'interrupted',text:'late-exit-marker'}})+'\\n');}process.exit(0)},${script.late ? 60 : 0})});process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
		const child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", childCode], cwd: root, env: process.env, signal: new AbortController().signal });
		const ready = once(child.stdout, "data");
		const exited = once(child, "close");
		let release, stopped = false;
		const parked = new Promise((r) => { release = r; });
		calls.push({ options, path, exited, child });
		const gen = (async function* () {
			await ready;
			const input = typeof prompt === "string" ? null : prompt[Symbol.asyncIterator]();
			const initial = input ? (await input.next()).value : { message: { content: prompt } };
			if (input) void input.next().catch(() => {});
			record("user", initial.message.content, initial.uuid);
			if (!script.preInit) yield { type: "system", subtype: "init", session_id: id };
			if (script.tool) {
				const value = record("assistant", [{ type: "tool_use", id: "X", name: "mcp__custom-tools__read", input: {} }]);
				yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, message: { id: "tool-api", model: model.id, content: value.message.content } };
				await parked;
				if (stopped) return;
			}
			if (!script.error) {
				const value = record("assistant", [{ type: "text", text: "answer" }]);
				yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, message: { id: `answer-${id}`, model: model.id, content: value.message.content } };
			}
			yield { type: "result", subtype: "success", is_error: Boolean(script.error), result: script.error ?? "answer", session_id: id };
		})();
		gen.interrupt = async () => {};
		gen.close = () => { stopped = true; release(); if (!child.killed) child.kill("SIGTERM"); };
		return gen;
	});
});
afterEach(async () => {
	__test.setQuery(null);
	for (const call of calls) if (!call.child.killed) call.child.kill("SIGTERM");
	await Promise.all(calls.map((c) => c.exited));
	await tick();
});

it("quota retries delete each new file only after the child finishes its late writes", async () => {
	const prior = [user("prior"), { role: "assistant", content: [{ type: "text", text: "prior answer" }], provider: model.provider, timestamp: 1 }];
	for (let i = 0; i < 3; i++) {
		scripts.push({ error: "API Error: quota exceeded", late: true });
		const output = await call([...prior, user("retry")]).result();
		assert.equal(output.stopReason, "error");
		const current = calls.at(-1);
		assert.ok(existsSync(current.path), "iterator settlement must not delete a live child's file");
		assert.equal(__test.getSharedSession("pi"), null);
		await current.exited;
		await tick();
		assert.equal(existsSync(current.path), false, "cleanup follows actual exit, including late writes");
	}
});

it("a no-progress fork failing before init deletes only its pre-minted target", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const prior = __test.getSharedSession("pi");
	const ancestor = getSessionPath(prior.ccSessionId, prior.cwd, root);
	await calls[0].exited;
	const before = readFileSync(ancestor);
	__test.markRebuildForSession("pi", "test");
	scripts.push({ preInit: true, error: "API Error: quota exceeded", late: true });
	await call([ask, answer, user("retry")]).result();
	const failed = calls.at(-1);
	assert.equal(failed.options.forkSession, true);
	assert.ok(failed.options.sessionId);
	assert.notEqual(failed.options.sessionId, prior.ccSessionId);
	assert.ok(existsSync(failed.path));
	assert.equal(__test.getSharedSession("pi").ccSessionId, prior.ccSessionId);
	await failed.exited;
	await tick();
	assert.equal(existsSync(failed.path), false);
	assert.deepEqual(readFileSync(ancestor), before);
});

it("abort commits contiguous tool progress synchronously and waits for exit before prefix-writing its source", async () => {
	const ask = user("tool"), controller = new AbortController();
	scripts.push({ tool: true, late: true });
	const tool = await call([ask], controller.signal).result();
	controller.abort();
	const captured = __test.getSharedSession("pi");
	assert.ok(captured, "onAbort synchronously publishes complete progress");
	assert.equal(captured.dirtyTail, true);
	assert.deepEqual(captured.digests, digestMessages([ask, tool]));
	scripts.push({});
	const next = call([ask, tool, toolResult, user("continue")]);
	await tick();
	assert.equal(calls.length, 1, "source may not be read or forked before the killed child exits");
	await next.result();
	assert.equal(calls.length, 2);
	assert.notEqual(calls[1].options.resume, captured.ccSessionId);
	assert.match(readFileSync(calls[0].path, "utf8"), /late-exit-marker/);
	assert.doesNotMatch(readFileSync(calls[1].path, "utf8"), /late-exit-marker/);
	assert.equal(__test.getSharedSession("pi").ccSessionId, calls[1].options.sessionId);
});

it("a fresh same-session query discards a parked query and retains its progress under CAS", async () => {
	const ask = user("tool");
	scripts.push({ tool: true, late: true });
	const tool = await call([ask]).result();
	const parked = [...__test.activeQueryContexts][0];
	scripts.push({});
	const next = call([ask, tool, user("fresh")]);
	assert.equal(parked.discarded, true);
	assert.equal(__test.getSharedSession("pi").dirtyTail, true);
	assert.deepEqual(__test.getSharedSession("pi").digests, digestMessages([ask, tool]));
	await next.result();
	assert.equal(__test.getSharedSession("pi").ccSessionId, calls[1].options.sessionId);
});


it("a synthetic durable-host continuation is grouped with its next assistant, not fabricated as a pi slot", async () => {
	const ask = user("tool"), controller = new AbortController();
	scripts.push({ tool: true });
	const tool = await call([ask], controller.signal).result();
	controller.abort();
	scripts.push({});
	const answer = await call([ask, tool, toolResult]).result();
	const state = __test.getSharedSession("pi");
	assert.deepEqual(state.digests, digestMessages([ask, tool, toolResult, answer]));
	const { readTranscript, resolveRecordingCut } = await import("../src/session-transcript.js");
	const records = readTranscript(state);
	const resultCut = resolveRecordingCut(records, state, 3);
	assert.doesNotMatch(JSON.stringify(records.slice(0, resultCut.index + 1)), /Your session was interrupted and resumed/);
	assert.match(JSON.stringify(records.slice(resultCut.index + 1)), /Your session was interrupted and resumed/);
	assert.equal(resolveRecordingCut(records, state, 4).uuid, state.uuids[3]);
});

it("AskClaude forks the same model and imports a changed model without writing provider state", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const state = __test.getSharedSession("pi");
	await calls[0].exited;
	const before = readFileSync(calls[0].path);
	scripts.push({});
	await __test.promptAndWait("delegated", "none", new Map(), undefined, { model: model.id, appendSkills: false, context: [ask, answer], piSessionId: "pi" });
	assert.equal(calls[1].options.forkSession, true);
	assert.equal(calls[1].options.resume, state.ccSessionId);
	assert.notEqual(calls[1].options.sessionId, state.ccSessionId);
	assert.strictEqual(__test.getSharedSession("pi"), state);
	scripts.push({});
	await __test.promptAndWait("other model", "none", new Map(), undefined, { model: "other-model", appendSkills: false, context: [ask, answer], piSessionId: "pi" });
	assert.equal(calls[2].options.forkSession, undefined);
	assert.notEqual(calls[2].options.resume, state.ccSessionId);
	assert.strictEqual(__test.getSharedSession("pi"), state);
	assert.deepEqual(readFileSync(calls[0].path), before);
});
