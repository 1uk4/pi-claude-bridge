import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession } from "cc-session-io";
import { stateFor } from "./lib/session-state.mjs";
import { compareHistory, copyRecording, importHistory, LiveRecording, validateRecording } from "../src/session-sync.js";
import { digestMessages } from "../src/message-digests.js";

const { __test } = await import("../src/index.js");
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, provider: "claude-bridge", timestamp: 1 });
const say = (text) => assistant([{ type: "text", text }]);
const calls = (...ids) => assistant(ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })));
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: `result-${id}` }], isError: false, timestamp: 1 });
let root, cwd, oldClaudeDir;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "session-sync-"));
	cwd = root;
	oldClaudeDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = join(root, "cc");
	__test.resetSharedSession();
});
afterEach(() => {
	__test.resetSharedSession();
	__test.setPiUI(null);
	if (oldClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = oldClaudeDir;
	rmSync(root, { recursive: true, force: true });
});
const sync = (messages, model = "sonnet", sid = "pi", path = cwd) => __test.syncSharedSession(messages, path, undefined, model, sid);
function seed(messages, extra = {}) {
	const session = createSession({ projectPath: cwd, model: "sonnet" });
	const state = stateFor(session, messages, "sonnet", extra);
	session.save();
	__test.setSharedSession("pi", state);
	return { session, state };
}

describe("digest session decisions", () => {
	it("starts without a resume or state when only system state precedes the first prompt", () => {
		const synced = sync([{ role: "system", content: "system" }, user("hello")]);
		assert.equal(synced.sessionId, null);
		assert.equal(__test.getSharedSession("pi"), null);
	});
	it("plain-resumes exactly equal history without writing any bytes, ignoring system and metadata", () => {
		const priors = [user("hi"), say("hello")];
		const { session } = seed(priors);
		session.addAttachment({ type: "sentinel", value: "must survive" });
		session.save();
		const before = readFileSync(session.jsonlPath);
		const synced = sync([user("hi"), { ...priors[1], timestamp: 900, usage: { output: 500 }, stopReason: "length" }, { role: "system", content: "changed tools" }, user("next")]);
		assert.equal(synced.sessionId, session.sessionId);
		assert.deepEqual(readFileSync(session.jsonlPath), before);
	});
	for (const [name, rewrite] of [
		["same-count rewrite", [user("redacted"), say("hello")]],
		["same-count replacement/removal", [say("hello"), say("replacement")]],
		["shorter history", [say("hello")]],
		["unseen assistant", [user("hi"), say("hello"), say("other provider")]],
	]) it(`${name} writes a fresh id and preserves the old transcript`, () => {
		const { session } = seed([user("hi"), say("hello")]);
		const before = readFileSync(session.jsonlPath);
		const synced = sync([...rewrite, user("next")]);
		assert.notEqual(synced.sessionId, session.sessionId);
		assert.deepEqual(synced.recorded.digests, digestMessages(rewrite));
		assert.deepEqual(readFileSync(session.jsonlPath), before);
	});
	it("model changes rotate even for equal history", () => {
		const priors = [user("hi"), say("hello")];
		const { session } = seed(priors);
		const synced = sync([...priors, user("next")], "opus");
		assert.notEqual(synced.sessionId, session.sessionId);
		assert.equal(__test.getSharedSession("pi").model, "opus");
	});
	it("unattributed calls import independently and never write provider state", () => {
		const priors = [user("hi"), say("hello")];
		const { session, state } = seed(priors);
		__test.setSharedSession(null, state);
		const synced = sync([...priors, user("next")], "sonnet", null);
		assert.notEqual(synced.sessionId, session.sessionId);
		assert.equal(synced.writable, false);
		assert.strictEqual(__test.getSharedSession(null), state);
	});
	it("missing files import into a new session instead of attempting resume", () => {
		const priors = [user("hi"), say("hello")];
		const { session } = seed(priors);
		unlinkSync(session.jsonlPath);
		assert.notEqual(sync([...priors, user("next")]).sessionId, session.sessionId);
	});
	it("cwd changes never resume a file in an unrelated project", () => {
		const priors = [user("hi"), say("hello")];
		const { session } = seed(priors);
		const synced = sync([...priors, user("next")], "sonnet", "pi", join(cwd, "other"));
		assert.notEqual(synced.sessionId, session.sessionId);
		assert.equal(__test.getSharedSession("pi").cwd, join(cwd, "other"));
		assert.ok(existsSync(session.jsonlPath));
	});
	it("carries attachments to the new transcript without reporting a count mismatch", () => {
		const priors = [user("Review @fixture.txt"), say("noted")];
		const { session, state } = seed(priors);
		// Place the attachment at its prompt rather than after the assistant.
		const original = createSession({ projectPath: cwd });
		original.importMessages([{ role: "user", content: "Review @fixture.txt" }], { attachments: [{ afterIndex: 0, attachment: { type: "file", filename: join(cwd, "fixture.txt"), content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } } } }] });
		original.addAssistantMessage([{ type: "text", text: "noted" }]);
		original.save();
		__test.setSharedSession("pi", { ...state, ccSessionId: original.sessionId, needsRebuild: true });
		const notices = [];
		__test.setPiUI({ notify: (message) => notices.push(message) });
		const synced = sync([...priors, user("next")]);
		assert.equal(openSession({ sessionId: synced.sessionId, projectPath: cwd }).attachments.length, 1);
		assert.deepEqual(notices, []);
		assert.ok(existsSync(session.jsonlPath));
	});
});

