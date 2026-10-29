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
import { childEnv } from "./env.js";
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
	debug?: (msg: string) => void;
}

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
	const dbg = opts.debug ?? (() => {});
	const fileFor = (sid: string) => getSessionPath(sid, opts.sessionDir, opts.claudeDir);

	function streamSimple(model: Model<any>, context: { messages: Message[]; tools?: any[] }, options?: SimpleStreamOptions & { tools?: any[]; sessionId?: string }): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output = emptyMessage(model);
		const abort = new AbortController();
		let q: (AsyncIterable<any> & { close?: () => void }) | undefined;
		let aborted = false;
		const onAbort = () => { aborted = true; abort.abort(); try { q?.close?.(); } catch { /* already gone */ } };
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
				const plan = planRound(context.messages);
				// pi-ai 1.4 delivers tools on system messages; options/context.tools is the 1.2 fallback.
				const tools = plan.tools.length ? plan.tools : (options?.tools ?? context.tools ?? []);
				const piSessionId = options?.sessionId;
				if (!piSessionId) return fail("error", "stateless provider: options.sessionId is required (one session file per pi session)");
				const sid = cliSessionId(piSessionId);
				const path = fileFor(sid);
				const toolNames = new Map(tools.map((t: any) => [t.name, `${MCP_TOOL_PREFIX}${t.name}`]));

				let prompt: string;
				let resume = false;
				const continueText = opts.continuePrompt ?? CONTINUE_PROMPT;
				let haveFile = existsSync(path);
				if (haveFile) {
					// TODO(session-store ticket): verify the file against the transcript here
					// (history length/ids match, denial records present) and rebuild on mismatch.
					// Note: convertPiMessages returns sanitizedIds; the verify seam must compare
					// against the sanitized tool_use ids, not pi's raw ones.
					if (plan.results.size) {
						const patched = patchToolResults(path, plan.results);
						dbg(`patched ${patched.length}/${plan.results.size} tool results`);
						if (patched.length < plan.results.size) { rmSync(path, { force: true }); haveFile = false; }
					}
				}
				if (haveFile) {
					resume = true;
					prompt = plan.promptText ?? continueText;
				} else {
					// Missing file: build it from the transcript (real tool_use/tool_result records).
					if (plan.importable.length) {
						const { anthropicMessages } = convertPiMessages(plan.importable, toolNames); // TODO: sanitizedIds
						const session = createSession({ projectPath: opts.sessionDir, sessionId: sid, claudeDir: opts.claudeDir, model: opts.cliModelId?.(model) ?? model.id });
						session.importMessages(anthropicMessages as any);
						session.save();
						resume = true;
						dbg(`built session ${sid} from ${plan.importable.length} messages`);
					}
					prompt = plan.promptText ?? continueText;
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
					...(opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable } : {}),
				};
				q = runQuery({ prompt, options: options2 });
				await consume(q, model, output, stream, () => aborted, dbg);
			} catch (e: any) {
				if (aborted) return fail("aborted", "aborted");
				fail("error", String(e?.message ?? e));
			} finally {
				options?.signal?.removeEventListener("abort", onAbort);
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

type Open = { piIndex: number; kind: "text" | "thinking" | "tool"; json: string };

/** Map SDK messages of ONE query to pi events. Exactly one assistant message per call. */
async function consume(q: AsyncIterable<any>, model: Model<any>, output: AssistantMessage, stream: AssistantMessageEventStream, wasAborted: () => boolean, dbg: (m: string) => void = () => {}) {
	const open = new Map<number, Open>();
	const fallback: any[] = [];
	let started = false, sawToolUse = false, result: any = null, sdkStop: string | undefined;
	const ensureStart = () => { if (!started) { started = true; stream.push({ type: "start", partial: output } as any); } };
	const pi = (name: string) => (name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name);

	const closeBlock = (idx: number) => {
		const o = open.get(idx);
		if (!o) return;
		open.delete(idx);
		const block: any = output.content[o.piIndex];
		if (o.kind === "text") stream.push({ type: "text_end", contentIndex: o.piIndex, content: block.text, partial: output } as any);
		else if (o.kind === "thinking") stream.push({ type: "thinking_end", contentIndex: o.piIndex, content: block.thinking, partial: output } as any);
		else {
			try { block.arguments = o.json ? JSON.parse(o.json) : {}; } catch { dbg(`unparseable tool arguments for ${block.name}: ${o.json.slice(0, 200)}`); block.arguments = {}; }
			stream.push({ type: "toolcall_end", contentIndex: o.piIndex, toolCall: block, partial: output } as any);
		}
	};
	const openBlock = (idx: number, b: any) => {
		ensureStart();
		const piIndex = output.content.length;
		if (b.type === "text") {
			output.content.push({ type: "text", text: "" } as any);
			open.set(idx, { piIndex, kind: "text", json: "" });
			stream.push({ type: "text_start", contentIndex: piIndex, partial: output } as any);
		} else if (b.type === "thinking" || b.type === "redacted_thinking") {
			output.content.push({ type: "thinking", thinking: b.thinking ?? "", thinkingSignature: b.signature ?? b.data ?? "" } as any);
			open.set(idx, { piIndex, kind: "thinking", json: "" });
			stream.push({ type: "thinking_start", contentIndex: piIndex, partial: output } as any);
		} else if (b.type === "tool_use") {
			sawToolUse = true;
			output.content.push({ type: "toolCall", id: b.id, name: pi(b.name), arguments: {} } as any);
			open.set(idx, { piIndex, kind: "tool", json: "" });
			stream.push({ type: "toolcall_start", contentIndex: piIndex, partial: output } as any);
		}
	};

	const handleStreamEvent = (ev: any) => {
		switch (ev.type) {
			case "message_start":
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
		}
	};

	try {
		for await (const m of q) {
			if (m.type === "stream_event" && !m.parent_tool_use_id) handleStreamEvent(m.event);
			else if (m.type === "assistant" && !m.parent_tool_use_id) fallback.push(...(m.message?.content ?? []));
			else if (m.type === "result") result = m;
		}
	} catch (e) {
		// The SDK throws after yielding a max-turns result when the model stopped at a tool_use.
		if (!result && !wasAborted()) throw e;
	}
	if (wasAborted()) throw new Error("aborted");

	// No partial events (e.g. a replayed message): emit the complete assistant blocks.
	if (!output.content.length && fallback.length) {
		fallback.forEach((b, i) => {
			openBlock(i, b);
			const o = open.get(i);
			if (!o) return;
			const block: any = output.content[o.piIndex];
			if (b.type === "text") { block.text = b.text; stream.push({ type: "text_delta", contentIndex: o.piIndex, delta: b.text, partial: output } as any); }
			else if (b.type === "thinking" || b.type === "redacted_thinking") { block.thinking = b.thinking ?? ""; block.thinkingSignature = b.signature ?? b.data ?? ""; }
			else if (b.type === "tool_use") o.json = JSON.stringify(b.input ?? {});
			closeBlock(i);
		});
	}
	for (const idx of [...open.keys()]) closeBlock(idx);
	ensureStart();

	if (result?.usage) updateUsage(output, result.usage, model);
	const maxTurnsWithTool = result?.subtype === "error_max_turns" && sawToolUse;
	if (result && (result.is_error || result.subtype?.startsWith("error")) && !maxTurnsWithTool) {
		const msg = (Array.isArray(result.errors) && result.errors.join("; ")) || result.result || result.subtype;
		throw new Error(String(msg));
	}
	output.stopReason = sdkStop === "max_tokens" ? "length" : sawToolUse ? "toolUse" : "stop";
	stream.push({ type: "done", reason: output.stopReason, message: output } as any);
	stream.end();
}
