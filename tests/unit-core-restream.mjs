/**
 * Claude Code retries a dying stream by re-emitting message_start and the whole message. Deltas already pushed
 * to pi can't be retracted, so the restream must only emit what pi hasn't seen: a consumer that concatenates
 * deltas (the durable harness does) would otherwise show the abandoned partial as stray text before the reply.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createClaudeBridgeProvider } from "../src/core/index.js";
import { mockQuery, transcript, user, msgStart, msgEnd, ev, collect } from "./lib/mock-sdk.mjs";

const MODEL = { ...getModels("anthropic").find((m) => m.id === "claude-haiku-5-5"), api: "claude-bridge", provider: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const open = (index, type) => ev({ type: "content_block_start", index, content_block: { type, [type]: "" } });
const delta = (index, type, text) => ev({ type: "content_block_delta", index, delta: type === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text } });
const stop = (index) => ev({ type: "content_block_stop", index });

async function run(...msgs) {
	const mock = mockQuery();
	const provider = createClaudeBridgeProvider({ queryFn: mock.queryFn, sweepOrphans: false, checkAuth: false });
	const p = collect(provider.streamSimple(MODEL, transcript({ messages: [user("essay")] })));
	mock.calls[0].push(...msgs);
	const events = await p;
	provider.shutdown();
	return events;
}
/** What a delta-concatenating consumer shows. */
const shown = (events, kind) => events.filter((e) => e.type === `${kind}_delta`).map((e) => e.delta).join("");

describe("restreamed message (CC retry after a dropped stream)", () => {
	it("identical retry: pi sees the text once, not partial + whole", async () => {
		const events = await run(
			msgStart(), open(0, "text"), delta(0, "text", "Continuity**\n\nChina is often c"),
			msgStart(), open(0, "text"), delta(0, "text", "Continuity**\n\nChina is often c"), delta(0, "text", "alled a state"), stop(0), msgEnd("end_turn"));
		const done = events.at(-1);
		assert.equal(done.type, "done");
		assert.equal(done.message.content[0].text, "Continuity**\n\nChina is often called a state");
		assert.equal(shown(events, "text"), done.message.content[0].text);
		assert.equal(events.filter((e) => e.type === "text_start").length, 1);
	});

	it("retry delivered in smaller chunks: the seen prefix is still suppressed", async () => {
		const events = await run(
			msgStart(), open(0, "text"), delta(0, "text", "abcdef"),
			msgStart(), open(0, "text"), delta(0, "text", "ab"), delta(0, "text", "cdefgh"), delta(0, "text", "ij"), stop(0), msgEnd("end_turn"));
		assert.equal(shown(events, "text"), "abcdefghij");
		assert.equal(events.at(-1).message.content[0].text, "abcdefghij");
	});

	it("abandoned thinking is not replayed, and never reaches text", async () => {
		const events = await run(
			msgStart(), open(0, "thinking"), delta(0, "thinking", "didn't pick an angle"),
			msgStart(), open(0, "thinking"), delta(0, "thinking", "didn't pick an angle"), delta(0, "thinking", " yet"), stop(0),
			open(1, "text"), delta(1, "text", "Answer"), stop(1), msgEnd("end_turn"));
		assert.equal(shown(events, "thinking"), "didn't pick an angle yet");
		assert.equal(shown(events, "text"), "Answer");
		assert.deepEqual(events.at(-1).message.content.map((b) => b.type), ["thinking", "text"]);
	});

	it("a retry that diverges is surfaced whole and the message stays authoritative", async () => {
		const events = await run(
			msgStart(), open(0, "text"), delta(0, "text", "Once upon"),
			msgStart(), open(0, "text"), delta(0, "text", "In a land"), delta(0, "text", " far away"), stop(0), msgEnd("end_turn"));
		const done = events.at(-1);
		assert.equal(done.message.content.length, 1);
		assert.equal(done.message.content[0].text, "In a land far away");
		assert.equal(shown(events, "text"), "Once upon" + "In a land far away");
	});

	it("a retry with no earlier output behaves as a plain stream", async () => {
		const events = await run(msgStart(), msgStart(), open(0, "text"), delta(0, "text", "hi"), stop(0), msgEnd("end_turn"));
		assert.equal(shown(events, "text"), "hi");
		assert.equal(events.filter((e) => e.type === "text_start").length, 1);
	});
});
