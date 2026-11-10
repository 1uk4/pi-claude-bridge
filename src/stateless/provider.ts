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
import { existsSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createSession, deleteSession, getSessionPath, repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "../convert.js";
import { createToolServer } from "../mcp-server.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "../skills.js";
import { updateUsage } from "../usage.js";
import { makeDebug, type DebugEvent } from "./debuglog.js";
import { effortFor } from "./effort.js";
import { childEnv } from "./env.js";
import { BridgeError, roundError } from "./errors.js";
import { makeGuard, type Guard } from "./guard.js";
import { patchToolResults } from "./patch.js";
import { CONTINUE_PROMPT, planRound } from "./plan.js";
import { createLocks, logicalFromMessages, removeSessionFiles, sweepIdle, verifyAgainst } from "./store.js";

export type QueryFn = (args: { prompt: string | AsyncIterable<any>; options: Options }) => AsyncIterable<any> & { close?: () => void };

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
	/** Session files untouched for this many days are deleted (checked at creation, then at most hourly). Default 7; 0 disables. */
	sessionTtlDays?: number;
	/** Clock, injectable for tests. */
	now?: () => number;
	/** Test seam: runs after the patch temp file is written, before the rename. */
	patchHook?: () => void;
}

interface RoundLog { sessionId: string; promptKind: string; firstEventMs: number | undefined; stopReason: string | undefined; kill: "idle" | "round" | undefined; errorClass?: string; raw?: string }

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
	const lock = createLocks();
	const now = opts.now ?? Date.now;
	const ttlMs = (opts.sessionTtlDays ?? 7) * 86_400_000;
	let lastSweep = -Infinity;
	const sweep = () => {
		const t = now();
		if (t - lastSweep < 3_600_000) return;
		lastSweep = t;
		try {
			const n = sweepIdle(dirname(fileFor("00000000-0000-4000-8000-000000000000")), ttlMs, t);
			if (n) dbg(`idle sweep removed ${n} session file(s)`);
		} catch (e: any) { dbg(`idle sweep failed: ${e?.message ?? e}`); }
	};
	sweep();

	function streamSimple(model: Model<any>, context: { messages: Message[]; tools?: any[] }, options?: SimpleStreamOptions & { tools?: any[]; sessionId?: string }): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output = emptyMessage(model);
		const abort = new AbortController();
		let q: (AsyncIterable<any> & { close?: () => void }) | undefined;
		let aborted = false;
		let killed = false;
		const killQuery = () => { if (killed) return; killed = true; abort.abort(); try { q?.close?.(); } catch { /* already gone */ } };
		const onAbort = () => { aborted = true; signalAbort(); killQuery(); };
		const t0 = Date.now();
		const round: RoundLog = { sessionId: "", promptKind: "", firstEventMs: undefined, stopReason: undefined, kill: undefined };
		let guard: Guard | undefined;
		let release: (() => void) | undefined;
		let signalAbort!: () => void;
		const abortedP = new Promise<void>((r) => { signalAbort = r; });
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.signal?.aborted) onAbort();

		const fail = (reason: "error" | "aborted", message: string) => {
			output.stopReason = reason;
			output.errorMessage = message;
			stream.push({ type: "error", reason, error: output } as any);
			stream.end();
		};

		void (async () => {
			try {
				if (options?.signal?.aborted) return fail("aborted", "aborted");
				const plan = planRound(context.messages);
				// pi-ai 1.4 delivers tools on system messages; options/context.tools is the 1.2 fallback.
				const tools = plan.toolsDeclared ? plan.tools : (options?.tools ?? context.tools ?? []);
				const piSessionId = options?.sessionId;
				if (!piSessionId) return fail("error", "stateless provider: options.sessionId is required (one session file per pi session)");
				const sid = cliSessionId(piSessionId);
				round.sessionId = sid;
				const path = fileFor(sid);
				const toolNames = new Map(tools.map((t: any) => [t.name, `${MCP_TOOL_PREFIX}${t.name}`]));
				const served = new Map<string, string>();
				for (const t of tools) { served.set(`${MCP_TOOL_PREFIX}${t.name}`, t.name); served.set(`${MCP_TOOL_PREFIX}${t.name}`.toLowerCase(), t.name); }
				round.promptKind = plan.promptText ? "user" : plan.results.size ? "tool_results" : "continue";
				const effort = effortFor(model, options?.reasoning);

				// One round at a time per session: verify, patch and the query itself.
				// An abort while waiting must end this round now, not when the holder finishes.
				const held = lock(sid);
				release = held.cancel;
				await Promise.race([held.acquired, abortedP]);
				if (aborted) return fail("aborted", "aborted");
				sweep();

				const { anthropicMessages, sanitizedIds } = plan.importable.length
					? convertPiMessages(plan.importable, toolNames)
					: { anthropicMessages: [] as any[], sanitizedIds: new Map<string, string>() };
				const build = () => {
					removeSessionFiles(path);
					if (!plan.importable.length) return false;
					const session = createSession({ projectPath: opts.sessionDir, sessionId: sid, claudeDir: opts.claudeDir, model: opts.cliModelId?.(model) ?? model.id });
					session.importMessages(repairToolPairing(anthropicMessages as any) as any);
					session.save();
					dbg(`built session ${sid} from ${plan.importable.length} messages`);
					return true;
				};
				const rebuild = (reason: string) => { dbg(`rebuilding session ${sid}: ${reason}`); return build(); };

				let prompt: string | AsyncIterable<any>;
				let resume = false;
				if (existsSync(path)) {
					const mapId = (id: string) => sanitizedIds.get(id) ?? id;
					const resultIds = [...plan.results.keys()].map(mapId);
					let reason = verifyAgainst(path, logicalFromMessages(repairToolPairing(anthropicMessages as any) as any, mapId), resultIds);
					if (!reason && plan.results.size) {
						try {
							const patched = patchToolResults(path, new Map([...plan.results].map(([k, v]) => [mapId(k), v])), { requireAll: true, beforeRename: opts.patchHook });
							if (patched.length < plan.results.size) reason = `denial record not found (${patched.length}/${plan.results.size})`;
							else dbg(`patched ${patched.length}/${plan.results.size} tool results`);
						} catch (e: any) { reason = `patch failed: ${e?.message ?? e}`; }
					}
					if (!reason) { try { const t = new Date(now()); utimesSync(path, t, t); } catch { /* sweep guard only */ } }
					resume = reason ? rebuild(reason) : true;
				} else {
					// Missing file is normal (first round, sweep, forget): build it from the transcript.
					resume = build();
				}
				if (plan.promptContent) {
					// Images in the current user message: streaming input with ONE user message, then the generator ends.
					const content = plan.promptContent;
					prompt = (async function* () {
						yield { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null, session_id: sid };
					})();
				} else prompt = plan.promptText ?? (opts.continuePrompt ?? CONTINUE_PROMPT);

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
					...(effort ? { effort } : {}),
					// Opus hides thinking text unless asked; only for models that think.
					...(effort && (model as any).reasoning ? { extraArgs: { "thinking-display": "summarized" } } : {}),
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
				await consume(q, model, output, stream, { wasAborted: () => aborted, guard, served, round, t0, kill: killQuery, dbg });
			} catch (e: any) {
				if (aborted) return fail("aborted", "aborted");
				if (e instanceof BridgeError) { round.errorClass = e.errorClass; round.raw = e.raw; }
				fail("error", String(e?.message ?? e));
			} finally {
				guard?.dispose();
				killQuery(); // no-op once the query finished or was killed; stops it on any other exit
				options?.signal?.removeEventListener("abort", onAbort);
				dbg({
					event: "round_end", sessionId: round.sessionId, promptKind: round.promptKind,
					ok: output.stopReason !== "error" && output.stopReason !== "aborted", stopReason: output.stopReason,
					sdkStopReason: round.stopReason ?? null, firstEventMs: round.firstEventMs ?? null, endMs: Date.now() - t0,
					usage: { input: output.usage.input, output: output.usage.output, cacheRead: output.usage.cacheRead, cacheWrite: output.usage.cacheWrite },
					kill: round.kill ?? null, error: output.errorMessage ?? null, errorClass: round.errorClass ?? null, errorRaw: round.raw ?? null,
				});
				release?.();
			}
		})();
		return stream;
	}

	return {
		stream: streamSimple,
		streamSimple,
		/** Delete the session file for a pi session id, after any round running on it has finished. */
		async forget(piSessionId: string): Promise<void> {
			const sid = cliSessionId(piSessionId);
			const held = lock(sid);
			try {
				await held.acquired;
				try { deleteSession(sid, opts.sessionDir, opts.claudeDir); } catch { /* none */ }
				removeSessionFiles(fileFor(sid));
			} finally { held.cancel(); }
		},
		/** Nothing is held between calls. */
		dispose(): void {},
	};
}

