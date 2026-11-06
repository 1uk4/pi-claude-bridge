// Stateless provider: images in the current (trailing) user messages reach the SDK as image blocks.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatelessStreams } from "../src/stateless/index.js";

const MODEL = { id: "sonnet", api: "x", provider: "p", name: "s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1e5, maxTokens: 1e4, reasoning: false };
let root, seq = 0;
before(() => { root = mkdtempSync(join(tmpdir(), "stateless-img-")); });
after(() => rmSync(root, { recursive: true, force: true }));

const sys = { role: "system", content: "You are terse." };
const text = (t) => ({ type: "text", text: t });
const img = (data, mimeType = "image/png") => ({ type: "image", data, mimeType });
const user = (content) => ({ role: "user", content, timestamp: 1 });
const OK = { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };

async function round(messages) {
	const calls = [];
	const queryFn = (args) => { calls.push(args); return (async function* () { yield OK; })(); };
	const streams = createStatelessStreams({ sessionDir: join(root, "cwd"), claudeDir: join(root, "claude"), queryFn });
	const s = streams.streamSimple(MODEL, { messages }, { sessionId: `s${++seq}` });
	for await (const _ of s) { /* drain */ }
	await s.result();
	assert.equal(calls.length, 1);
	return calls[0];
}
async function drain(it) { const out = []; for await (const m of it) out.push(m); return out; }

describe("stateless current-message images", () => {
	it("image in the current user message becomes an image block via a one-message iterable", async () => {
		const { prompt } = await round([sys, user([text("what is this?"), img("AAAA")])]);
		assert.equal(typeof prompt, "object");
		const msgs = await drain(prompt);
		assert.equal(msgs.length, 1);
		const [m] = msgs;
		assert.equal(m.type, "user"); assert.equal(m.parent_tool_use_id, null); assert.ok(m.session_id);
		assert.equal(m.message.role, "user");
		assert.deepEqual(m.message.content, [
			{ type: "text", text: "what is this?" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("text-only round keeps the plain string prompt", async () => {
		const a = await round([sys, user("hello")]);
		assert.equal(a.prompt, "hello");
		const b = await round([sys, user([text("a"), text("b")])]);
		assert.equal(b.prompt, "a\nb");
	});

	it("keeps text/image order across several trailing user messages", async () => {
		const { prompt } = await round([sys, user("first"), user([img("ONE"), text("mid"), img("TWO", "image/jpeg")]), user("last")]);
		const [m] = await drain(prompt);
		const shape = m.message.content.map((b) => b.type === "image" ? `img:${b.source.data}:${b.source.media_type}` : b.text);
		assert.deepEqual(shape, ["first", "\n\n", "img:ONE:image/png", "mid", "img:TWO:image/jpeg", "\n\n", "last"]);
	});

	it("never flattens an image to the text '[image]'", async () => {
		const { prompt } = await round([sys, user([img("AAAA")])]);
		const [m] = await drain(prompt);
		assert.ok(!JSON.stringify(m).includes("[image]"));
		assert.deepEqual(m.message.content.map((b) => b.type), ["image"]);
	});
});
