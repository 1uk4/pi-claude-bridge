import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { QueryContext } from "../src/query-state.js";
import { LiveRecording } from "../src/session-sync.js";
import { digestMessage, digestMessages } from "../src/message-digests.js";
const { __test } = await import("../src/index.js");
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-4-5", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (content) => ({ role: "user", content, timestamp: 1 });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: id }], timestamp: 1 });
const consume = (c, messages) => __test.consumeQuery((async function* () { yield* messages; })(), new Map([["mcp__custom-tools__read", "read"]]), model, () => false, c);
const fixture = JSON.parse("[" + readFileSync(new URL("./fixtures/sdk-streams/parallel-tools.jsonl", import.meta.url), "utf8").trim().split("\n").join(",") + "]");

it("pins three independently streamed result records and the last completed assistant boundary", async () => {
	const c = new QueryContext();
	const prompt = user("read three files");
	c.recording.users([prompt], 0, "prompt", true);
	c.resetTurnState(model);
	const first = c.currentPiStream = createAssistantMessageEventStream();
	const stop = fixture.findIndex((m) => m.event?.type === "message_stop");
	await consume(c, fixture.slice(0, stop + 1));
	const assistant = await first.result();
	const sdkAssistant = fixture.slice(0, stop).filter((m) => m.type === "assistant").at(-1);
	assert.deepEqual(c.recording.recorded.digests, digestMessages([prompt, assistant]));
	assert.equal(c.recording.recorded.uuids[1], sdkAssistant.uuid);
	assert.equal(c.recording.recorded.cuttable[1], false);
	const echoes = fixture.filter((m) => m.type === "user" && Array.isArray(m.message.content) && m.message.content.some((b) => b.type === "tool_result"));
	assert.equal(echoes.length, 3);
	const results = echoes.map((m) => result(m.message.content[0].tool_use_id));
	c.recording.results([prompt, assistant, ...results]);
	// There is deliberately no live UI stream here: the recording tap must run.
	await consume(c, echoes);
	assert.deepEqual(c.recording.recorded.uuids.slice(2), echoes.map((m) => m.uuid));
	assert.deepEqual(c.recording.recorded.cuttable, [true, false, false, false, true]);
	assert.deepEqual(c.recording.recorded.digests, digestMessages([prompt, assistant, ...results]));
});

it("late completed assistant echoes cover an already emitted tool step without mutating its message", async () => {
	const c = new QueryContext();
	c.resetTurnState(model);
	const first = c.currentPiStream = createAssistantMessageEventStream();
	const stop = fixture.findIndex((m) => m.event?.type === "message_stop");
	const step = fixture.slice(0, stop + 1);
	await consume(c, step.filter((m) => m.type !== "assistant"));
	const output = await first.result();
	const digest = digestMessage(output);
	assert.equal(c.recording.recorded.digests.length, 0, "stream deltas alone are not durable coverage");
	await consume(c, step.filter((m) => m.type === "assistant"));
	assert.deepEqual(c.recording.recorded.digests, [digest]);
	output.durationMs = 123;
	assert.equal(digestMessage(output), digest);
});

it("a complete block plus an aborted partial block does not cover a live assistant slot", async () => {
	const c = new QueryContext();
	c.resetTurnState(model);
	c.currentPiStream = createAssistantMessageEventStream();
	await consume(c, [
		{ type: "stream_event", event: { type: "message_start", message: { id: "partial" } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "complete" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "assistant", parent_tool_use_id: null, uuid: "complete", message: { id: "partial", model: model.id, content: [{ type: "text", text: "complete" }] } },
		{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "partial" } } },
	]);
	c.turnOutput.stopReason = "aborted";
	assert.deepEqual(c.recording.recorded.digests, []);
});

it("an unacknowledged steer blocks later results/assistants, not an imported null omission", () => {
	const live = new LiveRecording();
	const messages = [user("prompt"), user("lost"), user("acknowledged")];
	live.users(messages.slice(0, 1), 0, "prompt", true);
	live.users(messages.slice(0, 2), 1, "lost", false);
	live.users(messages, 2, "later", false);
	live.acknowledge("later");
	live.assistant("done-digest", [], "done");
	assert.deepEqual(live.recorded.digests, digestMessages(messages.slice(0, 1)));
	assert.deepEqual(live.recorded.uuids, ["prompt"]);
});

it("out-of-order parallel results cut only at the end of the complete batch", () => {
	const live = new LiveRecording();
	live.assistant("assistant", ["X", "Y"], "assistant-uuid");
	live.results([{ role: "assistant", content: [] }, result("X"), result("Y")]);
	live.result("Y", "first-record");
	live.result("X", "last-record");
	assert.deepEqual(live.recorded.uuids, ["assistant-uuid", "last-record", "last-record"]);
	assert.deepEqual(live.recorded.cuttable, [false, false, true]);
});

it("coalesced prompt users share a boundary but only the last can be cut", () => {
	const live = new LiveRecording();
	live.users([user("one"), user("two")], 0, "prompt", true);
	assert.deepEqual(live.recorded.uuids, ["prompt", "prompt"]);
	assert.deepEqual(live.recorded.cuttable, [false, true]);
	live.acknowledge("prompt");
	assert.deepEqual(live.recorded.cuttable, [false, true]);
});
