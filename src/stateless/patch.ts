// Patching of the deny-hook tool_result records in a Claude Code session file.
//
// Each round runs with a PreToolUse hook that denies every tool call, so Claude Code
// writes a denial tool_result for each tool_use it emitted. The next round replaces
// those denials with the real results pi produced, matched by tool_use_id. uuid /
// parentUuid are never touched, so the record chain stays valid.
//
// The write is atomic: the new content goes to a temp file beside the original
// (`<file>.tmp`, any stale one is removed first) and is renamed over it, so a crash
// leaves the original intact. Callers hold the per-session lock (see store.ts).

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export type ResultContent = string | Array<Record<string, unknown>>;
export interface ToolResultPatch { content: ResultContent; isError?: boolean }

/** Replace tool_result blocks whose tool_use_id is in `results`. Returns the ids patched. */
export function patchToolResults(path: string, results: Map<string, ToolResultPatch>, opts: { requireAll?: boolean; beforeRename?: () => void } = {}): string[] {
	const raw = readFileSync(path, "utf8");
	const trailingNewline = raw.endsWith("\n");
	const lines = raw.split("\n").filter(Boolean);
	const patched = new Set<string>();
	const out = lines.map((line) => {
		let rec: any;
		try { rec = JSON.parse(line); } catch { return line; }
		if (rec?.type !== "user" || !Array.isArray(rec.message?.content)) return line;
		let changed = false;
		for (const block of rec.message.content) {
			if (block?.type !== "tool_result" || !results.has(block.tool_use_id)) continue;
			const r = results.get(block.tool_use_id)!;
			block.content = r.content;
			if (r.isError) block.is_error = true; else delete block.is_error;
			if (typeof rec.toolUseResult === "string") rec.toolUseResult = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
			patched.add(block.tool_use_id);
			changed = true;
		}
		return changed ? JSON.stringify(rec) : line;
	});
	if (opts.requireAll && patched.size < results.size) return [...patched]; // nothing written: caller rebuilds
	if (patched.size) {
		const tmp = `${path}.tmp`;
		rmSync(tmp, { force: true });
		writeFileSync(tmp, out.join("\n") + (trailingNewline ? "\n" : ""));
		opts.beforeRename?.();
		renameSync(tmp, path);
	}
	return [...patched];
}