describe("actual import recording", () => {
	function imported(messages) {
		const session = createSession({ projectPath: cwd });
		const recorded = importHistory(session, messages);
		session.save();
		assert.deepEqual(recorded.digests, digestMessages(messages));
		const uuids = new Set(session.records.map((r) => r.uuid));
		for (const uuid of recorded.uuids) if (uuid !== null) assert.ok(uuids.has(uuid));
		validateRecording(recorded);
		return { session, recorded };
	}
	it("keeps leading/consecutive omissions aligned, including entirely omitted imports", () => {
		const empty = assistant([]);
		const { recorded } = imported([empty, empty, user("hi"), empty]);
		assert.deepEqual(recorded.uuids.map((uuid) => uuid === null), [true, true, false, true]);
		assert.deepEqual(recorded.cuttable, [false, false, true, false]);
		const synced = sync([empty, empty, user("next")]);
		assert.equal(synced.sessionId, null);
		assert.equal(synced.recorded.digests.length, 2);
		assert.equal(__test.getSharedSession("pi"), null);
	});
	it("unchanged omitted slots resume instead of rebuilding repeatedly", () => {
		const priors = [assistant([]), user("hi"), say("hello"), assistant([])];
		const { session } = seed(priors);
		assert.equal(sync([...priors, user("next")]).sessionId, session.sessionId);
	});
	it("empty text emits a placeholder, unlike no content", () => {
		const { session, recorded } = imported([assistant([]), say("")]);
		assert.notEqual(recorded.digests[0], recorded.digests[1]);
		assert.equal(recorded.uuids[0], null);
		assert.match(JSON.stringify(session.records), /incompatible content omitted/);
	});
	it("does not cut inside parallel results across an omitted assistant", () => {
		const { recorded } = imported([calls("X", "Y"), result("X"), assistant([]), result("Y")]);
		assert.deepEqual(recorded.cuttable, [false, false, false, true]);
		assert.equal(recorded.uuids[1], recorded.uuids[3]);
	});
	it("the final result boundary includes the hoisted steer", () => {
		const { session, recorded } = imported([calls("X", "Y"), result("X"), user("steer"), result("Y")]);
		assert.deepEqual(recorded.cuttable, [false, false, false, true]);
		assert.equal(recorded.uuids[3], session.records.at(-1).uuid);
		assert.equal(session.records.at(-1).message.content, "steer");
	});
	it("synthetic repairs belong to the assistant boundary; dropped results remain omissions", () => {
		const { session, recorded } = imported([calls("X"), say("next"), result("orphan")]);
		assert.match(JSON.stringify(session.records[1]), /no tool result recorded/);
		assert.equal(recorded.uuids[0], session.records[1].uuid);
		assert.equal(recorded.cuttable[0], false, "synthetic repair cannot close pi's outstanding call");
		assert.equal(recorded.uuids[2], null);
		assert.equal(recorded.cuttable[2], false);
	});
	it("a real result arriving after a dangling imported call backs the cut up before the call", () => {
		const priors = [user("hi"), calls("X")];
		const { session, recorded } = imported(priors);
		assert.match(JSON.stringify(session.records.at(-1)), /no tool result recorded/);
		assert.equal(recorded.uuids[1], session.records.at(-1).uuid, "synthetic UUID is informational only");
		assert.deepEqual(recorded.cuttable, [true, false]);
		const live = new LiveRecording(recorded, priors);
		live.assistant(digestMessages([say("continuation")])[0], [], "live-assistant");
		assert.deepEqual(live.recorded.cuttable, [true, false, false], "a later live reply cannot close the imported pi call either");
		const continued = [...priors, result("X")];
		assert.deepEqual(compareHistory(digestMessages(continued), recorded), { commonPrefix: 2, cutCount: 1, equal: false });
		// The future prefix-write path must convert from that cut, retaining the
		// assistant alongside its real result instead of dropping an orphan.
		const suffix = imported(continued.slice(1)).session;
		assert.match(JSON.stringify(suffix.records), /result-X/);
		assert.doesNotMatch(JSON.stringify(suffix.records), /no tool result recorded/);
	});
	it("an omitted assistant between results leaves the logical batch outstanding", () => {
		const priors = [user("hi"), calls("X", "Y"), result("X"), assistant([])];
		const { recorded } = imported(priors);
		assert.deepEqual(recorded.cuttable, [true, false, false, false]);
		assert.equal(compareHistory(digestMessages([...priors, result("Y")]), recorded).cutCount, 1);
	});
	it("comparison selects the preceding valid cut when the prefix ends in omissions", () => {
		const messages = [user("hi"), assistant([]), assistant([])];
		const { recorded } = imported(messages);
		assert.deepEqual(compareHistory(digestMessages(messages), recorded), { commonPrefix: 3, cutCount: 1, equal: true });
	});
	it("rejects absent/misaligned arrays and invalid nullable boundaries", () => {
		for (const state of [{}, { digests: [], uuids: [] }, { digests: ["d"], uuids: [], cuttable: [] }, { digests: ["d"], uuids: [null], cuttable: [true] }, { digests: ["d"], uuids: [""], cuttable: [false] }]) assert.throws(() => compareHistory([], state));
		assert.deepEqual(copyRecording(), { digests: [], uuids: [], cuttable: [] });
	});
});
