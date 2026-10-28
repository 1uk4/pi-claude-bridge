// The provider core's query lifecycle + event mapping.
//
// pi owns the agent loop and executes tools itself, so the provider must behave as a pure
// model stream even though the Agent SDK wants to run its own loop. Tools are exposed to the
// SDK as MCP tools whose handlers NEVER execute anything: they park a promise until the
// host returns the result in the next streamSimple call's transcript.
//
// Modes (both verified against pi-durable):
//  - park (default): ONE query() lives across tool rounds. A call whose trailing toolResults
//    ids ⊆ a live query's `expecting` set swaps its stream onto that query and releases the
//    parked handlers. Streaming input lets a steer reach CLI stdin BEFORE the result.
//  - replay: the query is closed at tool_use; the next call rebuilds a fresh query from the
//    transcript. This is also the crash-recovery path (no live query → rebuild), so the
//    provider never assumes a parked query exists.

import { query as sdkQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type SimpleStreamOptions, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { createToolServer } from "../mcp-server.js";
import { toolResultToMcpContent, type McpResult } from "../extract-tool-results.js";
import { makePromptStream, userMessage, type PromptStream } from "../prompt-stream.js";
import { updateUsage } from "../usage.js";
import { effortForReasoning } from "./effort.js";
import { buildSdkInput, DEFAULT_IMAGE_BUDGET, queryKey, steersAfterLastAssistant, trailingToolResults, type ImageBudget, type PromptContent } from "./convert.js";
import { CONNECTION_LOST, mapSdkError, resultErrorText } from "./errors.js";

export const MCP_SERVER = "durable";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

export type BridgeMode = "park" | "replay";

export interface BridgeOptions {
	mode: BridgeMode;
	idleTtlMs: number;
	maxTurns: number;
	/** Image caps for rebuilt prompts and steers. Default DEFAULT_IMAGE_BUDGET. */
	imageBudget?: ImageBudget;
	cwd: () => string;
	env: () => NodeJS.ProcessEnv;
	cliModelId: (model: Model<any>) => string;
	queryFn: typeof sdkQuery;
	onRateLimit?: (info: unknown) => void;
	pathToClaudeCodeExecutable?: string;
	/** Extra SDK query options merged last (escape hatch; e.g. debug/stderr hooks). */
	sdkOptions?: Record<string, unknown>;
}

type EventStream = ReturnType<typeof createAssistantMessageEventStream>;
type Round = {
	stream: EventStream;
	out: AssistantMessage;
	started: boolean;
	/** SDK content index → out.content index for blocks being streamed. */
	blocks: Map<number, number>;
	/** out.content length at the current message_start, so a restreamed message can be dropped. */
	blockStart: number;
	/** What pi already saw of an abandoned (restreamed) attempt, by block position since blockStart. Deltas can't be retracted, so the retry only emits what pi hasn't seen. */
	replay?: { type: string; text: string }[];
	/** out.content index → replay state for a retry block that re-covers an already-streamed one. */
	replaying: Map<number, { seen: string; diverged: boolean }>;
	stop?: string;
};
type Live = {
	q: ReturnType<typeof sdkQuery>;
	key: string;
	toolNames: Set<string>;
	pending: Map<string, (r: McpResult) => void>; // handler parked, waiting for the host's result
	results: Map<string, McpResult>; // result landed before the handler
	expecting: Set<string>; // tool_use ids surfaced to the host whose result has not been delivered
	cur: Round | null;
	dead: boolean;
	ps?: PromptStream;
	ttl?: ReturnType<typeof setTimeout>;
	/** The host's conversation key (stream options `sessionId`); undefined when the host passes none. */
	conversation?: string;
	/** Idle TTL for this query's parks, overriding the provider-wide one (per-call option or per-conversation setting). */
	ttlMs?: number;
	/** release() arrived while a call was in flight: kill when the round ends instead of parking. */
	releaseWhenParked?: boolean;
};

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		default: return "stop";
	}
}

export class Bridge {
	private lives = new Set<Live>();
	private ttlByConversation = new Map<string, number>();
	constructor(private opts: BridgeOptions) {}

