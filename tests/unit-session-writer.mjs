/**
 * The candidate rebuild writer (diag/lib/session-writer.mjs) on a real Claude Code
 * session (Haiku 5.5, two tool turns; prompt_snapshot payloads trimmed, account
 * details replaced) and the pi history the bridge received for it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonl } from "cc-session-io";
import { contentKeys, priorMessages, rebuildRecords } from "../diag/lib/session-writer.mjs";

const fixture = new URL("./fixtures/rebuild-writer/", import.meta.url);
const native = parseJsonl(readFileSync(new URL("native.jsonl", fixture), "utf8"));
const input = JSON.parse(readFileSync(new URL("pi-input.json", fixture), "utf8"));
const sessionId = "00000000-0000-4000-8000-000000000001";
const write = (messages = priorMessages(input.messages), opts = {}) =>
	rebuildRecords({ native, messages, servedToolNames: input.servedToolNames, sessionId, projectPath: "/tmp/writer-fixture", ...opts });

/** A record as a step in the conversation: attachments by uuid, messages by content. */
const step = (record) => record.type === "attachment" ? `attachment ${record.uuid}` : contentKeys(record).join(" + ");
const without = (record, ...keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

describe("session writer", () => {
	it("puts every attachment back after the message it followed, copied verbatim", () => {
		const { records } = write();
		const expected = native.filter((r) => (r.type === "user" || r.type === "assistant") || (r.type === "attachment" && r.attachment.type !== "prompt_snapshot"));
		assert.deepEqual(records.map(step), expected.map(step));
		const byUuid = new Map(native.map((r) => [r.uuid, r]));
		for (const record of records.filter((r) => r.type === "attachment")) {
			assert.deepEqual(without(record, "parentUuid", "sessionId"), without(byUuid.get(record.uuid), "parentUuid", "sessionId"));
		}
	});

	it("links one parent chain under the new session id", () => {
		const { records } = write();
		records.forEach((record, i) => {
			assert.equal(record.parentUuid, i === 0 ? null : records[i - 1].uuid);
			assert.equal(record.sessionId, sessionId);
		});
	});

	it("leaves prompt_snapshot out unless asked to keep it", () => {
		const snapshots = (records) => records.filter((r) => r.attachment?.type === "prompt_snapshot").length;
		assert.equal(snapshots(write().records), 0);
		assert.equal(snapshots(write(undefined, { keepPromptSnapshot: true }).records), 2);
	});

	it("takes message content from pi, not from the native file", () => {
		const messages = structuredClone(priorMessages(input.messages));
		messages[3].content[0].text = "REDACTED";
		const reply = write(messages).records.find((r) => r.type === "assistant" && r.message.content[0].type === "text");
		assert.equal(reply.message.content[0].text, "REDACTED");
	});

	it("with nativeToolDetails, writes tool blocks as Claude Code stored them", () => {
		const messages = structuredClone(priorMessages(input.messages));
		messages[1].content[0].arguments.timeout = 120; // as the bridge adds to bash calls (#203)
		const toolBlocks = (records) => records.filter((r) => r.type === "user" || r.type === "assistant")
			.flatMap((r) => r.message.content).filter((b) => b.type === "tool_use" || b.type === "tool_result");
		// Key order matters on the wire, so compare serialized. CC does not send `caller`.
		assert.equal(JSON.stringify(toolBlocks(write(messages, { nativeToolDetails: true }).records)),
			JSON.stringify(toolBlocks(native).map(({ caller, ...block }) => block)));
	});

	it("refuses to place an attachment whose message is not in pi's history", () => {
		const messages = structuredClone(priorMessages(input.messages));
		messages[0].content[0].text = "a different first prompt";
		assert.throws(() => write(messages), /no unambiguous match in pi's history/);
	});

	it("drops attachments that follow messages past the end of pi's history", () => {
		const { records, omitted } = write(priorMessages(input.messages).slice(0, 4));
		assert.equal(records.filter((r) => r.type === "user" || r.type === "assistant").length, 4);
		// Turn two's prompt countdown and tool-result countdown.
		assert.deepEqual(omitted.filter((o) => o.reason !== "prompt_snapshot").map((o) => o.type), ["total_tokens_reminder", "total_tokens_reminder"]);
	});
});
