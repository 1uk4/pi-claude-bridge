// Stateless pi-ai provider for the Claude Agent SDK.
//
// Every stream() call works from pi's transcript alone. Nothing is kept in memory
// between calls except configuration: one short-lived `query()` per round, one session
// file per pi session id in a single fixed folder.
//
//   transcript ends in tool results -> patch the deny-hook records in the file with the
//                                      real results, prompt = user text after them or CONTINUE_PROMPT
//   transcript ends in user text    -> resume the file, prompt = that text
//   no file yet                     -> build it from the transcript with cc-session-io
//
// Every tool call is denied by a PreToolUse hook: pi runs the tools, never Claude Code.

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createSession, deleteSession, getSessionPath } from "cc-session-io";
import { convertPiMessages } from "../convert.js";
import { createToolServer } from "../mcp-server.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "../skills.js";
import { updateUsage } from "../usage.js";
import { makeDebug, type DebugEvent } from "./debuglog.js";
import { effortFor } from "./effort.js";
import { childEnv } from "./env.js";
import { BridgeError, roundError, timeoutError } from "./errors.js";
import { patchToolResults } from "./patch.js";
import { CONTINUE_PROMPT, planRound } from "./plan.js";

export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<any> & { close?: () => void };

export interface StatelessStreamOptions {
	/** The ONE folder (a fixed project cwd for the CLI) that holds every session file. */
	sessionDir: string;
	/** Override Claude's config dir (defaults to CLAUDE_CONFIG_DIR / ~/.claude). */
	claudeDir?: string;
	/** Injectable for tests. Default: the SDK's query(). */
	queryFn?: QueryFn;
	/** Parent env for the child; credentials are always stripped. Default process.env. */
	env?: NodeJS.ProcessEnv;
	/** Map a pi model to the CLI model id. Default: model.id. */
	cliModelId?: (model: Model<any>) => string;
	pathToClaudeCodeExecutable?: string;
	continuePrompt?: string;
	/** true, or a sink that receives every debug event (also enabled by env CLAUDE_BRIDGE_DEBUG=1). */
	debug?: boolean | ((event: DebugEvent) => void);
	/** JSON-lines debug log path. Default env CLAUDE_BRIDGE_DEBUG_PATH, else ~/.pi/agent/claude-bridge-stateless.log. */
	debugLogPath?: string;
	/** Kill the query when no SDK message arrives for this long. Default 90 000 ms. */
	idleTimeoutMs?: number;
	/** Kill the query when the round takes longer than this in total. Default 600 000 ms. */
	roundTimeoutMs?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
export const DEFAULT_ROUND_TIMEOUT_MS = 600_000;

const DENY_REASON = "The caller runs tools itself; this call is recorded and executed outside this session.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code wants a UUID session id; derive a stable one from any pi session id. */
export function cliSessionId(piSessionId: string): string {
	if (UUID.test(piSessionId)) return piSessionId.toLowerCase();
	const h = createHash("sha256").update(piSessionId).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function emptyMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	} as AssistantMessage;
}