	/** Number of live (parked or streaming) SDK queries. For tests/diagnostics. */
	get liveCount(): number { return this.lives.size; }

	/** Kill every live query (host shutdown / tests). */
	shutdown(): void { for (const l of [...this.lives]) this.kill(l); }

	/**
	 * Close every query parked for `conversation` (the host's stream-options `sessionId`) and kill its claude child.
	 * Other conversations are untouched. Safe to call with nothing parked. A query whose call is still in flight is left
	 * alone and killed when that round ends (instead of parking). A later call for the conversation cold-starts a new query.
	 * Returns the number of queries killed now.
	 */
	release(conversation: string): number {
		let n = 0;
		for (const l of [...this.lives]) {
			if (l.conversation !== conversation) continue;
			if (l.cur) l.releaseWhenParked = true;
			else { this.kill(l); n++; }
		}
		return n;
	}

	/** Idle TTL for one conversation's parked queries (ms; 0 disables the TTL for it); undefined restores the provider-wide TTL. Applies from the next park. */
	setIdleTtl(conversation: string, ms: number | undefined): void {
		if (ms === undefined) this.ttlByConversation.delete(conversation);
		else this.ttlByConversation.set(conversation, ms);
	}

	stream(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions): EventStream {
		const stream = createAssistantMessageEventStream();
		const out = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "pending", timestamp: Date.now() } as unknown as AssistantMessage;
		const round: Round = { stream, out, started: false, blocks: new Map(), blockStart: 0, replaying: new Map() };

		if (options?.signal?.aborted) { this.fail(round, "aborted", "aborted"); return stream; }

		const msgs = context.messages as any[];
		const trailing = trailingToolResults(msgs);
		let tools: Tool[] = [];
		let input: ReturnType<typeof buildSdkInput> | undefined;
		try {
			input = buildSdkInput(context, this.opts.imageBudget ?? DEFAULT_IMAGE_BUDGET);
			tools = input.tools;
		} catch (e) { this.fail(round, "error", e instanceof Error ? e.message : String(e)); return stream; }
		const key = queryKey(input.systemPrompt, tools);

		// The host aborts each call's signal when the call is over (after `done`), so only act
		// while THIS round is still the one streaming; otherwise we would kill the parked query.
		const owner = { live: undefined as Live | undefined };
		options?.signal?.addEventListener("abort", () => {
			const l = owner.live;
			if (l && l.cur === round) { this.kill(l); this.fail(round, "aborted", "aborted"); }
		}, { once: true });

