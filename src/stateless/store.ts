// Session-file store helpers: verify a file against pi's transcript, per-session
// lock, and the idle sweep. Nothing here knows about the caller.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** One logical API message: consecutive same-role records are merged (Claude Code writes one record per block). */
export interface Logical { role: string; toolUseIds: string[]; toolResultIds: string[] }

function pushLogical(out: Logical[], role: string, content: unknown): void {
	let cur = out[out.length - 1];
	if (!cur || cur.role !== role) { cur = { role, toolUseIds: [], toolResultIds: [] }; out.push(cur); }
	if (!Array.isArray(content)) return;
	for (const b of content as any[]) {
		if (b?.type === "tool_use" && typeof b.id === "string") cur.toolUseIds.push(b.id);
		else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") cur.toolResultIds.push(b.tool_use_id);
	}
}

export function logicalFromMessages(messages: Array<{ role: string; content: unknown }>, mapId: (id: string) => string = (x) => x): Logical[] {
	const out: Logical[] = [];
	for (const m of messages) pushLogical(out, m.role, m.content);
	for (const l of out) { l.toolUseIds = l.toolUseIds.map(mapId); l.toolResultIds = l.toolResultIds.map(mapId); }
	return out;
}

export function logicalFromFile(path: string): Logical[] {
	const out: Logical[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		let rec: any;
		try { rec = JSON.parse(line); } catch { throw new Error("unparseable record"); }
		if ((rec?.type !== "user" && rec?.type !== "assistant") || rec.isSidechain || !rec.message?.role) continue;
		// Not conversation: meta user records, synthetic / API-error assistant records, and
		// assistant records with no text or tool_use (thinking-only or empty leftovers of an
		// aborted turn). The transcript side drops those too (convert.ts, aborted turns).
		if (rec.isMeta || rec.isApiErrorMessage || rec.message.model === "<synthetic>") continue;
		if (rec.type === "assistant" && !(Array.isArray(rec.message.content) && rec.message.content.some((b: any) => b?.type === "text" && b.text || b?.type === "tool_use"))) continue;
		pushLogical(out, rec.message.role, rec.message.content);
	}
	return out;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

/**
 * The verify rule. Returns undefined when the file matches, else the reason.
 *  1. file has the same number of logical messages as the transcript (same roles in order);
 *  2. every logical message has the same tool_use ids and tool_result ids in both (non-conversation
 *     records in the file are skipped, see logicalFromFile);
 *  3. when the transcript ends in tool results: their ids equal those tool_use ids, and the
 *     file's trailing user message already holds a tool_result (denial) for each of them.
 */
export function verifyAgainst(path: string, expected: Logical[], resultIds: string[]): string | undefined {
	let file: Logical[];
	try { file = logicalFromFile(path); } catch (e: any) { return `file unreadable: ${e?.message ?? e}`; }
	if (file.length !== expected.length) return `message count ${file.length} != transcript ${expected.length}`;
	for (let i = 0; i < file.length; i++) {
		if (file[i].role !== expected[i].role) return `role mismatch at message ${i}`;
		if (!sameSet(file[i].toolUseIds, expected[i].toolUseIds)) return `tool_use ids differ at message ${i}`;
		if (!sameSet(file[i].toolResultIds, expected[i].toolResultIds)) return `tool_result ids differ at message ${i}`;
	}
	const lastA = (l: Logical[]) => { for (let i = l.length - 1; i >= 0; i--) if (l[i].role === "assistant") return i; return -1; };
	const fi = lastA(file), ei = lastA(expected);
	if (fi !== ei) return "last assistant position differs";
	if (fi >= 0 && !sameSet(file[fi].toolUseIds, expected[ei].toolUseIds)) return `tool_use ids differ (file: ${file[fi].toolUseIds.join(",")}; transcript: ${expected[ei].toolUseIds.join(",")})`;
	if (resultIds.length) {
		if (fi < 0) return "results without an assistant message";
		if (!sameSet(resultIds, file[fi].toolUseIds)) return "transcript results do not match the file's last tool_use ids";
		const tail = file[fi + 1];
		if (!tail || tail.role !== "user" || !resultIds.every((id) => tail.toolResultIds.includes(id))) return "denial records missing after the last assistant message";
	}
	return undefined;
}

export const tempFor = (path: string) => `${path}.tmp`;

/** Remove a session file and anything beside it (temp file, per-session folder). */
export function removeSessionFiles(path: string): void {
	if (!path.endsWith(".jsonl")) return;
	rmSync(path, { force: true });
	rmSync(tempFor(path), { force: true });
	rmSync(path.replace(/\.jsonl$/, ""), { recursive: true, force: true });
}

export interface LockHandle {
	/** Resolves when this holder owns the slot. */
	acquired: Promise<void>;
	/** Give the slot up: releases it now if held, or as soon as it is granted if still waiting. Idempotent. */
	cancel(): void;
}

/**
 * Per-session lock: a promise chain keyed by session id. IN-PROCESS ONLY: two processes
 * sharing one session folder are not protected from each other.
 */
export function createLocks() {
	const tails = new Map<string, Promise<void>>();
	return (key: string): LockHandle => {
		const prev = tails.get(key) ?? Promise.resolve();
		let done!: () => void;
		const mine = new Promise<void>((r) => { done = r; });
		const tail = prev.then(() => mine);
		tails.set(key, tail);
		let finished = false;
		const cancel = () => {
			if (finished) return;
			finished = true;
			done();
			// Clear the slot only when nobody queued behind us.
			void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
		};
		return { acquired: prev, cancel };
	};
}

/** Delete session files (and stale temp files) untouched for `ttlMs`. Returns how many sessions went. */
export function sweepIdle(dir: string, ttlMs: number, now: number): number {
	if (!(ttlMs > 0) || !existsSync(dir)) return 0;
	let n = 0;
	for (const name of readdirSync(dir)) {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl(\.tmp)?$/i.test(name)) continue;
		const p = join(dir, name);
		try {
			if (now - statSync(p).mtimeMs <= ttlMs) continue;
			if (name.endsWith(".tmp")) rmSync(p, { force: true });
			else { removeSessionFiles(p); n++; }
		} catch { /* raced with another delete */ }
	}
	return n;
}