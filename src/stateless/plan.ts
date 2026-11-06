// Reading pi's transcript for one round: what is the system prompt, what history is
// already in the session file, which tool results are new, and what is the prompt.

import type { Message } from "@earendil-works/pi-ai";
import type { ResultContent, ToolResultPatch } from "./patch.js";

export const CONTINUE_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";

export interface RoundPlan {
	/** Replayed system messages as one plain string. */
	system: string;
	/** Tools in effect, replayed from toolsAdded/toolsRemoved on system messages. */
	tools: any[];
	/** True when any system message carried toolsAdded/toolsRemoved (so an empty set is authoritative). */
	toolsDeclared: boolean;
	/** Messages up to and including the last assistant message, no trailing results. */
	history: Message[];
	/** Everything except the trailing user messages: history plus the trailing tool results. */
	importable: Message[];
	/** Trailing tool results (real), keyed by tool call id. Empty when the tail is not results. */
	results: Map<string, ToolResultPatch>;
	/** Text of the user messages that follow the results (or follow the history), if any. */
	promptText: string | undefined;
	/** Text and image blocks of those user messages, in order. Set only when at least one image is present. */
	promptContent: PromptBlock[] | undefined;
}

export type PromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** Ordered text/image blocks of the user messages; messages are separated like promptText ("\n\n"). */
function blocksOf(users: Message[]): PromptBlock[] {
	const out: PromptBlock[] = [];
	for (const m of users as any[]) {
		const parts: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
		const mine: PromptBlock[] = [];
		for (const b of parts) {
			if (b?.type === "image") mine.push({ type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
			else if (b?.type === "text" && b.text) mine.push({ type: "text", text: b.text });
		}
		if (!mine.length) continue;
		if (out.length) out.push({ type: "text", text: "\n\n" });
		out.push(...mine);
	}
	return out;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

/**
 * Replay pi's system messages in order into the state they describe (pi-ai 1.4):
 * the leading `content` is the base prompt, later `content` is appended; `sections`
 * live in a name-keyed map (later overwrites, null deletes) and render after the
 * content; `toolsAdded` add by name (later replaces earlier), `toolsRemoved` remove.
 */
export function replaySystem(messages: Message[]): { prompt: string; tools: any[]; declared: boolean } {
	const contents: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, any>();
	let declared = false;
	for (const m of messages as any[]) {
		if (m.role !== "system") continue;
		const c = textOf(m.content);
		if (c) contents.push(c);
		for (const [name, v] of Object.entries(m.sections ?? {})) {
			if (v === null) sections.delete(name);
			else if (typeof v === "string") sections.set(name, v);
		}
		// Same order as pi-ai getCurrentTools: removals first, so a redefined tool (removal + addition) survives.
		if (m.toolsAdded || m.toolsRemoved) declared = true;
		for (const r of m.toolsRemoved ?? []) tools.delete(r.name);
		for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
	}
	const prompt = [...contents, ...[...sections.values()].filter(Boolean)].join("\n\n");
	return { prompt, tools: [...tools.values()], declared };
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
	const { prompt: system, tools, declared: toolsDeclared } = replaySystem(messages);
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
	const hasImage = users.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "image"));
	const promptContent = hasImage ? blocksOf(users) : undefined;
	return { system, tools, toolsDeclared, history: rest.slice(0, end), importable: rest.slice(0, afterUsers), results, promptText, promptContent };
}
