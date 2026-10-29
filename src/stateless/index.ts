// pi-claude-bridge/stateless: a plain pi-ai provider that runs each round as one
// short-lived Claude Agent SDK query over a resumable session file. See provider.ts.

import { createProvider } from "@earendil-works/pi-ai/models";
import { OAUTH_SOURCE, cachedLoginDetector } from "./auth.js";
import { createStatelessStreams, type StatelessStreamOptions } from "./provider.js";

export { createStatelessStreams, cliSessionId, type StatelessStreamOptions, type QueryFn } from "./provider.js";
export { childEnv, CC_CHILD_ENV } from "./env.js";
export { detectClaudeLogin, OAUTH_SOURCE, type LoginProbes } from "./auth.js";
export { patchToolResults, type ToolResultPatch } from "./patch.js";
export { planRound, CONTINUE_PROMPT } from "./plan.js";

export interface StatelessProviderOptions extends StatelessStreamOptions {
	/** Provider id. Default "claude-stateless". */
	id?: string;
	name?: string;
	/** Model table (pi-ai ProviderModel entries; `api` should match the provider id). */
	models: ReadonlyArray<Record<string, any> & { id: string; name: string }>;
	/** Login detection. false = assume logged in; function = custom. Default: Claude Code login probe. */
	checkAuth?: false | (() => Promise<string | undefined>);
}

export function createStatelessProvider(opts: StatelessProviderOptions) {
	const streams = createStatelessStreams(opts);
	const detect = opts.checkAuth === false ? async () => "assumed" : opts.checkAuth ?? cachedLoginDetector();
	const authResult = async () => {
		const source = await detect();
		return source ? { auth: { apiKey: "not-used" }, source: source === "assumed" ? OAUTH_SOURCE : `${OAUTH_SOURCE}: ${source}` } : undefined;
	};
	const provider = createProvider({
		id: opts.id ?? "claude-stateless",
		name: opts.name ?? "Claude (subscription via Agent SDK, stateless)",
		// pi-ai requires `auth`; credentials are ambient (the claude child finds the OAuth login itself).
		auth: { apiKey: { name: "Claude Code OAuth login (ambient)", check: async () => { const r = await authResult(); return r ? { source: r.source } : undefined; }, resolve: authResult } },
		models: opts.models as any,
		api: { stream: streams.stream as any, streamSimple: streams.streamSimple as any },
	} as any);
	return { provider, forget: streams.forget, dispose: streams.dispose };
}
export { classifyError, roundError, timeoutError, BridgeError, type ErrorClass } from "./errors.js";
export { effortFor } from "./effort.js";
export { makeDebug, type DebugEvent } from "./debuglog.js";
export { makeGuard, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_ROUND_TIMEOUT_MS } from "./provider.js";
