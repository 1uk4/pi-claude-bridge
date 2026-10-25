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
