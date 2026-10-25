// Transcript → Agent SDK input for the provider core.
//
// pi-ai 1.4 hands providers a TranscriptContext: the system prompt and tool set are folded
// into leading `system` messages (content, sections, toolsAdded/toolsRemoved). toBridgeContext
// (src/transcript.ts, shared with the TUI) replays them back into systemPrompt + tools and
// strips them from the conversation. What is left is rendered into a prompt for a FRESH query
// (first round, replay mode, crash recovery). A parked query never needs this: it already
// holds the history and only receives tool results / steers.

import type { Context, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { toBridgeContext } from "../transcript.js";

export type PromptContent = string | ContentBlockParam[];

type Block = { type: string; text?: string; data?: string; mimeType?: string };

/** Text of a message's content; images become a placeholder. */
export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((b) => (b.type === "text" ? b.text ?? "" : b.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

/** User content as SDK input: plain string when text-only, content blocks when it carries images. */
export function userContent(content: unknown): PromptContent {
	if (!Array.isArray(content) || !(content as Block[]).some((b) => b.type === "image" && b.data)) return contentToText(content);
	return (content as Block[]).flatMap((b): ContentBlockParam[] => {
		if (b.type === "text" && b.text) return [{ type: "text", text: b.text }];
		if (b.type === "image" && b.data) {
			return [{ type: "image", source: { type: "base64", media_type: b.mimeType as any, data: b.data } }];
		}
		return [];
	});
}

export interface SdkInput {
	systemPrompt: string;
	tools: Tool[];
	prompt: PromptContent;
}

/** Transcript → system prompt, current tool set, and the prompt for a fresh query. */
export function buildSdkInput(context: TranscriptContext): SdkInput {
	const bridged = toBridgeContext(context as unknown as Context);
	const messages = bridged.messages as any[];
	const turns: string[] = [];
	for (const m of messages) {
		if (m.role === "user") turns.push(`[user]\n${contentToText(m.content)}`);
		else if (m.role === "assistant") {
			const parts = (m.content as any[])
				.map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `[called tool ${b.name} id=${b.id} args=${JSON.stringify(b.arguments)}]` : ""))
				.filter(Boolean);
			if (parts.length) turns.push(`[assistant]\n${parts.join("\n")}`);
		} else if (m.role === "toolResult") {
			turns.push(`[result of tool call ${m.toolCallId} (${m.toolName})${m.isError ? " ERROR" : ""}]\n${contentToText(m.content)}`);
		}
	}
	const last = messages.at(-1);
	const prompt: PromptContent = turns.length === 1 && last?.role === "user"
		? userContent(last.content)
		: `${turns.join("\n\n")}\n\n[Continue the conversation from the last entry. Do not repeat tool calls whose results are shown.]`;
	return { systemPrompt: bridged.systemPrompt ?? "", tools: bridged.tools ?? [], prompt };
}

/** Trailing toolResult messages: the results for the last assistant message's tool calls. */
export function trailingToolResults(messages: readonly any[]): any[] {
	const trailing: any[] = [];
	for (let i = messages.length - 1; i >= 0 && messages[i].role !== "assistant"; i--) {
		if (messages[i].role === "toolResult") trailing.unshift(messages[i]);
	}
	return trailing;
}

/** User messages after the last assistant message (steer / follow-up injected mid-tool). */
export function steersAfterLastAssistant(messages: readonly any[]): PromptContent[] {
	let from = messages.length;
	while (from > 0 && messages[from - 1].role !== "assistant") from--;
	return messages.slice(from).filter((m) => m.role === "user").map((m) => userContent(m.content));
}

/** Stable key over everything a parked query bakes in at spawn: system prompt + tool set. */
export function queryKey(systemPrompt: string, tools: readonly Tool[]): string {
	return JSON.stringify([systemPrompt, tools.map((t) => [t.name, t.description, t.parameters])]);
}
