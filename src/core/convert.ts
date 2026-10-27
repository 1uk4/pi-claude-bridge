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

export interface SdkInput {
	systemPrompt: string;
	tools: Tool[];
	prompt: PromptContent;
}

type Piece = string | ContentBlockParam;

/**
 * How many images, and how many bytes of base64, a rebuilt prompt may carry. The newest images win; older ones
 * degrade to the text "[image omitted: too large]". Images in user messages and in tool results count alike.
 *
 * Anthropic's vision docs (https://platform.claude.com/docs/en/build-with-claude/vision.md, and
 * https://platform.claude.com/docs/en/api/overview.md for the request size) give: up to 100 images per request
 * (200k-context models); more than 20 images, counting resent history and tool_result images, tightens the
 * per-image dimension limit (so stay at 20 or fewer, or at 2000px); 8000x8000 max; 10 MB base64 per image on the
 * Claude API but 5 MB on Bedrock; 32 MB per request; jpeg/png/gif/webp only, animations use the first frame.
 *
 * Defaults: 20 images (the point where the dimension limit tightens), 5 MB each (the strictest host, Bedrock),
 * 16 MiB of base64 in all (half the request cap, leaving room for text).
 */
export interface ImageBudget {
	maxImages: number;
	maxImageBytes: number;
	maxTotalBytes: number;
}
export const DEFAULT_IMAGE_BUDGET: ImageBudget = { maxImages: 20, maxImageBytes: 5 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 };

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const isImageType = (t: string | undefined): t is ImageType => (IMAGE_TYPES as readonly string[]).includes(t as string);

/** The one image→block mapping. An image without data or with a type the API does not take stays a placeholder. */
function imagePiece(b: Block): Piece {
	if (!b.data || !isImageType(b.mimeType)) return "[image]";
	return { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } };
}

/** A message's content as prompt pieces: text, with each image as an image block (or "[image]" if unusable). */
function contentPieces(content: unknown): Piece[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const pieces: Piece[] = [];
	for (const b of content as Block[]) {
		if (b.type === "text") { if (b.text) pieces.push(b.text); }
		else if (b.type === "image") pieces.push(imagePiece(b));
	}
	return pieces;
}

export const OMITTED_IMAGE = "[image omitted: too large]";

/** Turn the oldest images beyond the budget into OMITTED_IMAGE. Mutates `parts`. */

function applyImageBudget(parts: Piece[][], budget: ImageBudget): void {
	let count = 0;
	let total = 0;
	const maxImageBytes = Math.min(budget.maxImageBytes, budget.maxTotalBytes);
	for (let i = parts.length - 1; i >= 0; i--) {
		const piece = parts[i];
		for (let j = piece.length - 1; j >= 0; j--) {
			const p = piece[j];
			if (typeof p === "string" || p.type !== "image") continue;
			const bytes = (p.source as { data: string }).data.length;
			if (count < budget.maxImages && bytes <= maxImageBytes && total + bytes <= budget.maxTotalBytes) { count++; total += bytes; }
			else piece[j] = OMITTED_IMAGE;
		}
	}
}

/** A turn: `header` then the pieces, the header sharing the first text piece's line. */
function withHeader(header: string, pieces: Piece[]): Piece[] {
	if (typeof pieces[0] === "string") pieces[0] = header + pieces[0];
	else pieces.unshift(header);
	return pieces;
}

/** Join pieces into one prompt. Text-only history stays a plain string; images anywhere in it (earlier user
 *  messages, tool results) keep their place as image blocks so a rebuilt query still sees them. */
function joinPieces(parts: Piece[][]): PromptContent {
	const blocks: ContentBlockParam[] = [];
	let text = "";
	let images = false;
	const flush = () => { if (text) blocks.push({ type: "text", text }); text = ""; };
	parts.forEach((piece, i) => {
		if (i > 0) text += "\n\n";
		let prevText = false;
		for (const p of piece) {
			if (typeof p === "string") { text += (prevText ? "\n" : "") + p; prevText = true; }
			else { flush(); blocks.push(p); images = true; prevText = false; }
		}
	});
	if (!images) return text;
	flush();
	return blocks;
}

/** User content as SDK input: plain string when text-only, content blocks when it carries images. */
export function userContent(content: unknown, budget: ImageBudget = DEFAULT_IMAGE_BUDGET): PromptContent {
	const pieces = [contentPieces(content)];
	applyImageBudget(pieces, budget);
	const joined = joinPieces(pieces);
	if (typeof joined === "string") return joined;
	// Blocks keep the original shape: each text piece is its own block, not newline-merged.
	return pieces[0].map((p): ContentBlockParam => (typeof p === "string" ? { type: "text", text: p } : p));
}

/** Transcript → system prompt, current tool set, and the prompt for a fresh query. */
export function buildSdkInput(context: TranscriptContext, budget: ImageBudget = DEFAULT_IMAGE_BUDGET): SdkInput {
	const bridged = toBridgeContext(context as unknown as Context);
	const messages = bridged.messages as any[];
	// Content pieces are budgeted first, then each gets its header, so a dropped image reads "[user]\n[image]".
	const turns: { header: string; pieces: Piece[] }[] = [];
	for (const m of messages) {
		if (m.role === "user") turns.push({ header: "[user]\n", pieces: contentPieces(m.content) });
		else if (m.role === "assistant") {
			const parts = (m.content as any[])
				.map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `[called tool ${b.name} id=${b.id} args=${JSON.stringify(b.arguments)}]` : ""))
				.filter(Boolean);
			if (parts.length) turns.push({ header: `[assistant]\n${parts.join("\n")}`, pieces: [] });
		} else if (m.role === "toolResult") {
			turns.push({ header: `[result of tool call ${m.toolCallId} (${m.toolName})${m.isError ? " ERROR" : ""}]\n`, pieces: contentPieces(m.content) });
		}
	}
	const last = messages.at(-1);
	let prompt: PromptContent;
	if (turns.length === 1 && last?.role === "user") prompt = userContent(last.content, budget);
	else {
		applyImageBudget(turns.map((t) => t.pieces), budget);
		prompt = joinPieces([...turns.map((t) => withHeader(t.header, t.pieces)), ["[Continue the conversation from the last entry. Do not repeat tool calls whose results are shown.]"]]);
	}
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
export function steersAfterLastAssistant(messages: readonly any[], budget: ImageBudget = DEFAULT_IMAGE_BUDGET): PromptContent[] {
	let from = messages.length;
	while (from > 0 && messages[from - 1].role !== "assistant") from--;
	return messages.slice(from).filter((m) => m.role === "user").map((m) => userContent(m.content, budget));
}

/** Stable key over everything a parked query bakes in at spawn: system prompt + tool set. */
export function queryKey(systemPrompt: string, tools: readonly Tool[]): string {
	return JSON.stringify([systemPrompt, tools.map((t) => [t.name, t.description, t.parameters])]);
}
