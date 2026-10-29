// JSON-lines debug log for the stateless provider. One object per line, `ts` first.
// Strings are redacted (tokens) and truncated; the file is 0600 and rotated once at ~10 MB.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type DebugEvent = { event: string; [k: string]: unknown };

export interface DebugConfig {
	/** true, or a sink that also receives every event. Env CLAUDE_BRIDGE_DEBUG=1 also enables the file. */
	debug?: boolean | ((event: DebugEvent) => void);
	debugLogPath?: string;
}

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const MAX_FIELD_CHARS = 2048;

export function debugLogFile(cfg: DebugConfig): string {
	return cfg.debugLogPath || process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge-stateless.log");
}

/** Remove bearer tokens, API keys and OAuth tokens from a log string, and cap its length. */
export function redact(s: string): string {
	let out = s
		.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [redacted]")
		.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]")
		.replace(/("?(?:access|refresh|id)_?token"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]")
		.replace(/(oauth[\w-]*(?:token)?\s*[:=]\s*)\S+/gi, "$1[redacted]");
	if (out.length > MAX_FIELD_CHARS) out = out.slice(0, MAX_FIELD_CHARS) + `…[+${out.length - MAX_FIELD_CHARS} chars]`;
	return out;
}

const madeDirs = new Set<string>();

/** Returns emit(event | string). Never throws. Strings become {event:"note", msg}. */
export function makeDebug(cfg: DebugConfig): (e: DebugEvent | string) => void {
	return (e) => {
		const raw: DebugEvent = typeof e === "string" ? { event: "note", msg: e } : e;
		const ev: DebugEvent = { event: raw.event };
		for (const [k, v] of Object.entries(raw)) ev[k] = typeof v === "string" ? redact(v) : v;
		// The sink and the file are independent: a throwing sink must not stop the file write.
		if (typeof cfg.debug === "function") { try { cfg.debug(ev); } catch { /* sink failed */ } }
		try {
			const env = process.env.CLAUDE_BRIDGE_DEBUG === "1" || process.env.CLAUDE_BRIDGE_DEBUG === "true";
			if (cfg.debug !== true && !env) return;
			const file = debugLogFile(cfg);
			const dir = dirname(file);
			if (!madeDirs.has(dir)) { mkdirSync(dir, { recursive: true }); madeDirs.add(dir); }
			try { if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + ".1"); } catch { /* no file yet */ }
			appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n", { mode: 0o600 });
		} catch { /* logging must never break a round */ }
	};
}