export function createStatelessStreams(opts: StatelessStreamOptions) {
	const runQuery: QueryFn = opts.queryFn ?? ((a) => sdkQuery(a as any) as any);
	/** Debug hook: dbg(event) or dbg("note"). The session-store code calls this for verify/rebuild/patch events. */
	const dbg = makeDebug(opts);
	const fileFor = (sid: string) => getSessionPath(sid, opts.sessionDir, opts.claudeDir);

	function streamSimple(model: Model<any>, context: { messages: Message[]; tools?: any[] }, options?: SimpleStreamOptions & { tools?: any[]; sessionId?: string }): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output = emptyMessage(model);
		const abort = new AbortController();
		let q: (AsyncIterable<any> & { close?: () => void }) | undefined;
		let aborted = false;
		const killQuery = () => { abort.abort(); try { q?.close?.(); } catch { /* already gone */ } };
		const onAbort = () => { aborted = true; killQuery(); };
		const t0 = Date.now();
		const round: RoundLog = { sessionId: "", promptKind: "", firstEventMs: undefined, stopReason: undefined, kill: undefined };
		let guard: Guard | undefined;
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		const fail = (reason: "error" | "aborted", message: string) => {
			output.stopReason = reason;
			output.errorMessage = message;
			stream.push({ type: "error", reason, error: output } as any);
			stream.end();
		};

		void (async () => {
			try {
				if (options?.signal?.aborted) return fail("aborted", "aborted");
				const tools = options?.tools ?? context.tools ?? [];
				const plan = planRound(context.messages);
				const piSessionId = options?.sessionId ?? "default";
				const sid = cliSessionId(piSessionId);
				round.sessionId = sid;
				const path = fileFor(sid);
				const toolNames = new Map(tools.map((t: any) => [t.name, `${MCP_TOOL_PREFIX}${t.name}`]));
				const served = new Map<string, string>();
				for (const t of tools) { served.set(`${MCP_TOOL_PREFIX}${t.name}`, t.name); served.set(`${MCP_TOOL_PREFIX}${t.name}`.toLowerCase(), t.name); }
				round.promptKind = plan.promptText ? "user" : plan.results.size ? "tool_results" : "continue";
				const effort = effortFor(model, options?.reasoning);

				let prompt: string;
				let resume = false;
				if (existsSync(path)) {
					// TODO(session-store ticket): verify the file against the transcript here
					// (history length/ids match, denial records present) and rebuild on mismatch.
					resume = true;
					if (plan.results.size) {
						const patched = patchToolResults(path, plan.results);
						dbg(`patched ${patched.length}/${plan.results.size} tool results`);
					}
					prompt = plan.promptText ?? (plan.results.size ? (opts.continuePrompt ?? CONTINUE_PROMPT) : (opts.continuePrompt ?? CONTINUE_PROMPT));
				} else {
					// Missing file: build it from the transcript (real tool_use/tool_result records).
					if (plan.importable.length) {
						const { anthropicMessages } = convertPiMessages(plan.importable, toolNames);
						const session = createSession({ projectPath: opts.sessionDir, sessionId: sid, claudeDir: opts.claudeDir, model: opts.cliModelId?.(model) ?? model.id });
						session.importMessages(anthropicMessages as any);
						session.save();
						resume = true;
						dbg(`built session ${sid} from ${plan.importable.length} messages`);
					}
					prompt = plan.promptText ?? opts.continuePrompt ?? CONTINUE_PROMPT;
				}

				const mcpServers = tools.length
					? { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, tools.map((t: any) => ({
						name: t.name, description: t.description, inputSchema: t.parameters,
						// Never reached: the PreToolUse hook denies every call before it runs.
						handler: async () => ({ content: [{ type: "text" as const, text: DENY_REASON }], isError: true }),
					}))) }
					: undefined;

				const options2: Options = {
					cwd: opts.sessionDir,
					env: childEnv(opts.env),
					model: opts.cliModelId?.(model) ?? model.id,
					...(resume ? { resume: sid } : { sessionId: sid }),
					maxTurns: 1,
					tools: [],
					...(mcpServers ? { mcpServers } : {}),
					hooks: { PreToolUse: [{ matcher: ".*", hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: DENY_REASON } })] }] },
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
					settingSources: [],
					settings: { includeGitInstructions: false } as any,
					systemPrompt: plan.system,
					includePartialMessages: true,
					abortController: abort,
					...(effort ? { effort, extraArgs: { "thinking-display": "summarized" } } : {}),
					stderr: (data: string) => { for (const line of data.split(/\r?\n/)) if (line) dbg({ event: "cli_stderr", sessionId: sid, line }); },
					...(opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable } : {}),
				};
				dbg({ event: "round_start", sessionId: sid, piSessionId, promptKind: round.promptKind, resume, model: options2.model, effort: effort ?? null, tools: tools.length });
				guard = makeGuard(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, opts.roundTimeoutMs ?? DEFAULT_ROUND_TIMEOUT_MS, (kind, ms) => {
					round.kill = kind;
					dbg({ event: "timeout", sessionId: sid, reason: kind, ms, afterMs: Date.now() - t0 });
					dbg({ event: "kill", sessionId: sid, reason: `${kind} timeout` });
					killQuery();
				});
				q = runQuery({ prompt, options: options2 });
				await consume(q, model, output, stream, { wasAborted: () => aborted, guard, served, round, t0 });
			} catch (e: any) {
				if (aborted) return fail("aborted", "aborted");
				fail("error", String(e?.message ?? e));
			} finally {
				guard?.dispose();
				options?.signal?.removeEventListener("abort", onAbort);
				dbg({
					event: "round_end", sessionId: round.sessionId, promptKind: round.promptKind,
					ok: output.stopReason !== "error" && output.stopReason !== "aborted", stopReason: output.stopReason,
					sdkStopReason: round.stopReason ?? null, firstEventMs: round.firstEventMs ?? null, endMs: Date.now() - t0,
					usage: { input: output.usage.input, output: output.usage.output, cacheRead: output.usage.cacheRead, cacheWrite: output.usage.cacheWrite },
					kill: round.kill ?? null, error: output.errorMessage ?? null,
				});
			}
		})();
		return stream;
	}

	return {
		stream: streamSimple,
		streamSimple,
		/** Delete the session file for a pi session id. */
		forget(piSessionId: string): void {
			const sid = cliSessionId(piSessionId);
			try { deleteSession(sid, opts.sessionDir, opts.claudeDir); } catch { /* none */ }
			rmSync(fileFor(sid), { force: true });
		},
		/** Nothing is held between calls. */
		dispose(): void {},
	};
}

