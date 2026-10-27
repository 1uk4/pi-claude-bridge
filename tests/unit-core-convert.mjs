/** Provider core: transcript → SDK input (system from leading system messages, tools via getCurrentTools, history rendering). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSdkInput, trailingToolResults, steersAfterLastAssistant } from "../src/core/convert.js";
import { transcript, tool, user, assistantToolCall, toolResult } from "./lib/mock-sdk.mjs";

describe("core convert", () => {
	it("takes system prompt and tools from the leading system message", () => {
		const input = buildSdkInput(transcript({ system: "Be brief.", tools: [tool("add"), tool("sub")], messages: [user("hi")] }));
		assert.equal(input.systemPrompt, "Be brief.");
		assert.deepEqual(input.tools.map((t) => t.name), ["add", "sub"]);
	});

	it("a lone user message becomes the prompt verbatim", () => {
		assert.equal(buildSdkInput(transcript({ messages: [user("what is 2+2?")] })).prompt, "what is 2+2?");
	});

	it("a lone user message with an image becomes content blocks", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user([{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }])] }));
		assert.deepEqual(prompt, [
			{ type: "text", text: "look" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("renders tool-call history as text for a fresh (rebuild) query", () => {
		const { prompt } = buildSdkInput(transcript({
			messages: [user("add 1 2"), assistantToolCall("toolu_1", "add", { a: 1, b: 2 }), toolResult("toolu_1", "add", "3")],
		}));
		assert.match(prompt, /\[user\]\nadd 1 2/);
		assert.match(prompt, /\[called tool add id=toolu_1 args=\{"a":1,"b":2\}\]/);
		assert.match(prompt, /\[result of tool call toolu_1 \(add\)\]\n3/);
		assert.match(prompt, /Do not repeat tool calls/);
	});

	it("marks errored tool results", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user("x"), assistantToolCall("t1", "add", {}), toolResult("t1", "add", "boom", true)] }));
		assert.match(prompt, /\(add\) ERROR\]\nboom/);
	});

	it("later system messages change the tool set", () => {
		const ctx = transcript({ tools: [tool("add")], messages: [user("a")] });
		ctx.messages.push({ role: "system", content: "", toolsAdded: [tool("mul")], timestamp: 0 });
		assert.deepEqual(buildSdkInput(ctx).tools.map((t) => t.name), ["add", "mul"]);
	});

	it("finds trailing tool results and steers after the last assistant message", () => {
		const msgs = [user("a"), assistantToolCall("t1", "add", {}), toolResult("t1", "add", "3"), user("actually, say PINEAPPLE")];
		assert.deepEqual(trailingToolResults(msgs).map((t) => t.toolCallId), ["t1"]);
		assert.deepEqual(steersAfterLastAssistant(msgs), ["actually, say PINEAPPLE"]);
	});
});

describe("core convert: images in rebuilt history", () => {
	const img = (data) => ({ type: "image", data, mimeType: "image/png" });
	const asst = () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 });

	it("keeps an image from the latest user message when the thread has history", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user("hi"), asst(), user([{ type: "text", text: "see this" }, img("AAAA")])] }));
		assert.ok(Array.isArray(prompt));
		const image = prompt.filter((b) => b.type === "image");
		assert.deepEqual(image, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]);
		const text = prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.match(text, /\[user\]\nhi/);
		assert.match(text, /\[user\]\nsee this/);
		assert.doesNotMatch(text, /\[image\]/);
	});

	it("keeps images in order, each after the text that introduced it", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user([img("ONE")]), asst(), user([{ type: "text", text: "second" }, img("TWO")])] }));
		assert.deepEqual(prompt.map((b) => b.type === "image" ? b.source.data : "text"), ["text", "ONE", "text", "TWO", "text"]);
	});

	it("keeps an image returned by a tool", () => {
		const { prompt } = buildSdkInput(transcript({
			messages: [user("read it"), assistantToolCall("t1", "read", { path: "a.png" }), { ...toolResult("t1", "read", ""), content: [{ type: "image", data: "PIX", mimeType: "image/png" }] }],
		}));
		assert.ok(Array.isArray(prompt));
		assert.deepEqual(prompt.filter((b) => b.type === "image").map((b) => b.source.data), ["PIX"]);
		assert.match(prompt.filter((b) => b.type === "text").map((b) => b.text).join(""), /\[result of tool call t1 \(read\)\]/);
	});

	it("stays a plain string when no image is present", () => {
		assert.equal(typeof buildSdkInput(transcript({ messages: [user("a"), asst(), user("b")] })).prompt, "string");
	});

	it("data-less image blocks degrade to a placeholder", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user("a"), asst(), user([{ type: "image", mimeType: "image/png" }])] }));
		assert.equal(typeof prompt, "string");
		assert.match(prompt, /\[user\]\n\[image\]/);
	});
});

describe("core convert: image budget, media types, equivalence", () => {
	const img = (data, mimeType = "image/png") => ({ type: "image", data, mimeType: mimeType === null ? undefined : mimeType });
	const asst = () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 });
	const imageData = (prompt) => prompt.filter((b) => b.type === "image").map((b) => b.source.data);
	const textOf = (prompt) => prompt.filter((b) => b.type === "text").map((b) => b.text).join("");

	it("keeps several images in one message, in order", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user([{ type: "text", text: "two" }, img("A"), img("B")])] }));
		assert.deepEqual(prompt.map((b) => (b.type === "image" ? b.source.data : b.text)), ["two", "A", "B"]);
	});

	it("over the count budget the oldest images become [image], the newest stay", () => {
		const messages = [user([img("1")]), asst(), user([img("2")]), asst(), user([img("3")])];
		const { prompt } = buildSdkInput(transcript({ messages }), { maxImages: 2, maxImageBytes: 100, maxTotalBytes: 100 });
		assert.deepEqual(imageData(prompt), ["2", "3"]);
		assert.match(textOf(prompt), /\[user\]\n\[image omitted: too large\]/);
	});

	it("over the byte budget the oldest are dropped; an oversized single image is a placeholder", () => {
		const messages = [user([img("a".repeat(6))]), asst(), user([img("b".repeat(6))]), asst(), user([img("c".repeat(50))])];
		const { prompt } = buildSdkInput(transcript({ messages }), { maxImages: 9, maxImageBytes: 10, maxTotalBytes: 10 });
		assert.deepEqual(imageData(prompt), ["b".repeat(6)]);
	});

	it("the budget also applies to a lone user message", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user([img("1"), img("2"), img("3")])] }), { maxImages: 1, maxImageBytes: 9, maxTotalBytes: 9 });
		assert.deepEqual(prompt.map((b) => (b.type === "image" ? b.source.data : b.text)), ["[image omitted: too large]", "[image omitted: too large]", "3"]);
	});

	it("maxImageBytes is clamped to maxTotalBytes", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user([img("a".repeat(8))])] }), { maxImages: 5, maxImageBytes: 100, maxTotalBytes: 4 });
		assert.equal(prompt, "[image omitted: too large]");
	});

	it("a data-less image stays the plain [image] placeholder", () => {
		const { prompt } = buildSdkInput(transcript({ messages: [user("a"), asst(), user([{ type: "image", mimeType: "image/png" }])] }));
		assert.match(prompt, /\[user\]\n\[image\]/);
		assert.doesNotMatch(prompt, /omitted/);
	});

	it("only jpeg/png/gif/webp become image blocks", () => {
		for (const ok of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
			assert.deepEqual(imageData(buildSdkInput(transcript({ messages: [user([img("X", ok)])] })).prompt), ["X"], ok);
		}
		for (const bad of ["image/svg+xml", "image/bmp", "application/pdf", null]) {
			const { prompt } = buildSdkInput(transcript({ messages: [user("hi"), asst(), user([img("X", bad)])] }));
			assert.equal(typeof prompt, "string", String(bad));
			assert.match(prompt, /\[user\]\n\[image\]/);
		}
	});

	it("text-only history renders exactly as the old string join did", () => {
		const oldContentToText = (c) => (typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text ?? "" : b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n"));
		const messages = [
			user("add 1 2"),
			assistantToolCall("t1", "add", { a: 1, b: 2 }),
			toolResult("t1", "add", "3"),
			{ role: "assistant", content: [{ type: "text", text: "three" }], timestamp: 0 },
			user([{ type: "text", text: "line one" }, { type: "text", text: "line two" }]),
			user([{ type: "image", mimeType: "image/png" }]),
			user(""),
		];
		const turns = [];
		for (const m of messages) {
			if (m.role === "user") turns.push(`[user]\n${oldContentToText(m.content)}`);
			else if (m.role === "assistant") {
				const parts = m.content.map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `[called tool ${b.name} id=${b.id} args=${JSON.stringify(b.arguments)}]` : "")).filter(Boolean);
				if (parts.length) turns.push(`[assistant]\n${parts.join("\n")}`);
			} else turns.push(`[result of tool call ${m.toolCallId} (${m.toolName})${m.isError ? " ERROR" : ""}]\n${oldContentToText(m.content)}`);
		}
		const expected = `${turns.join("\n\n")}\n\n[Continue the conversation from the last entry. Do not repeat tool calls whose results are shown.]`;
		assert.equal(buildSdkInput(transcript({ messages })).prompt, expected);
	});
});