		const parked = this.opts.mode === "park" && trailing.length > 0
			? [...this.lives].find((l) => !l.dead && trailing.every((t) => l.expecting.has(t.toolCallId)))
			: undefined;
		if (parked && parked.key === key) {
			owner.live = parked;
			this.tag(parked, options);
			this.continueParked(parked, round, msgs, trailing, () => this.startFresh(model, input!, round, options, owner));
			return stream;
		}
		// Tool set / system prompt changed (or nothing parked: first round, replay, crash recovery).
		if (parked) this.kill(parked); // MCP server is fixed per query, so a changed tool set needs a new one
		this.startFresh(model, input, round, options, owner);
		return stream;
	}

	// --- query lifecycle ---------------------------------------------------------------

	private startFresh(model: Model<any>, input: ReturnType<typeof buildSdkInput>, round: Round, options: SimpleStreamOptions | undefined, owner: { live?: Live }): void {
		const park = this.opts.mode === "park";
		const l = { pending: new Map(), results: new Map(), expecting: new Set(), cur: round, dead: false, key: queryKey(input.systemPrompt, input.tools), toolNames: new Set(input.tools.map((t) => t.name)) } as Live;
		try {
			const mcp = input.tools.length > 0 ? this.mcpServers(input.tools, l) : undefined;
			if (park) { l.ps = makePromptStream(); void l.ps.push(userMessage(promptBlocks(input.prompt))).catch(() => {}); }
			const effort = effortForReasoning(model, options?.reasoning);
			l.q = this.opts.queryFn({
				prompt: l.ps ? l.ps.stream : (promptToString(input.prompt) as any),
				options: {
					cwd: this.opts.cwd(),
					env: this.opts.env(),
					systemPrompt: input.systemPrompt,
					model: this.opts.cliModelId(model),
					maxTurns: park ? this.opts.maxTurns : 1,
					tools: [], // no CC built-ins: pi's tools only, via MCP
					skills: [],
					strictMcpConfig: true,
					persistSession: false,
					settingSources: [],
					settings: { autoMemoryEnabled: false },
					includePartialMessages: true,
					...(effort ? { effort, extraArgs: { "thinking-display": "summarized" } } : {}),
					...(mcp ? { mcpServers: mcp, allowedTools: input.tools.map((t) => MCP_PREFIX + t.name) } : {}), // auto-approve: they cannot execute anything
					...(this.opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable } : {}),
					...this.opts.sdkOptions,
				} as any,
			});
		} catch (e) { this.fail(round, "error", e instanceof Error ? e.message : String(e)); return; }
		this.tag(l, options);
		owner.live = l;
		this.lives.add(l);
		void this.consume(l, model);
	}

	private tag(l: Live, options: SimpleStreamOptions | undefined): void {
		if (options?.sessionId) l.conversation = options.sessionId;
		const perCall = (options as { idleTtlMs?: number } | undefined)?.idleTtlMs;
		if (typeof perCall === "number") l.ttlMs = perCall;
	}

	private mcpServers(tools: Tool[], l: Live) {
		const server = createToolServer(MCP_SERVER, tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.parameters,
			// NOTHING EXECUTES HERE. Park until the host returns the result via the next call.
			handler: (id: string) => {
				const ready = l.results.get(id);
				if (ready) { l.results.delete(id); return Promise.resolve(ready); }
				return new Promise<McpResult>((resolve) => l.pending.set(id, resolve));
			},
		})));
		return { [MCP_SERVER]: server };
	}

	private continueParked(l: Live, round: Round, msgs: any[], trailing: any[], rebuild: () => void): void {
		clearTimeout(l.ttl);
		l.cur = round;
		const steers = steersAfterLastAssistant(msgs, this.opts.imageBudget ?? DEFAULT_IMAGE_BUDGET);
		void (async () => {
			try {
				// A steer must reach CLI stdin BEFORE the tool result is released (push resolves once written).
				for (const st of steers) await l.ps!.push(userMessage(promptBlocks(st), "next"));
			} catch {
				// stdin is gone: the query is unusable. Degrade to the rebuild path rather than wedge.
				this.kill(l);
				rebuild();
				return;
			}
			for (const t of trailing) {
				const res: McpResult = { content: toolResultToMcpContent(t.content), isError: t.isError };
				l.expecting.delete(t.toolCallId);
				const p = l.pending.get(t.toolCallId);
				if (p) { l.pending.delete(t.toolCallId); p(res); } else l.results.set(t.toolCallId, res);
			}
		})();
	}

	private kill(l: Live): void {
		l.dead = true;
		clearTimeout(l.ttl);
		l.cur = null;
		this.lives.delete(l);
		try { l.ps?.end(); } catch { /* */ }
		try { l.q.close(); } catch { /* */ }
	}

	private armTtl(l: Live): void {
		if (l.releaseWhenParked) { this.kill(l); return; }
		const ms = l.ttlMs ?? (l.conversation !== undefined ? this.ttlByConversation.get(l.conversation) : undefined) ?? this.opts.idleTtlMs;
		if (ms <= 0) return;
		clearTimeout(l.ttl);
		l.ttl = setTimeout(() => this.kill(l), ms);
		l.ttl.unref?.();
	}

	// --- stream helpers ----------------------------------------------------------------

	private ensureStarted(r: Round): void {
		if (!r.started) { r.stream.push({ type: "start", partial: r.out }); r.started = true; }
	}

	private finish(r: Round, ev: any): void {
		this.ensureStarted(r);
		r.stream.push(ev);
		r.stream.end();
	}

	private fail(r: Round, reason: "error" | "aborted", message: string): void {
		r.out.stopReason = reason;
		r.out.errorMessage = message;
		this.finish(r, { type: "error", reason, error: r.out });
	}

	// --- SDK → pi event mapping --------------------------------------------------------

	private async consume(l: Live, model: Model<any>): Promise<void> {
		try {
			for await (const msg of l.q as AsyncIterable<SDKMessage>) { if (l.dead) break; this.pump(l, model, msg); }
		} catch (e) {
			const r = l.cur;
			if (r && !l.dead) { l.cur = null; this.fail(r, "error", e instanceof Error ? e.message : String(e)); }
		} finally {
			// Query ended while a call is still waiting (process died, or result without message_stop).
			const r = l.cur;
			if (!l.dead) { l.cur = null; this.kill(l); if (r) this.fail(r, "error", r.out.errorMessage ?? CONNECTION_LOST); }
			else this.lives.delete(l);
		}
	}

	private pump(l: Live, model: Model<any>, msg: any): void {
		if (msg.type === "rate_limit_event") { this.opts.onRateLimit?.(msg.rate_limit_info); return; }
		const r = l.cur;
		if (!r) return; // between rounds nothing is listening; leftovers are dropped
		if (msg.type === "assistant" && msg.error) {
			const blocks = msg.message?.content;
			r.out.stopReason = "error";
			r.out.errorMessage = mapSdkError(msg.error, (Array.isArray(blocks) ? blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : "") || msg.error);
			return;
		}
		if (msg.type === "stream_event" && !msg.parent_tool_use_id) { this.pumpStreamEvent(l, r, model, msg.event); return; }
		if (msg.type === "result") {
			if (msg.is_error || msg.subtype !== "success") {
				l.cur = null;
				r.out.stopReason = "error";
				r.out.errorMessage = r.out.errorMessage ?? mapSdkError(undefined, resultErrorText(msg));
				this.kill(l);
				this.finish(r, { type: "error", reason: "error", error: r.out });
			} else if (!r.out.content.length && typeof msg.result === "string" && msg.result) {
				// success with no stream events seen (non-streaming fallback): surface result as one text block
				l.cur = null;
				r.out.content.push({ type: "text", text: msg.result });
				r.out.stopReason = "stop";
				this.finish(r, { type: "done", reason: "stop", message: r.out });
			}
		}
	}

	private pumpStreamEvent(l: Live, r: Round, model: Model<any>, e: any): void {
		const out = r.out;
		const push = (ev: any) => r.stream.push(ev);
		if (e.type === "message_start") {
			// Already open: Claude Code gave up on that stream and is retrying it. Drop its blocks.
			if (r.started && out.content.length > r.blockStart) {
				r.replay = out.content.slice(r.blockStart).map((b: any) => ({ type: b.type, text: b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "" }));
				out.content.length = r.blockStart; r.blocks.clear(); r.replaying.clear();
			}
			this.ensureStarted(r);
			r.blockStart = out.content.length;
			if (e.message?.usage) updateUsage(out, e.message.usage, model);
		} else if (e.type === "content_block_start") {
			const cb = e.content_block;
			// A retry re-covering a block pi already saw: no second *_start, and deltas are trimmed to the unseen part.
			const seenBlock = (cb.type === "text" || cb.type === "thinking") ? r.replay?.[out.content.length - r.blockStart] : undefined;
			const replayed = seenBlock?.type === cb.type ? seenBlock : undefined;
			if (cb.type === "text") {
				out.content.push({ type: "text", text: "" });
				r.blocks.set(e.index, out.content.length - 1);
				if (replayed) r.replaying.set(out.content.length - 1, { seen: replayed.text, diverged: false });
				else push({ type: "text_start", contentIndex: out.content.length - 1, partial: out });
			} else if (cb.type === "thinking") {
				out.content.push({ type: "thinking", thinking: "", thinkingSignature: "" } as any);
				r.blocks.set(e.index, out.content.length - 1);
				if (replayed) r.replaying.set(out.content.length - 1, { seen: replayed.text, diverged: false });
				else push({ type: "thinking_start", contentIndex: out.content.length - 1, partial: out });
			} else if (cb.type === "tool_use") {
				const name = String(cb.name).startsWith(MCP_PREFIX) ? String(cb.name).slice(MCP_PREFIX.length) : String(cb.name);
				if (!l.toolNames.has(name)) return; // unserved tool: CC rejects it and retries; surface nothing
				out.content.push({ type: "toolCall", id: cb.id, name, arguments: {}, partialJson: "" } as any);
				r.blocks.set(e.index, out.content.length - 1);
				l.expecting.add(cb.id);
				push({ type: "toolcall_start", contentIndex: out.content.length - 1, partial: out });
			}
		} else if (e.type === "content_block_delta") {
			const i = r.blocks.get(e.index);
			if (i === undefined) return;
			const b: any = out.content[i];
			const rp = r.replaying.get(i);
			// What to emit for a delta: all of it, or on a replayed block only the part pi hasn't seen.
			const unseen = (full: string, delta: string): string => {
				if (!rp || rp.diverged) return delta;
				if (rp.seen.startsWith(full)) return "";
				if (full.startsWith(rp.seen)) { rp.diverged = true; return full.slice(rp.seen.length); }
				rp.diverged = true; // the retry wrote something else; it can't be retracted, so surface the retry whole
				return full;
			};
			if (e.delta.type === "text_delta" && b.type === "text") { b.text += e.delta.text; const d = unseen(b.text, e.delta.text); if (d) push({ type: "text_delta", contentIndex: i, delta: d, partial: out }); }
			else if (e.delta.type === "thinking_delta" && b.type === "thinking") { b.thinking += e.delta.thinking; const d = unseen(b.thinking, e.delta.thinking); if (d) push({ type: "thinking_delta", contentIndex: i, delta: d, partial: out }); }
			else if (e.delta.type === "signature_delta" && b.type === "thinking") b.thinkingSignature = (b.thinkingSignature ?? "") + e.delta.signature;
			else if (e.delta.type === "input_json_delta" && b.type === "toolCall") {
				b.partialJson += e.delta.partial_json;
				try { b.arguments = JSON.parse(b.partialJson); } catch { /* partial */ }
				push({ type: "toolcall_delta", contentIndex: i, delta: e.delta.partial_json, partial: out });
			}
		} else if (e.type === "content_block_stop") {
			const i = r.blocks.get(e.index);
			if (i === undefined) return;
			const b: any = out.content[i];
			if (b.type === "text") push({ type: "text_end", contentIndex: i, content: b.text, partial: out });
			else if (b.type === "thinking") push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: out });
			else if (b.type === "toolCall") {
				try { b.arguments = b.partialJson ? JSON.parse(b.partialJson) : {}; } catch { b.arguments = {}; }
				delete b.partialJson;
				push({ type: "toolcall_end", contentIndex: i, toolCall: b, partial: out });
			}
			r.blocks.delete(e.index);
			r.replaying.delete(i);
		} else if (e.type === "message_delta") {
			if (e.usage) updateUsage(out, e.usage, model);
			if (e.delta?.stop_reason) r.stop = e.delta.stop_reason;
		} else if (e.type === "message_stop") {
			const hasToolCall = out.content.some((b: any) => b.type === "toolCall");
			if (r.stop === "tool_use" && !hasToolCall && out.stopReason !== "error") {
				// Only unserved tools were called; CC rejects them and starts a new message in this query.
				out.content.length = r.blockStart; r.blocks.clear(); r.stop = undefined;
				return;
			}
			l.cur = null;
			if (out.stopReason === "error") { this.kill(l); this.finish(r, { type: "error", reason: "error", error: out }); return; }
			const reason = mapStopReason(r.stop);
			out.stopReason = reason;
			if (reason === "toolUse") {
				this.finish(r, { type: "done", reason, message: out });
				if (this.opts.mode === "replay") this.kill(l); // the parked handler must die with this round's process
				else this.armTtl(l);
			} else {
				l.ps?.end(); // final answer: close stdin so the CLI exits
				this.finish(r, { type: "done", reason, message: out });
			}
		}
	}
}

// SDKUserMessage content is typed against the Anthropic SDK block union; ours is the same shape.
function promptBlocks(content: PromptContent): any { return content; }
function promptToString(content: PromptContent): string {
	return typeof content === "string" ? content : content.map((b: any) => (b.type === "text" ? b.text : "[image]")).join("\n");
}
