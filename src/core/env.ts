// Environment hygiene for every Claude Code subprocess the bridge spawns.
// Runtime-agnostic: no pi UI/session imports (see core/index.ts).

// Applied to every Claude Code subprocess the bridge spawns — provider, AskClaude
// and the compact summary. One place, so a guard is added once rather than three
// times, and so a missing one is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
// - CLAUDE_CODE_ELEGANT_MEADOW=0: stop CC (2.1.308+) logging every API request
//   into its session file (`api-request`, `api-request-shape`, `api-request-blob`
//   records). CC never reads them back to build a request; they only make the
//   file about a third larger.
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ELEGANT_MEADOW: "0",
} as const;

/**
 * Child env for the provider core: the parent env minus API credentials, plus
 * CC_CHILD_ENV. Claude Code prefers ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN over
 * its OAuth login, so leaving them in would silently bill the metered key instead
 * of the subscription. Stripped even when the parent has them (VPS wolves).
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = base;
	return { ...rest, ...CC_CHILD_ENV, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}