interface RoundLog { sessionId: string; promptKind: string; firstEventMs: number | undefined; stopReason: string | undefined; kill: "idle" | "round" | undefined }

export interface Guard {
	/** Rejects with a retryable timeout error once a timer fires. */
	readonly rejection: Promise<never>;
	readonly fired: BridgeError | undefined;
	/** Call on every SDK message: restarts the idle timer. */
	touch(): void;
	dispose(): void;
}

/** Idle (no message for idleMs) and total (roundMs) timers. dispose() clears both on every exit path. */
export function makeGuard(idleMs: number, roundMs: number, onFire: (kind: "idle" | "round", ms: number) => void): Guard {
	let idle: ReturnType<typeof setTimeout> | undefined, total: ReturnType<typeof setTimeout> | undefined;
	let fired: BridgeError | undefined;
	let reject!: (e: BridgeError) => void;
	const rejection = new Promise<never>((_, rj) => { reject = rj; });
	rejection.catch(() => {}); // a late timeout must never be an unhandled rejection
	const dispose = () => { if (idle) clearTimeout(idle); if (total) clearTimeout(total); idle = total = undefined; };
	const fire = (kind: "idle" | "round", ms: number) => {
		if (fired) return;
		fired = timeoutError(kind, ms);
		dispose();
		reject(fired);
		onFire(kind, ms);
	};
	const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => fire("idle", idleMs), idleMs); };
	total = setTimeout(() => fire("round", roundMs), roundMs);
	arm();
	return { rejection, get fired() { return fired; }, touch() { if (!fired && idle) arm(); }, dispose };
}

type Open = { piIndex: number; kind: "text" | "thinking" | "tool"; json: string };

interface ConsumeCtx { wasAborted: () => boolean; guard: Guard; served: Map<string, string>; round: RoundLog; t0: number }

