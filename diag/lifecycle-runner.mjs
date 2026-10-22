#!/usr/bin/env node
// Short deterministic lifecycle sequences through the real bridge and real
// Claude Code, each checked by the generic analyzer (diag/analyze-trace.mjs).
//
//   node diag/lifecycle-runner.mjs [--scenario NAME[,NAME]] [--model claude-bridge/claude-haiku-5-5] [--thinking medium] [--turns N] [--out DIR] [--bridge DIR]
//
// --turns adds N extra tool-using turns of history before the step under test
// (noop-rebuild, restart-resume, injected-error), to see whether a loss scales
// with the conversation or is a fixed amount.
//
// --bridge runs another bridge checkout, e.g. a revision from before a fix, to
// check the scenario can tell the difference. A checkout without the cache trace
// is routed through the proxy by ANTHROPIC_BASE_URL and leaves only the proxy's
// evidence, so its trace-based checks fail as unrecorded.
//
// Every scenario runs pi in RPC mode in its own temp project with the bridge in
// raw trace mode, its traffic routed through diag/capture-proxy.mjs, and
// diag/lib/lifecycle-extension.ts for fixed tools and in-process state changes.
// Steps wait on observable events (a tool starting, a stream producing text,
// agent_settled), never on sleeps alone; timeouts only bound failures.
//
// A scenario passes its evidence check only if the state it set out to reach was
// actually reached (e.g. a redaction really went through REUSE); otherwise it is
// reported as not exercised. Findings come from the analyzer, not from rules
// here. Each scenario's Claude Code sessions are deleted once it is analyzed; its
// evidence stays under --out. Paid: each scenario is a few Haiku turns. Must run outside the sandbox.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectDir } from "cc-session-io";
import { FIRST_PARTY_ENV } from "./lib/first-party.mjs";
import { loadTrace, traceRuns } from "./lib/trace-analysis.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const MODEL = flag("model", "claude-bridge/claude-haiku-5-5");
// Explicit: pi's default comes from settings, and production runs at medium.
const THINKING = flag("thinking", "medium");
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "lifecycle-"));
const EXTENSION = join(REPO, "diag/lib/lifecycle-extension.ts");
const BRIDGE = flag("bridge");
const TURNS = Number(flag("turns", 0));
const TIMEOUT = 180_000;
process.env.CLAUDE_BRIDGE_TEST_LOG_DIR ??= join(OUT, "logs");
const { createRpcHarness } = await import("../tests/lib/rpc-harness.mjs");

// --- Harness ---