type Open = { piIndex: number; kind: "text" | "thinking" };
type Pending = { id: string; name: string; input: Record<string, unknown> };
interface ConsumeCtx { wasAborted: () => boolean; guard: Guard; served: Map<string, string>; round: RoundLog; t0: number; kill: () => void; dbg: (e: DebugEvent | string) => void }

/**
 * Map SDK messages of ONE query to pi events. Exactly one assistant message per call.
 *
 * What pi has been told cannot be taken back, so:
 *  - tool calls are announced (start, one delta, end) only when their message is complete
 *    (message_stop, or the end of the query); a stream Claude Code abandons never announces any;
 *  - text/thinking stream live; on abandon they are ended and keep their announced index, retries
 *    get fresh indices, and the abandoned blocks are removed from the final message;
 *  - the usage of an abandoned stream is rolled back.
 */
async function consume(q: AsyncIterable<any>, model: Model<any>, output: AssistantMessage, stream: AssistantMessageEventStream, cx: ConsumeCtx) {
	const open = new Map<number, Open>(); // sdk block index -> streaming text/thinking block
	const tools = new Map<number, Pending & { json: string }>(); // sdk block index -> tool block still receiving input
	let pending: Pending[] = []; // closed tool calls of the current stream, not yet announced
	const held: Pending[] = []; // closed calls of streams replaced by a new message_start before message_stop
	const abandoned = new Set<number>(); // output.content indices to remove from the final message
	let started = false, sawToolUse = false, result: any = null, sdkStop: string | undefined;
	let sawStream = false, streamOpen = false, streamMsgId: string | undefined, streamBlockStart = 0;
	let usageSnapshot: any = null;
	let synthetic: string | undefined, assistantError: string | undefined;
	let reachedEnd = false;
	const ensureStart = () => { if (!started) { started = true; stream.push({ type: "start", partial: output } as any); } };
	// Tool names: only tools pi served, matched in/out of the mcp__custom-tools__ namespace (case-insensitive).
	const piName = (name: string): string | undefined => cx.served.get(name) ?? cx.served.get(name.toLowerCase());

	const startText = (kind: "text" | "thinking", init: string, sig = ""): Open => {
		ensureStart();
		const piIndex = output.content.length;
		output.content.push(kind === "text" ? { type: "text", text: init } as any : { type: "thinking", thinking: init, thinkingSignature: sig } as any);
		stream.push({ type: `${kind}_start`, contentIndex: piIndex, partial: output } as any);
		return { piIndex, kind };
	};
	const endText = (o: Open) => {
		const b: any = output.content[o.piIndex];
		if (o.kind === "text") stream.push({ type: "text_end", contentIndex: o.piIndex, content: b.text, partial: output } as any);
		else stream.push({ type: "thinking_end", contentIndex: o.piIndex, content: b.thinking, partial: output } as any);
	};
	/** start + one delta + end, and only now part of the message. */
	const announceTool = (t: Pending) => {
		ensureStart();
		const piIndex = output.content.length;
		const call: any = { type: "toolCall", id: t.id, name: t.name, arguments: t.input };
		output.content.push(call);
		sawToolUse = true;
		stream.push({ type: "toolcall_start", contentIndex: piIndex, partial: output } as any);
		stream.push({ type: "toolcall_delta", contentIndex: piIndex, delta: JSON.stringify(t.input), partial: output } as any);
		stream.push({ type: "toolcall_end", contentIndex: piIndex, toolCall: call, partial: output } as any);
	};
	const flushPending = () => { const p = pending; pending = []; p.forEach(announceTool); };

	/** The stream Claude Code is retrying (or replacing): end what is open, forget the rest. */
	const abandon = (holdClosedCalls = false) => {
		for (const o of open.values()) { endText(o); }
		open.clear(); tools.clear();
		if (holdClosedCalls) held.push(...pending); // rescued at the end if no later stream re-emits a call
		pending = [];
		for (let i = streamBlockStart; i < output.content.length; i++) abandoned.add(i);
		if (usageSnapshot) Object.assign(output.usage, usageSnapshot, { cost: { ...usageSnapshot.cost } });
		streamOpen = false;
	};

	/** A whole `assistant` message. Same id as the stream = already delivered; new id = non-streaming fallback. */
	const processAssistant = (msg: any) => {
		if (!msg?.content) return;
		if (msg.error) assistantError = String(msg.error);
		if (msg.model === "<synthetic>") {
			// A failure/quota notice, not model output (#162): emit nothing, fail the round with its text.
			if (streamOpen) abandon();
			synthetic = (msg.content as any[]).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n") || "Claude Code reported a failure";
			return;
		}
		if (sawStream) {
			if (!msg.id || !streamMsgId || msg.id === streamMsgId) return;
			if (streamOpen) abandon();
		}
		// Fresh blocks get fresh indices (output.content.length), so nothing collides with streamed ones.
		for (const b of msg.content as any[]) {
			if (b.type === "text" && b.text) {
				const o = startText("text", b.text);
				stream.push({ type: "text_delta", contentIndex: o.piIndex, delta: b.text, partial: output } as any);
				endText(o);
			} else if (b.type === "thinking" || b.type === "redacted_thinking") {
				const o = startText("thinking", b.thinking ?? "", b.signature ?? b.data ?? "");
				if (b.thinking) stream.push({ type: "thinking_delta", contentIndex: o.piIndex, delta: b.thinking, partial: output } as any);
				endText(o);
			} else if (b.type === "tool_use") {
				const name = piName(b.name);
				if (name) announceTool({ id: b.id, name, input: b.input ?? {} });
			}
		}
		if (msg.usage) updateUsage(output, msg.usage, model);
		if (msg.stop_reason) sdkStop = msg.stop_reason;
	};

	const handleStreamEvent = (ev: any) => {
		sawStream = true;
		switch (ev.type) {
			case "message_start":
				// Still open from an earlier message_start: Claude Code retried that stream.
				if (streamOpen) abandon(true);
				flushPending(); // a previous stream that ended with message_stop already flushed; this is a no-op
				streamOpen = true;
				streamMsgId = ev.message?.id;
				streamBlockStart = output.content.length;
				usageSnapshot = { ...output.usage, cost: { ...output.usage.cost } };
				if (ev.message?.usage) updateUsage(output, ev.message.usage, model);
				if (ev.message?.id) output.responseId = ev.message.id;
				break;
			case "content_block_start": {
				const b = ev.content_block ?? {};
				if (b.type === "text") open.set(ev.index, startText("text", ""));
				else if (b.type === "thinking" || b.type === "redacted_thinking") open.set(ev.index, startText("thinking", b.thinking ?? "", b.signature ?? b.data ?? ""));
				else if (b.type === "tool_use") {
					const name = piName(b.name);
					if (name) tools.set(ev.index, { id: b.id, name, input: {}, json: "" }); // nothing is announced yet
				}
				break;
			}
			case "content_block_delta": {
				const d = ev.delta ?? {};
				const t = tools.get(ev.index);
				if (t && d.type === "input_json_delta") { t.json += d.partial_json; break; }
				const o = open.get(ev.index);
				if (!o) break;
				const block: any = output.content[o.piIndex];
				if (d.type === "text_delta") { block.text += d.text; stream.push({ type: "text_delta", contentIndex: o.piIndex, delta: d.text, partial: output } as any); }
				else if (d.type === "thinking_delta") { block.thinking += d.thinking; stream.push({ type: "thinking_delta", contentIndex: o.piIndex, delta: d.thinking, partial: output } as any); }
				else if (d.type === "signature_delta") block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
				break;
			}
			case "content_block_stop": {
				const t = tools.get(ev.index);
				if (t) {
					tools.delete(ev.index);
					let input: Record<string, unknown> = {};
					try { input = t.json ? JSON.parse(t.json) : {}; } catch { cx.dbg(`unparseable tool arguments for ${t.name}: ${t.json.slice(0, 200)}`); /* closed, but unusable */ }
					pending.push({ id: t.id, name: t.name, input }); // announced when the message completes (#146)
					break;
				}
				const o = open.get(ev.index);
				if (o) { open.delete(ev.index); endText(o); }
				break;
			}
			case "message_delta":
				if (ev.delta?.stop_reason) sdkStop = ev.delta.stop_reason;
				if (ev.usage) updateUsage(output, ev.usage, model);
				break;
			case "message_stop": flushPending(); streamOpen = false; break;
		}
	};

	const it = q[Symbol.asyncIterator]();
	try {
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
			reachedEnd = true;
		} catch (e) {
			if (cx.guard.fired) throw cx.guard.fired;
			// The SDK throws after yielding a max-turns result when the model stopped at a tool_use.
			if (!result && !cx.wasAborted()) throw e;
			reachedEnd = true;
		}
	} finally {
		// Any exit before the iterator finished (throw, timeout, abort): stop the query. Not awaited:
		// return() on an iterator with a pending next() would wait for it.
		if (!reachedEnd) {
			cx.kill();
			try { void Promise.resolve(it.return?.()).catch(() => {}); } catch { /* gone */ }
		}
	}
	if (cx.wasAborted()) throw new Error("aborted");
	if (cx.guard.fired) throw cx.guard.fired;

	// Closed tool calls of a stream that never saw message_stop are real (#146); anything still
	// open was cut off: end it for pi, keep it out of the final message.
	flushPending();
	// A replaced stream's closed calls are real unless a later stream re-emitted calls (a retry).
	if (held.length && !sawToolUse) {
		cx.dbg(`rescued ${held.length} closed tool call(s) from an abandoned message (no retry re-emitted them): ${held.map((h) => `${h.name}#${h.id}`).join(", ")}`);
		held.forEach(announceTool);
	}
	for (const o of open.values()) { endText(o); abandoned.add(o.piIndex); }
	open.clear(); tools.clear();
	if (abandoned.size) output.content = output.content.filter((_: any, i: number) => !abandoned.has(i));
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
