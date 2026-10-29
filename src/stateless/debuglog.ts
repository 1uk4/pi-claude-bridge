// JSON-lines debug log for the stateless provider. One object per line, `ts` first.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type DebugEvent = { event: string; [k: string]: unknown };

export interface DebugConfig {
	/** true, or a sink that also receives every event. Env CLAUDE_BRIDGE_DEBUG=1 also enables the file. */
	debug?: boolean | ((event: DebugEvent) => void);
	debugLogPath?: string;
}

export function debugLogFile(cfg: DebugConfig): string {
	return cfg.debugLogPath || process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge-stateless.log");
}

/** Returns emit(event | string). Never throws. Strings become {event:"note", msg}. */
export function makeDebug(cfg: DebugConfig): (e: DebugEvent | string) => void {
	return (e) => {
		const ev: DebugEvent = typeof e === "string" ? { event: "note", msg: e } : e;
		try {
			if (typeof cfg.debug === "function") cfg.debug(ev);
			const on = cfg.debug === true;
			const env = process.env.CLAUDE_BRIDGE_DEBUG === "1" || process.env.CLAUDE_BRIDGE_DEBUG === "true";
			if (!on && !env) return;
			const file = debugLogFile(cfg);
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
		} catch { /* logging must never break a round */ }
	};
}