/** Map SDK messages of ONE query to pi events. Exactly one assistant message per call. */
async function consume(q: AsyncIterable<any>, model: Model<any>, output: AssistantMessage, stream: AssistantMessageEventStream, cx: ConsumeCtx) {
	const open = new Map<number, Open>();
	let started = false, sawToolUse = false, result: any = null, sdkStop: string | undefined;
	let sawStream = false, streamOpen = false, streamMsgId: string | undefined, streamBlockStart = 0;
	let synthetic: string | undefined, assistantError: string | undefined;
	const ensureStart = () => { if (!started) { started = true; stream.push({ type: "start", partial: output } as any); } };
	// Tool names: only tools pi served, matched in/out of the mcp__custom-tools__ namespace (case-insensitive).
	const piName = (name: string): string | undefined => cx.served.get(name) ?? cx.served.get(name.toLowerCase());

	const closeBlock = (idx: number) => {
		const o = open.get(idx);
		if (!o) return;
		open.delete(idx);
		const block: any = output.content[o.piIndex];
		if (o.kind === "text") stream.push({ type: "text_end", contentIndex: o.piIndex, content: block.text, partial: output } as any);
		else if (o.kind === "thinking") stream.push({ type: "thinking_end", contentIndex: o.piIndex, content: block.thinking, partial: output } as any);
		else {
			try { block.arguments = o.json ? JSON.parse(o.json) : (block.arguments ?? {}); } catch { block.arguments = {}; }
			// A tool call is dispatched only when its content block closes (#146): a block cut off
			// mid-stream never reaches pi and never makes the round a toolUse stop.
			sawToolUse = true;
			stream.push({ type: "toolcall_end", contentIndex: o.piIndex, toolCall: block, partial: output } as any);
		}
	};
	const openBlock = (idx: number, b: any) => {
		if (b.type === "tool_use" && !piName(b.name)) return; // unserved tool: Claude Code rejects it itself
		ensureStart();
		const piIndex = output.content.length;
		if (b.type === "text") {
			output.content.push({ type: "text", text: "" } as any);
			open.set(idx, { piIndex, kind: "text", json: "" });
			stream.push({ type: "text_start", contentIndex: piIndex, partial: output } as any);
		} else if (b.type === "thinking" || b.type === "redacted_thinking") {
			output.content.push({ type: "thinking", thinking: b.thinking ?? "", thinkingSignature: b.signature ?? "" } as any);
			open.set(idx, { piIndex, kind: "thinking", json: "" });
			stream.push({ type: "thinking_start", contentIndex: piIndex, partial: output } as any);
		} else if (b.type === "tool_use") {
			output.content.push({ type: "toolCall", id: b.id, name: piName(b.name)!, arguments: {} } as any);
			open.set(idx, { piIndex, kind: "tool", json: "" });
			stream.push({ type: "toolcall_start", contentIndex: piIndex, partial: output } as any);
		}
	};

	/** Drop the blocks of a stream Claude Code abandoned: unclosed tools/thinking must never reach pi. */
	const dropAbandoned = () => {
		open.clear();
		output.content.splice(streamBlockStart);
		streamOpen = false;
		sawToolUse = output.content.some((b: any) => b.type === "toolCall");
	};

	/** A whole `assistant` message. Same id as the stream = already delivered; new id = non-streaming fallback. */
	const processAssistant = (msg: any) => {
		if (!msg?.content) return;
		if (msg.error) assistantError = String(msg.error);
		if (msg.model === "<synthetic>") {
			// A failure/quota notice, not model output (#162): emit nothing, fail the round with its text.
			if (streamOpen) dropAbandoned();
			synthetic = (msg.content as any[]).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n") || "Claude Code reported a failure";
			return;
		}
		if (sawStream) {
			if (!msg.id || !streamMsgId || msg.id === streamMsgId) return;
			if (streamOpen) dropAbandoned();
		}
		// Index offset so these blocks never collide with streamed ones.
		const base = 1_000_000;
		(msg.content as any[]).forEach((b, i) => {
			if (b.type === "text" && !b.text) return;
			openBlock(base + i, b);
			const o = open.get(base + i);
			if (!o) return;
			const block: any = output.content[o.piIndex];
			if (b.type === "text") { block.text = b.text; stream.push({ type: "text_delta", contentIndex: o.piIndex, delta: b.text, partial: output } as any); }
			else if (b.type === "thinking") { block.thinking = b.thinking ?? ""; if (block.thinking) stream.push({ type: "thinking_delta", contentIndex: o.piIndex, delta: block.thinking, partial: output } as any); }
			else if (b.type === "tool_use") o.json = JSON.stringify(b.input ?? {});
			closeBlock(base + i);
		});
		if (msg.usage) updateUsage(output, msg.usage, model);
		if (msg.stop_reason) sdkStop = msg.stop_reason;
	};

	const handleStreamEvent = (ev: any) => {
		sawStream = true;
		switch (ev.type) {
			case "message_start":
				// Still open from an earlier message_start: Claude Code retried that stream.
				if (streamOpen) dropAbandoned();
				streamOpen = true;
				streamMsgId = ev.message?.id;
				streamBlockStart = output.content.length;
				if (ev.message?.usage) updateUsage(output, ev.message.usage, model);
				if (ev.message?.id) output.responseId = ev.message.id;
				break;
			case "content_block_start": openBlock(ev.index, ev.content_block ?? {}); break;
			case "content_block_delta": {
				const o = open.get(ev.index);
				if (!o) break;
				const d = ev.delta ?? {};
				const block: any = output.content[o.piIndex];
				if (d.type === "text_delta") { block.text += d.text; stream.push({ type: "text_delta", contentIndex: o.piIndex, delta: d.text, partial: output } as any); }
				else if (d.type === "thinking_delta") { block.thinking += d.thinking; stream.push({ type: "thinking_delta", contentIndex: o.piIndex, delta: d.thinking, partial: output } as any); }
				else if (d.type === "signature_delta") block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
				else if (d.type === "input_json_delta") {
					o.json += d.partial_json;
					try { block.arguments = JSON.parse(o.json); } catch { /* partial */ }
					stream.push({ type: "toolcall_delta", contentIndex: o.piIndex, delta: d.partial_json, partial: output } as any);
				}
				break;
			}
			case "content_block_stop": closeBlock(ev.index); break;
			case "message_delta":
				if (ev.delta?.stop_reason) sdkStop = ev.delta.stop_reason;
				if (ev.usage) updateUsage(output, ev.usage, model);
				break;
			case "message_stop": streamOpen = false; break;
		}
	};

	const it = q[Symbol.asyncIterator]();
	try {
		for (;;) {
			const r: IteratorResult<any> = await Promise.race([it.next(), cx.guard.rejection]);
			if (r.done) break;
			const m = r.value;
			cx.guard.touch();
			if (cx.round.firstEventMs === undefined) cx.round.firstEventMs = Date.now() - cx.t0;
			if (m.type === "stream_event" && !m.parent_tool_use_id) handleStreamEvent(m.event);
			else if (m.type === "assistant" && !m.parent_tool_use_id) processAssistant(m.message ? { ...m.message, error: m.error ?? m.message.error } : m);
			else if (m.type === "result") result = m;
		}
	} catch (e) {
		if (cx.guard.fired) throw cx.guard.fired;
		// The SDK throws after yielding a max-turns result when the model stopped at a tool_use.
		if (!result && !cx.wasAborted()) throw e;
	}
	if (cx.wasAborted()) throw new Error("aborted");
	if (cx.guard.fired) throw cx.guard.fired;

	// Blocks the stream never closed are dropped, never delivered.
	if (open.size) {
		const dead = new Set([...open.values()].map((o) => o.piIndex));
		open.clear();
		output.content = output.content.filter((_: any, i: number) => !dead.has(i));
		sawToolUse = output.content.some((b: any) => b.type === "toolCall");
	}
	if (result?.usage) updateUsage(output, result.usage, model);
	cx.round.stopReason = sdkStop;

	if (synthetic !== undefined) throw roundError(synthetic, { code: assistantError, status: result?.api_error_status });
	const maxTurnsWithTool = result?.subtype === "error_max_turns" && sawToolUse;
	if (result && (result.is_error || result.subtype?.startsWith("error")) && !maxTurnsWithTool) {
		const msg = (Array.isArray(result.errors) && result.errors.join("; ")) || result.result || result.subtype;
		throw roundError(String(msg), { code: assistantError, status: result.api_error_status });
	}
	ensureStart();
	output.stopReason = sawToolUse ? "toolUse" : sdkStop === "max_tokens" ? "length" : "stop";
	stream.push({ type: "done", reason: output.stopReason, message: output } as any);
	stream.end();
}
