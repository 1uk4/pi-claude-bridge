// Reading pi's transcript for one round: what is the system prompt, what history is
// already in the session file, which tool results are new, and what is the prompt.

import type { Message } from "@earendil-works/pi-ai";
import type { ResultContent, ToolResultPatch } from "./patch.js";

export const CONTINUE_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";

export interface RoundPlan {
	/** Leading/inline system messages joined as one plain string. */
	system: string;
	/** Messages up to and including the last assistant message, no trailing results. */
	history: Message[];
	/** Everything except the trailing user messages: history plus the trailing tool results. */
	importable: Message[];
	/** Trailing tool results (real), keyed by tool call id. Empty when the tail is not results. */
	results: Map<string, ToolResultPatch>;
	/** Text of the user messages that follow the results (or follow the history), if any. */
	promptText: string | undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

function systemText(m: any): string {
	let s = textOf(m.content);
	if (m.sections) for (const v of Object.values(m.sections)) if (typeof v === "string" && v) s += (s ? "\n\n" : "") + v;
	return s;
}

export function resultContent(content: unknown): ResultContent {
	if (typeof content === "string") return content;
	const parts = (content as any[]) ?? [];
	if (parts.every((b) => b?.type === "text")) return parts.map((b) => b.text).join("\n");
	return parts.map((b) => b?.type === "image"
		? { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }
		: { type: "text", text: b?.text ?? "" });
}

export function planRound(messages: Message[]): RoundPlan {
	const system = messages.filter((m) => m.role === "system").map(systemText).filter(Boolean).join("\n\n");
	const rest = messages.filter((m) => m.role !== "system");
	let end = rest.length;
	const users: Message[] = [];
	while (end > 0 && rest[end - 1].role === "user") users.unshift(rest[--end]);
	const afterUsers = end;
	const results = new Map<string, ToolResultPatch>();
	while (end > 0 && rest[end - 1].role === "toolResult") {
		const m: any = rest[--end];
		results.set(m.toolCallId, { content: resultContent(m.content), isError: !!m.isError });
	}
	const promptText = users.map((m: any) => textOf(m.content)).filter(Boolean).join("\n\n") || undefined;
	return { system, history: rest.slice(0, end), importable: rest.slice(0, afterUsers), results, promptText };
}
