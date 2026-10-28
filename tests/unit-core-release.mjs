/**
 * Per-conversation release and idle-TTL override, against a mocked Agent SDK (no real claude child).
 * A conversation is the host's stream-options sessionId.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createClaudeBridgeProvider } from "../src/core/index.js";
import { mockQuery, transcript, user, assistantToolCall, toolResult, msgStart, textBlock, toolUseBlock, msgEnd, collect, tick } from "./lib/mock-sdk.mjs";

const MODEL = { ...getModels("anthropic").find((m) => m.id === "claude-haiku-5-5"), api: "claude-bridge", provider: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function setup(opts = {}) {
	const mock = mockQuery();
	const provider = createClaudeBridgeProvider({ queryFn: mock.queryFn, sweepOrphans: false, checkAuth: false, ...opts });
	const run = (context, options) => provider.streamSimple(MODEL, context, options);
	return { provider, mock, run };
}
// Park a query for `sessionId` at a tool call; returns the transcript so far and the mock call index.
async function park(h, sessionId, toolId, extra = {}) {
	const msgs = [user(`go ${sessionId}`)];
	const idx = h.mock.calls.length;
	const p = collect(h.run(transcript({ messages: msgs }), { sessionId, ...extra }));
	h.mock.calls[idx].push(msgStart(), toolUseBlock(0, toolId, "mcp__durable__add", "{}"), msgEnd("tool_use"));
	await p;
	return { msgs: [...msgs, assistantToolCall(toolId, "add", {})], idx };
}

describe("release(conversation)", () => {
	it("closes only the target conversation's parked queries", async () => {
		const h = setup();
		await park(h, "conv-a", "ta");
		await park(h, "conv-b", "tb");
		assert.equal(h.provider.liveQueries, 2);
		assert.equal(h.provider.release("conv-a"), 1);
		assert.equal(h.mock.calls[0].closed, true);
		assert.equal(h.mock.calls[1].closed, false);
		assert.equal(h.provider.liveQueries, 1);
		h.provider.shutdown();
	});

	it("is a no-op when nothing is parked, for an unknown key, and when called twice", async () => {
		const h = setup();
		assert.equal(h.provider.release("nobody"), 0);
		await park(h, "conv-a", "ta");
		assert.equal(h.provider.release("other"), 0);
		assert.equal(h.provider.liveQueries, 1);
		assert.equal(h.provider.release("conv-a"), 1);
		assert.equal(h.provider.release("conv-a"), 0);
		h.provider.shutdown();
	});

	it("leaves an in-flight call alone and kills its query when the round ends", async () => {
		const h = setup();
		const p = collect(h.run(transcript({ messages: [user("go")] }), { sessionId: "conv-a" }));
		h.mock.calls[0].push(msgStart(), toolUseBlock(0, "ta", "mcp__durable__add", "{}"));
		await tick();
		assert.equal(h.provider.release("conv-a"), 0, "nothing killed while the call streams");
		assert.equal(h.mock.calls[0].closed, false);
		h.mock.calls[0].push(msgEnd("tool_use"));
		const events = await p;
		assert.equal(events.at(-1).reason, "toolUse", "the in-flight call still completes");
		assert.equal(h.mock.calls[0].closed, true, "killed instead of parking");
		assert.equal(h.provider.liveQueries, 0);
	});

	it("a call after release cold-starts a fresh query that works", async () => {
		const h = setup();
		const { msgs } = await park(h, "conv-a", "ta");
		h.provider.release("conv-a");
		// the host replays the transcript with the tool result; the parked query is gone, so it rebuilds
		const p = collect(h.run(transcript({ messages: [...msgs, toolResult("ta", "add", "3")] }), { sessionId: "conv-a" }));
		assert.equal(h.mock.calls.length, 2, "a second query was spawned");
		h.mock.calls[1].push(msgStart(), textBlock(0, "three"), msgEnd("end_turn"));
		const events = await p;
		assert.equal(events.at(-1).reason, "stop");
		assert.equal(events.at(-1).message.content[0].text, "three");
		h.provider.shutdown();
	});

	it("does not release a query stream-tagged with a different conversation key", async () => {
		const h = setup();
		await park(h, "conv-a", "ta");
		await park(h, "conv-ab", "tb"); // prefix-similar key
		h.provider.release("conv-a");
		assert.equal(h.mock.calls[1].closed, false);
		h.provider.shutdown();
	});
});

describe("idle TTL override", () => {
	it("a per-conversation TTL shortens the park below the provider-wide one", async () => {
		const h = setup({ idleTtlMs: 60_000 });
		h.provider.setIdleTtl("conv-a", 20);
		await park(h, "conv-a", "ta");
		await park(h, "conv-b", "tb");
		await tick(80);
		assert.equal(h.mock.calls[0].closed, true);
		assert.equal(h.mock.calls[1].closed, false, "other conversations keep the provider-wide TTL");
		h.provider.shutdown();
	});

	it("a per-call idleTtlMs in the stream options applies to that query", async () => {
		const h = setup({ idleTtlMs: 60_000 });
		await park(h, "conv-a", "ta", { idleTtlMs: 20 });
		await tick(80);
		assert.equal(h.mock.calls[0].closed, true);
	});

	it("clearing the override restores the provider-wide TTL", async () => {
		const h = setup({ idleTtlMs: 60_000 });
		h.provider.setIdleTtl("conv-a", 20);
		h.provider.setIdleTtl("conv-a", undefined);
		await park(h, "conv-a", "ta");
		await tick(80);
		assert.equal(h.mock.calls[0].closed, false);
		h.provider.shutdown();
	});
});

describe("release edge cases", () => {
	it("several queries on one conversation are all released", async () => {
		const h = setup();
		await park(h, "conv-a", "t1");
		await park(h, "conv-a", "t2");
		assert.equal(h.provider.liveQueries, 2);
		assert.equal(h.provider.release("conv-a"), 2);
		assert.equal(h.provider.liveQueries, 0);
	});

	it("a release then an immediate new call: the old in-flight round dies at its end, the new query survives", async () => {
		const h = setup();
		const p1 = collect(h.run(transcript({ messages: [user("one")] }), { sessionId: "conv-a" }));
		h.mock.calls[0].push(msgStart(), toolUseBlock(0, "t1", "mcp__durable__add", "{}"));
		await tick();
		h.provider.release("conv-a");
		const p2 = collect(h.run(transcript({ messages: [user("two")] }), { sessionId: "conv-a" }));
		h.mock.calls[0].push(msgEnd("tool_use"));
		await p1;
		h.mock.calls[1].push(msgStart(), toolUseBlock(0, "t2", "mcp__durable__add", "{}"), msgEnd("tool_use"));
		await p2;
		assert.equal(h.mock.calls[0].closed, true);
		assert.equal(h.mock.calls[1].closed, false, "the new call's query is parked");
		assert.equal(h.provider.liveQueries, 1);
		h.provider.shutdown();
	});

	it("a later setIdleTtl overrides an earlier per-call idleTtlMs; invalid values are ignored", async () => {
		const h = setup({ idleTtlMs: 60_000 });
		const { idx } = await park(h, "conv-a", "ta", { idleTtlMs: 20 });
		h.provider.setIdleTtl("conv-a", 60_000); // before the park's timer fires, but timer is already armed at 20ms
		h.provider.setIdleTtl("conv-b", Number.NaN);
		h.provider.setIdleTtl("conv-b", -5);
		const q = await park(h, "conv-b", "tb");
		await tick(80);
		assert.equal(h.mock.calls[idx].closed, true, "already-armed timer is unchanged");
		assert.equal(h.mock.calls[q.idx].closed, false, "invalid override ignored: provider-wide TTL");
		h.provider.shutdown();
	});

	it("release drops the conversation's TTL override", async () => {
		const h = setup({ idleTtlMs: 60_000 });
		h.provider.setIdleTtl("conv-a", 20);
		h.provider.release("conv-a");
		const { idx } = await park(h, "conv-a", "ta");
		await tick(80);
		assert.equal(h.mock.calls[idx].closed, false);
		h.provider.shutdown();
	});
});
