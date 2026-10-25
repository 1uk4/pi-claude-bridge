// Auth for the subscription transport: the `claude` child process finds Claude Code's
// own OAuth login itself (macOS Keychain item `Claude Code-credentials`,
// ~/.claude/.credentials.json, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
// pi-ai demands an `auth` block even for ambient credentials, so the provider supplies a
// `resolve()` stub — but an unconditional stub makes Models.getAvailable() list the
// provider on machines with no login. detectClaudeLogin() lets check()/resolve() tell the truth.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const OAUTH_SOURCE = "claude-code-oauth";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CACHE_MS = 30_000;

export interface LoginProbes {
	env?: NodeJS.ProcessEnv;
	/** Resolves true when the macOS Keychain holds Claude Code's credentials. Presence only, never the secret. */
	keychain?: () => Promise<boolean>;
	fileExists?: (path: string) => boolean;
	platform?: NodeJS.Platform;
}

function keychainHasLogin(): Promise<boolean> {
	return new Promise((resolve) => {
		// No -w/-g: exit status alone says whether the item exists; the secret is never read.
		execFile("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], { timeout: 5000 }, (err) => resolve(!err));
	});
}

/** Which credential source `claude` would use, or undefined when none is found. */
export async function detectClaudeLogin(probes: LoginProbes = {}): Promise<string | undefined> {
	const env = probes.env ?? process.env;
	if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
	const exists = probes.fileExists ?? existsSync;
	const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	if (exists(join(configDir, ".credentials.json"))) return "~/.claude/.credentials.json";
	if ((probes.platform ?? platform()) === "darwin" && await (probes.keychain ?? keychainHasLogin)()) return "macOS Keychain";
	return undefined;
}

/** Cached detector (a Keychain probe spawns a process; getAvailable() can be called often). */
export function cachedLoginDetector(probes?: LoginProbes, now: () => number = Date.now): () => Promise<string | undefined> {
	let at = 0;
	let value: string | undefined;
	return async () => {
		if (at && now() - at < CACHE_MS) return value;
		value = await detectClaudeLogin(probes);
		at = now();
		return value;
	};
}
