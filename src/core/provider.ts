// createClaudeBridgeProvider: the runtime-agnostic pi-ai Provider over the Claude Agent SDK.
// Imports only pi-ai, the Agent SDK, MCP SDK and pure sibling modules — never pi-tui,
// pi-coding-agent, cc-session-io or any pi UI/session state — so a headless host
// (e.g. pi-durable) can load it without dragging the TUI in.

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createProvider } from "@earendil-works/pi-ai/models";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { applyLongContext, buildModels, claudeCodeModelId, type LongContextSettings } from "../models.js";
import { Bridge, type BridgeMode } from "./bridge.js";
import { DEFAULT_IMAGE_BUDGET, type ImageBudget } from "./convert.js";
import { OAUTH_SOURCE, cachedLoginDetector } from "./auth.js";
import { childEnv } from "./env.js";
import { sweepOrphanClaudeProcesses } from "./orphans.js";

export const PROVIDER_ID = "claude-bridge";
const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_TURNS = 50;

export interface ClaudeBridgeProviderOptions {
	/** Provider id; also used as `api` and `baseUrl` of the models. Default "claude-bridge". */
	id?: string;
	name?: string;
	/** Model table. Default: pi-ai's anthropic catalog projected by buildModels (zero cost). */
	models?: ReadonlyArray<Record<string, any> & { id: string; name: string }>;
	/** 1M-context policy; picks `[1m]` CLI ids and context windows. Default: pro plan, no extra usage. */
	longContext?: LongContextSettings;
	/** "park" (default): one query across tool rounds. "replay": rebuild a fresh query every round. */
	mode?: BridgeMode;
	/** Kill a parked query that nobody continued within this many ms (0 disables). Default 10 min. */
	idleTtlMs?: number;
	/** SDK maxTurns for a park-mode query (a replay round is always 1). Default 50. */
	maxTurns?: number;
	/** Working directory for the claude child. Default process.cwd(). */
	cwd?: string | (() => string);
	/** Base environment for the child (API credentials are always stripped). Default process.env. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Auth availability. Default: detect Claude Code's OAuth login (env token, credentials file,
	 * macOS Keychain). Pass false to always report configured, or a function returning the
	 * credential source label (undefined = not logged in).
	 */
	checkAuth?: false | (() => Promise<string | undefined>);
	/** SIGTERM orphaned SDK `claude` children (reparented to pid 1) once at creation. Default true. */
	sweepOrphans?: boolean;
	/** Receives the SDK's rate_limit_event info (plan windows) as it streams. */
	onRateLimit?: (info: unknown) => void;
	pathToClaudeCodeExecutable?: string;
	/**
	 * Caps on images carried in a rebuilt prompt (newest kept, older become "[image omitted: too large]").
	 * Defaults: 20 images, 5 MB each, 16 MiB total; a field left undefined takes its default. The budget bounds
	 * each rebuilt prompt and each steer, not the whole live session: a parked query accumulates images as it
	 * runs, and MCP tool-result images (toolResultToMcpContent) are not capped.
	 */
	imageBudget?: Partial<ImageBudget>;
	/** Extra SDK query options merged last. */
	sdkOptions?: Record<string, unknown>;
	/** Agent SDK query function. Tests inject a mock; never set in production. */
	queryFn?: typeof sdkQuery;
}

export interface ClaudeBridgeProvider extends ReturnType<typeof createProvider> {
	/** Kill all parked/streaming SDK queries (host shutdown). */
	shutdown(): void;
	/** Number of live SDK queries (diagnostics/tests). */
	readonly liveQueries: number;
}

export function createClaudeBridgeProvider(opts: ClaudeBridgeProviderOptions = {}): ClaudeBridgeProvider {
	const id = opts.id ?? PROVIDER_ID;
	// Default policy is the conservative one (bare ids at 200K unless measured-good), so the
	// advertised contextWindow matches what Claude Code actually serves.
	const longContext: LongContextSettings = opts.longContext ?? { plan: "pro", longContextExtraUsage: false };
	const base = opts.models ?? buildModels(getModels("anthropic"));
	const table = applyLongContext([...base], longContext).map((m) => ({
		...m, api: id, provider: id, baseUrl: id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));

	const bridge = new Bridge({
		mode: opts.mode ?? "park",
		idleTtlMs: opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
		maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
		imageBudget: {
			maxImages: opts.imageBudget?.maxImages ?? DEFAULT_IMAGE_BUDGET.maxImages,
			maxTotalBytes: opts.imageBudget?.maxTotalBytes ?? DEFAULT_IMAGE_BUDGET.maxTotalBytes,
			maxImageBytes: Math.min(opts.imageBudget?.maxImageBytes ?? DEFAULT_IMAGE_BUDGET.maxImageBytes, opts.imageBudget?.maxTotalBytes ?? DEFAULT_IMAGE_BUDGET.maxTotalBytes),
		},
		cwd: () => (typeof opts.cwd === "function" ? opts.cwd() : opts.cwd ?? process.cwd()),
		env: () => childEnv(opts.env ?? process.env),
		cliModelId: (m: Model<any>) => claudeCodeModelId(m, longContext),
		queryFn: opts.queryFn ?? sdkQuery,
		onRateLimit: opts.onRateLimit,
		pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
		sdkOptions: opts.sdkOptions,
	});

	if (opts.sweepOrphans !== false) void sweepOrphanClaudeProcesses();

	const detect = opts.checkAuth === false ? async () => "assumed" : opts.checkAuth ?? cachedLoginDetector();
	const authResult = async () => {
		const source = await detect();
		return source ? { auth: { apiKey: "not-used" }, source: source === "assumed" ? OAUTH_SOURCE : `${OAUTH_SOURCE}: ${source}` } : undefined;
	};
	const streamSimple = (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => bridge.stream(model, context, options);

	const provider = createProvider({
		id,
		name: opts.name ?? "Claude (subscription via Agent SDK)",
		// pi-ai requires `auth`; credentials are ambient (the claude child finds the OAuth login itself).
		// check()/resolve() return undefined when no login exists so getAvailable() does not lie.
		auth: {
			apiKey: {
				name: "Claude Code OAuth login (ambient)",
				check: async () => { const r = await authResult(); return r ? { source: r.source } : undefined; },
				resolve: authResult,
			},
		},
		models: table as any,
		api: { stream: streamSimple as any, streamSimple: streamSimple as any },
	} as any);

	Object.assign(provider, { shutdown: () => bridge.shutdown() });
	Object.defineProperty(provider, "liveQueries", { get: () => bridge.liveCount, enumerable: true });
	return provider as ClaudeBridgeProvider;
}