async function startProxy(dir) {
	const proxy = spawn(process.execPath, [join(REPO, "diag/capture-proxy.mjs"), "--port", "0", "--out", join(dir, "capture"), "--fault-file", join(dir, "fault.json")], { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	proxy.stderr.on("data", (d) => { log += d; });
	const url = await new Promise((resolve, reject) => {
		proxy.stderr.on("data", () => { const m = log.match(/capture proxy on (http:\/\/\S+)/); if (m) resolve(m[1]); });
		proxy.on("exit", (code) => reject(new Error(`capture proxy exited ${code}: ${log}`)));
	});
	return { url, stop: async () => { proxy.kill("SIGTERM"); await once(proxy, "exit"); writeFileSync(join(dir, "proxy.log"), log); } };
}

function scenarioContext(name) {
	const dir = join(OUT, name);
	// The project path rides in Claude Code's environment reminder in the first user
	// message, which makes it this run's nonce: a reused path would let an earlier
	// run's cached conversation stand in for this one's.
	if (existsSync(dir)) throw new Error(`${dir} already exists; use a fresh --out`);
	const cwd = join(dir, "cwd");
	const agentDir = join(dir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// Small keepRecentTokens so /compact has something to discard, as the compaction int tests do.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 50 } }));
	writeFileSync(join(cwd, "notes.txt"), "codeword: teal42\n");
	const controlFile = join(dir, "control.json");
	writeFileSync(controlFile, "{}");
	let instance = 0;
	let proxy;
	const harnesses = [];
	const ctx = {
		name, dir,
		async begin() { proxy = await startProxy(dir); },
		/** A pi process on this scenario's project, session dir and trace. */
		async pi(extraArgs = []) {
			const h = createRpcHarness({
				name: `lc-${name}-${++instance}`,
				args: ["-e", EXTENSION, "--model", MODEL, "--thinking", THINKING, "--session-dir", join(dir, "sessions"), ...extraArgs],
				cwd,
				persistSession: true,
				defaultTimeout: TIMEOUT,
				...(BRIDGE ? { bridgeDir: BRIDGE } : {}),
				env: {
					PI_CODING_AGENT_DIR: agentDir,
					CLAUDE_BRIDGE_TRACE_DIR: join(dir, "trace"),
					CLAUDE_BRIDGE_TRACE_RAW: "1",
					// A --bridge checkout may predate the trace's own first-party env.
					...(BRIDGE ? { ...FIRST_PARTY_ENV, ANTHROPIC_BASE_URL: proxy.url } : { CLAUDE_BRIDGE_TRACE_PROXY: proxy.url }),
					LIFECYCLE_CONTROL: controlFile,
				},
			});
			harnesses.push(h);
			await h.startAndWait();
			return h;
		},
		control(value) { writeFileSync(controlFile, JSON.stringify(value)); },
		openGate() { writeFileSync(join(dir, "gate"), ""); },
		// Whole or not at all: the proxy may read it at any moment.
		armFault(fault) {
			writeFileSync(join(dir, "fault.json.tmp"), JSON.stringify(fault));
			renameSync(join(dir, "fault.json.tmp"), join(dir, "fault.json"));
		},
		/** Stop anything a failed step left running, so no pi or Claude Code process is
		 *  still writing when the scenario's sessions are removed. */
		async end() {
			for (const h of harnesses) if (h.pi()?.exitCode === null) await h.stop();
			await proxy?.stop();
		},
		/** Remove the Claude Code sessions this scenario created: its own project
		 *  directory under ~/.claude/projects, keyed by the scenario's unique cwd (Claude
		 *  Code keys by the real path). Evidence stays in the scenario dir: capture,
		 *  trace, and the trace's copies of session files. */
		deleteSessions() {
			rmSync(getProjectDir(realpathSync(cwd), process.env.CLAUDE_CONFIG_DIR), { recursive: true, force: true });
		},
	};
	return ctx;
}

/** Send a prompt and wait until pi will not continue on its own. */
async function prompt(h, message, extra = {}) {
	const settled = h.waitForEvent("agent_settled", TIMEOUT);
	const data = await h.send({ type: "prompt", message, ...extra }, TIMEOUT);
	if (data?.disposition === "handled") {
		// No run started, so agent_settled will not come: its timeout rejection is expected.
		settled.catch(() => {});
		return data;
	}
	await settled;
	return data;
}

/** Orderly shutdown (stdin closed) so the trace writes its end record. */
async function shutdown(h) {
	const child = h.pi();
	if (child.exitCode === null) {
		child.stdin.end();
		const exited = once(child, "exit");
		const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
		await exited;
		clearTimeout(timer);
	}
	await h.stop();
}

/** --turns extra tool-using turns, each adding a call, a result and a reply. */
async function extraTurns(h) {
	for (let i = 0; i < TURNS; i++) await prompt(h, `Next, look up the key extra${i} with lc_lookup and tell me its value.`);
}

const secret = () => `SECRET-${1000 + Math.floor(Math.random() * 9000)}`;

const thinkingIn = (body) => (body?.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "thinking" || b?.type === "redacted_thinking").length;

/** How one lifecycle tool's result reads in a request: error flag, block shapes,
 *  text size and start, image source and bytes. Null if the request has no result for it. */
function wireResult(body, tool) {
	const messages = body?.messages ?? [];
	const blocks = messages.flatMap((m) => Array.isArray(m.content) ? m.content : []);
	const use = blocks.find((b) => b?.type === "tool_use" && b.name?.endsWith(`__${tool}`));
	const result = use && blocks.find((b) => b?.type === "tool_result" && b.tool_use_id === use.id);
	if (!result) return null;
	const items = typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content ?? [];
	const text = items.filter((b) => b.type === "text").map((b) => b.text).join("\n");
	return {
		message: messages.findIndex((m) => Array.isArray(m.content) && m.content.includes(result)),
		keys: Object.keys(result),
		isError: result.is_error ?? null,
		shape: typeof result.content === "string" ? "string" : items.map((b) => b.type),
		textChars: text.length,
		textStart: text.slice(0, 160),
		// Claude Code's two ways of replacing oversized output with a saved file: its
		// general tool-result form, and its MCP form for results over the token limit.
		persisted: /<persisted-output>|exceeds maximum allowed tokens\. Output has been saved to /.test(text),
		images: items.filter((b) => b.type === "image").map((b) => ({
			source: b.source?.type, mediaType: b.source?.media_type, chars: b.source?.data?.length,
			sha256: createHash("sha256").update(b.source?.data ?? "").digest("hex").slice(0, 16),
		})),
	};
}

// --- Scenarios ---

/** Each scenario: steps drive pi; check(evidence) returns [name, ok, detail] rows
 *  establishing that the intended state was reached. */
const SCENARIOS = {
	"noop-rebuild": {
		contract: "Round-trip preservation across a forced no-op rebuild; snapshot taken before the delete",
		async steps(ctx) {
			const h = await ctx.pi();
			await prompt(h, "Please look up the key alpha with the lc_lookup tool and tell me its value.");
			await extraTurns(h);
			await prompt(h, "Thanks. Now look up the key beta with lc_lookup.");
			ctx.control({ forceRebuild: true });
			await prompt(h, "Great. Just say goodbye.");
			ctx.control({});
			await shutdown(h);
		},
		check({ decisions, events, snapshots }) {
			const snap = events.find((e) => e.type === "snapshot");
			return [
				["decisions clean-start, reuse, rebuild-mark", decisions.map((d) => `${d.path}/${d.reason}`).join(",").match(/^clean-start\/no-priors(,reuse\/[^,]+)+,rebuild\/rebuild-mark$/), decisions.map((d) => `${d.path}/${d.reason}`)],
				["rebuild kept the session id", decisions.at(-1)?.rotation === "preserve-id", decisions.at(-1)?.rotation],
				["snapshot before the delete", snap && snap.seq < events.find((e) => e.type === "rebuild-written")?.seq, snap?.snapshotId],
				["snapshot usable as a resume control", snapshots[0]?.usable, snapshots[0]?.reasons],
			];
		},
	},

	"thinking-rebuild": {
		contract: "Thinking blocks across REUSE and a forced no-op rebuild: does the rebuilt history carry them as CC sent them?",
		async steps(ctx) {
			// Small reasoning questions make Haiku 5.5 think at medium effort; plain requests do not.
			const h = await ctx.pi();
			await prompt(h, "Look up the key alpha with lc_lookup. Then: a farmer has 17 sheep, all but 9 run away, and he buys twice as many as remain. How many does he have? Give the value and the number.");
			await prompt(h, "Look up the key beta with lc_lookup. Then: what is 4837 * 29 - 1966? Give the value and the number.");
			ctx.control({ forceRebuild: true });
			await prompt(h, "Without tools: if a train leaves at 3:40 and the trip takes 2 hours 35 minutes, when does it arrive? Just the time.");
			ctx.control({});
			await shutdown(h);
		},
		check({ decisions, analysis, captureBodies }) {
			const rebuilt = analysis.transitions.find((t) => t.decision?.reason === "rebuild-mark");
			const thinking = (n) => thinkingIn(captureBodies[n]);
			return [
				// The last reply before the rebuild first appears in the rebuilt request itself.
				["the rebuilt request carries earlier thinking blocks (the state under test)", rebuilt && thinking(rebuilt.to.request) > 0, rebuilt && { ancestor: thinking(rebuilt.from.request), rebuilt: thinking(rebuilt.to.request) }],
				["rebuild was a no-op on the rebuild mark", decisions.at(-1)?.reason === "rebuild-mark" && rebuilt?.source.relation === "append", rebuilt?.source],
				// Recorded either way (not a pass condition): did the API drop thinking it was sent?
				["API reported its input changes on the rebuilt request (observation)", true, rebuilt?.apiTransformations ?? "none reported"],
			];
		},
	},

	"hard-content-rebuild": {
		contract: "An error result, an image result, output over CC's persistence threshold and thinking, across a forced no-op rebuild and one more turn",
		async steps(ctx) {
			const h = await ctx.pi();
			await prompt(h, "Call lc_fail, lc_image and lc_dump, all three in parallel in a single message. Then tell me lc_fail's error message, the image's color, and the first line of the dump. Also: a farmer has 17 sheep, all but 9 run away, and he buys twice as many as remain. How many does he have?");
			await prompt(h, "Without tools: what is 4837 * 29 - 1966? Just the number.");
			ctx.control({ forceRebuild: true });
			await prompt(h, "Without tools: if a train leaves at 3:40 and the trip takes 2 hours 35 minutes, when does it arrive? Just the time.");
			ctx.control({});
			await prompt(h, "Thanks. Just say ok.");
			await shutdown(h);
		},
		check({ decisions, events, analysis, captureBodies }) {
			const rebuilt = analysis.transitions.find((t) => t.decision?.reason === "rebuild-mark");
			const after = analysis.transitions.find((t) => rebuilt && t.from.request === rebuilt.to.request);
			// Before: the last request Claude Code built from its own history; rebuilt: the first from the bridge's.
			const views = (tool) => ({
				native: wireResult(captureBodies[rebuilt?.from.request], tool),
				rebuilt: wireResult(captureBodies[rebuilt?.to.request], tool),
				after: wireResult(captureBodies[after?.to.request], tool),
			});
			const [fail, image, dump] = ["lc_fail", "lc_image", "lc_dump"].map(views);
			const snap = events.find((e) => e.type === "snapshot");
			return [
				["decisions clean-start, reuse, rebuild-mark, reuse", decisions.map((d) => `${d.path}/${d.reason}`).join(",").match(/^clean-start\/no-priors(,reuse\/[^,]+)+,rebuild\/rebuild-mark,reuse\/[^,]+$/), decisions.map((d) => `${d.path}/${d.reason}`)],
				["rebuild was a no-op that kept the session id", rebuilt?.source.relation === "append" && rebuilt?.decision?.rotation === "preserve-id", rebuilt && { source: rebuilt.source, rotation: rebuilt.decision?.rotation }],
				["an error tool result reached Claude Code", fail.native?.isError === true, fail],
				["an image tool result reached Claude Code", image.native?.images.length > 0, image],
				["an oversized tool output reached Claude Code", dump.native && (dump.native.persisted || dump.native.textChars > 50_000), dump],
				["the rebuilt request carries earlier thinking blocks", thinkingIn(captureBodies[rebuilt?.to.request]) > 0, rebuilt && { native: thinkingIn(captureBodies[rebuilt.from.request]), rebuilt: thinkingIn(captureBodies[rebuilt.to.request]) }],
				["snapshot before the delete", snap && snap.seq < events.find((e) => e.type === "rebuild-written")?.seq, snap && { id: snap.snapshotId, complete: snap.complete, fileCount: snap.fileCount, bytes: snap.bytes, missingReferences: snap.missingReferences, externalReferences: snap.externalReferences }],
				["API reported its input changes (observation)", true, { rebuilt: rebuilt?.apiTransformations ?? "none reported", after: after?.apiTransformations ?? "none reported" }],
			];
		},
	},

	"abort-continuation": {
		contract: "#199/#200: a run ends with the query parked at a terminating tool; the next run continues it and is aborted",
		async steps(ctx) {
			const h = await ctx.pi();
			await prompt(h, "Please record a checkpoint with the lc_stop tool, note 'start'.");
			const streaming = h.waitForMatch((m) => m.type === "message_update" && m.assistantMessageEvent?.type === "text_delta", "streamed text", TIMEOUT);
			const settled = h.waitForEvent("agent_settled", TIMEOUT);
			await h.send({ type: "prompt", message: "Now write a 400-word story about a lighthouse keeper." });
			await streaming;
			await h.send({ type: "abort" });
			await settled;
			await prompt(h, "Never mind the story. Just say ok.");
			await shutdown(h);
		},
		check({ events, decisions, capture }) {
			const continuation = events.find((e) => e.type === "route" && e.route === "tool-result");
			// Proxy-only evidence, so it also reads on a bridge revision without the trace
			// (whose requests are unrouted); with routing, only the continued query's.
			const cutOff = capture.filter((r) => r.terminal === "client-disconnect" && (!r.route || r.route === continuation?.queryId));
			const runAbort = events.find((e) => e.type === "run-signal-abort" && e.queryId === continuation?.queryId);
			const end = events.find((e) => e.type === "query-end" && e.queryId === continuation?.queryId);
			return [
				["the streaming request was cut off upstream by the abort", cutOff.length >= 1, capture.map((r) => `#${r.n} ${r.terminal}`)],
				["second run continued the parked query", Boolean(continuation), continuation?.queryId],
				["the continuing run's abort reached that query", runAbort && !runAbort.runStreamEnded, runAbort],
				["the query ended aborted", end?.outcome === "aborted", end?.outcome],
				// The parked query never completed, so no mirror was ever recorded for it.
				["next turn rebuilt from pi's history", decisions.at(-1)?.path === "rebuild", decisions.at(-1) && `${decisions.at(-1).path}/${decisions.at(-1).reason}`],
			];
		},
	},

	"steer-parallel": {
		contract: "Parallel tools with a steer while they wait: content, order and ownership across continuations",
		async steps(ctx) {
			const h = await ctx.pi();
			const started = h.waitForEvent("tool_execution_start", TIMEOUT);
			const settled = h.waitForEvent("agent_settled", TIMEOUT);
			await h.send({ type: "prompt", message: "Call the lc_wait tool twice in parallel, with labels 'one' and 'two', in a single message. Then tell me both results." });
			await started;
			await h.send({ type: "prompt", message: "While you wait: please also mention the word PAPAYA in your reply.", streamingBehavior: "steer" });
			ctx.openGate();
			await settled;
			await prompt(h, "Thanks, that's all. Say ok.");
			await shutdown(h);
		},
		check({ events }) {
			const routes = events.filter((e) => e.type === "route" && e.route === "tool-result");
			return [
				["a continuation delivered tool results with a steer", routes.some((r) => r.steer), routes],
				["two parallel results in one delivery", routes.some((r) => r.results.length >= 2), routes.map((r) => r.results.length)],
			];
		},
	},

	"injected-retry": {
		contract: "An injected API rejection at a tool boundary, the retry, and the next turn",
		async steps(ctx) {
			const h = await ctx.pi();
			// Hits the continuation carrying the tool's result, whenever it comes.
			ctx.armFault({ status: 529, count: 1, match: "tool-result", headers: { "x-should-retry": "false" } });
			await prompt(h, "Please look up the key alpha with the lc_lookup tool and tell me its value.");
			ctx.armFault({ count: 0 });
			await prompt(h, "Thanks. Now look up the key beta.");
			await shutdown(h);
		},
		check({ capture, analysis }) {
			const injected = capture.filter((r) => r.injected);
			const retried = analysis.transitions.find((t) => t.to.kind === "tool-result" && t.to.attempts?.some((a) => a.n === injected[0]?.n));
			return [
				["one injected rejection, at the tool boundary", injected.length === 1 && Boolean(retried), injected.map((r) => r.n)],
				["Claude Code retried it", retried?.to.attempts.length > 1, retried?.to.attempts],
			];
		},
	},

	"injected-error": {
		contract: "A non-retryable injected API error at a tool boundary fails the turn; the next turn recovers",
		async steps(ctx) {
			const h = await ctx.pi();
			await prompt(h, "Please look up the key alpha with the lc_lookup tool and tell me its value.");
			await extraTurns(h);
			ctx.armFault({ status: 400, count: 1, match: "tool-result", body: { type: "error", error: { type: "invalid_request_error", message: "Injected by capture-proxy" } } });
			await prompt(h, "Thanks. Now look up the key beta.");
			ctx.armFault({ count: 0 });
			await prompt(h, "Let's try again: look up the key gamma.");
			await shutdown(h);
		},
		check({ capture, events, decisions, analysis }) {
			const injected = capture.filter((r) => r.injected);
			const atBoundary = analysis.transitions.some((t) => t.to.kind === "tool-result" && (t.to.request === injected[0]?.n || t.to.attempts?.some((a) => a.n === injected[0]?.n)));
			const failed = events.find((e) => e.type === "query-end" && e.outcome === "error") ?? events.find((e) => e.type === "query-result" && e.isError);
			return [
				["one injected error, at the tool boundary", injected.length === 1 && atBoundary, injected.map((r) => r.n)],
				["the query reported the failure", Boolean(failed), failed],
				["recovery turn rebuilt without a mirror", decisions.at(-1)?.reason === "no-mirror", decisions.map((d) => `${d.path}/${d.reason}`)],
			];
		},
	},

	"restart-resume": {
		contract: "Several turns, a pi restart, and a resumed turn: lost mirror vs available native history",
		async steps(ctx) {
			let h = await ctx.pi();
			await prompt(h, "Please look up the key alpha with the lc_lookup tool and tell me its value.");
			await extraTurns(h);
			await prompt(h, "Thanks. Now look up the key beta.");
			await shutdown(h);
			h = await ctx.pi(["--continue"]);
			await prompt(h, "Great. Now look up the key gamma.");
			await shutdown(h);
		},
		check({ runs, decisions }) {
			return [
				["two pi processes traced", runs === 2, runs],
				["resumed turn rebuilt with no mirror", decisions.at(-1)?.reason === "no-mirror", decisions.at(-1)],
			];
		},
	},

	"redaction": {
		contract: "A same-length in-process redaction without a rebuild mark must reach Claude Code",
		async steps(ctx) {
			const h = await ctx.pi();
			await prompt(h, `I'm working on ticket ${secret()}. Please look up the key alpha with the lc_lookup tool.`);
			await prompt(h, "Thanks. Now look up the key beta.");
			ctx.control({ redact: true });
			await prompt(h, "Great, that's all for now. Just say goodbye.");
			ctx.control({});
			await shutdown(h);
		},
		check({ decisions, analysis }) {
			const last = analysis.transitions.at(-1);
			return [
				["redacted turn took REUSE (the state under test)", decisions.at(-1)?.path === "reuse", decisions.at(-1)],
				["source history changed at the redacted message", last?.source.relation === "edit", last?.source],
			];
		},
	},

	"tree-back": {
		contract: "Tree navigation back to the first turn, then continuing: branch ancestry and preserved prefix",
		async steps(ctx) {
			const h = await ctx.pi();
			await prompt(h, "Please look up the key alpha with the lc_lookup tool and tell me its value.");
			await prompt(h, "Thanks. Now look up the key beta.");
			await prompt(h, "/lc-tree-back");
			await prompt(h, "Now look up the key gamma instead.");
			await shutdown(h);
		},
		check({ decisions, analysis }) {
			const rebuilt = analysis.transitions.find((t) => t.decision?.reason === "rebuild-mark");
			// The second turn's first request: an ancestor before it is from the first turn.
			const secondTurn = analysis.transitions.find((t) => t.to.kind === "fresh");
			return [
				["turn after navigation rebuilt on the rebuild mark", decisions.at(-1)?.reason === "rebuild-mark", decisions.at(-1)],
				["its ancestor is the first turn, so preservation was checked", rebuilt && rebuilt !== secondTurn && rebuilt.from.request < secondTurn?.to.request && rebuilt.preservation.status !== "not-checked", rebuilt && { from: rebuilt.from, secondTurn: secondTurn?.to.request }],
			];
		},
	},

	"compact": {
		contract: "Compaction, then continuing: a necessary change must not conceal unrelated loss",
		async steps(ctx) {
			const h = await ctx.pi();
			await prompt(h, "Please look up the key alpha with the lc_lookup tool and tell me its value.");
			await prompt(h, "Thanks. Now look up the key beta.");
			const result = await h.send({ type: "compact" }, TIMEOUT);
			if (!result?.summary) throw new Error(`compact returned no summary: ${JSON.stringify(result)}`);
			await prompt(h, "Great. Now look up the key gamma.");
			await shutdown(h);
		},
		check({ decisions, events }) {
			return [
				["compaction summary ran as an isolated side query", events.some((e) => e.type === "query-start" && e.kind === "isolated-summary"), null],
				["turn after compaction rebuilt on the rebuild mark", decisions.at(-1)?.reason === "rebuild-mark", decisions.at(-1)],
			];
		},
	},
};

// --- Run ---

const selected = (flag("scenario")?.split(",") ?? Object.keys(SCENARIOS));
for (const name of selected) if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}; have ${Object.keys(SCENARIOS).join(", ")}`);

const results = [];
for (const name of selected) {
	const scenario = SCENARIOS[name];
	const ctx = scenarioContext(name);
	console.log(`\n=== ${name}: ${scenario.contract}`);
	let error = null;
	try {
		await ctx.begin();
		await scenario.steps(ctx);
	} catch (e) {
		error = e.stack ?? String(e);
	} finally {
		await ctx.end();
	}
	const analysisFile = join(ctx.dir, "analysis.json");
	const traceDir = join(ctx.dir, "trace");
	const traced = existsSync(traceDir);
	const analyzed = existsSync(join(ctx.dir, "capture", "index.jsonl")) && spawnSync(process.execPath, [join(REPO, "diag/analyze-trace.mjs"), "--capture", join(ctx.dir, "capture"), ...(traced ? ["--trace", traceDir] : []), "--out", analysisFile], { encoding: "utf8" });
	if (analyzed) process.stdout.write(analyzed.stdout + analyzed.stderr);
	let checks = [];
	if (analyzed?.status === 0) {
		const analysis = JSON.parse(readFileSync(analysisFile, "utf8"));
		const runDirs = traced ? traceRuns(traceDir) : [];
		const events = runDirs.flatMap((d) => loadTrace(d).events);
		const evidence = {
			analysis,
			events,
			runs: runDirs.length,
			decisions: events.filter((e) => e.type === "decision"),
			snapshots: (analysis.snapshots ?? []).filter((s) => s.snapshotId),
			capture: readFileSync(join(ctx.dir, "capture", "index.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
			captureBodies: new Proxy({}, { get: (_, n) => {
				const file = join(ctx.dir, "capture", `req-${String(n).padStart(4, "0")}.json`);
				return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
			} }),
		};
		checks = scenario.check(evidence).map(([check, ok, detail]) => ({ check, ok: Boolean(ok), detail }));
	}
	// Missing or incomplete evidence fails the scenario even if every check passed.
	const gaps = analyzed?.status === 0 ? JSON.parse(readFileSync(analysisFile, "utf8")).gaps : ["no analysis"];
	for (const gap of gaps) checks.push({ check: `evidence gap: ${gap}`, ok: false, detail: null });
	const exercised = !error && analyzed?.status === 0 && checks.every((c) => c.ok);
	// The analyzer's verdict per transition, so the report carries the evidence, not just the checks.
	const transitions = analyzed?.status === 0 ? JSON.parse(readFileSync(analysisFile, "utf8")).transitions.map((t) => ({
		from: t.from.request, to: t.to.request, kind: t.to.kind, decision: t.decision && `${t.decision.path}/${t.decision.reason}`, source: t.source.relation,
		preservation: t.preservation.status, breaksAt: t.preservation.firstChange?.label ?? null, propagation: t.propagation.status,
		cache: t.cache.status, ancestorCached: t.cache.ancestorCached ?? null, cacheRead: t.cache.cacheRead ?? null, validity: t.validity,
	})) : [];
	results.push({ name, contract: scenario.contract, exercised, error, checks, transitions, dir: ctx.dir });
	ctx.deleteSessions();
	for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.check}${c.ok ? "" : `: ${JSON.stringify(c.detail)}`}`);
	if (error) console.log(`  ERROR ${error.split("\n")[0]}`);
	console.log(`  ${exercised ? "EXERCISED" : "NOT EXERCISED"} -> ${ctx.dir}`);
}

writeFileSync(join(OUT, "report.json"), JSON.stringify({ model: MODEL, thinking: THINKING, turns: TURNS, results }, null, 1));
console.log(`\n${results.filter((r) => r.exercised).length}/${results.length} scenarios exercised; report: ${join(OUT, "report.json")}`);
process.exit(results.every((r) => r.exercised) ? 0 : 1);
