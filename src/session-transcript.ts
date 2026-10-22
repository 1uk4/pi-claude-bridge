// CC's loader recovers parallel siblings by API message id and tool-use id,
// not just parentUuid (2.1.308: bDt -> Zuo). Keep the physical prefix, including
// siblings, snapshots and attachments; bridge changes always mint a fresh file.
import { getSessionPath, parseJsonlFile, type JsonlRecord, type Session } from "cc-session-io";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateRecording, type Recording, type SessionState } from "./session-sync.js";

const AUDIT = new Set(["api-request", "api-request-shape", "api-request-blob"]);
type RecordEntry = JsonlRecord & { uuid?: string; parentUuid?: string | null; attachment?: { type: string; source_uuid?: string } };
const chainEntry = (record: RecordEntry): boolean => ["user", "assistant", "attachment", "system"].includes(record.type) && typeof record.uuid === "string" && (typeof record.parentUuid === "string" || record.parentUuid === null);

export function readTranscript(state: Pick<SessionState, "ccSessionId" | "cwd">): RecordEntry[] {
	return parseJsonlFile(getSessionPath(state.ccSessionId, state.cwd, process.env.CLAUDE_CONFIG_DIR)).filter((r) => !AUDIT.has(r.type)) as RecordEntry[];
}

function boundaryIndex(records: readonly RecordEntry[], uuid: string | null): number {
	if (!uuid) throw new Error("Cannot resolve a null or empty session boundary");
	const index = records.findIndex((r) => r.uuid === uuid || (r.type === "attachment" && r.attachment?.type === "queued_command" && r.attachment.source_uuid === uuid));
	if (index < 0) throw new Error(`Session boundary ${uuid} is absent from the transcript`);
	return index;
}

export function resolveCut(records: readonly RecordEntry[], uuid: string | null): { uuid: string; index: number } {
	const index = boundaryIndex(records, uuid);
	const byUuid = new Map(records.filter(chainEntry).map((r) => [r.uuid!, r]));
	const path = new Set<string>();
	let leaf = [...records].reverse().find(chainEntry);
	while (leaf?.uuid) {
		if (path.has(leaf.uuid)) throw new Error(`Cycle in session parent chain at ${leaf.uuid}`);
		path.add(leaf.uuid);
		leaf = leaf.parentUuid ? byUuid.get(leaf.parentUuid) : undefined;
	}
	let resolved = records[index].uuid!;
	if (!path.has(resolved)) throw new Error(`Cut boundary ${resolved} is not on the primary parent chain`);
	let end = index;
	for (let i = index + 1; i < records.length; i++) {
		const record = records[i];
		if (record.type === "user" || record.type === "assistant" || record.attachment?.type === "queued_command") break;
		if (chainEntry(record) && path.has(record.uuid!) && record.parentUuid === resolved) {
			resolved = record.uuid!;
			end = i;
		}
	}
	return { uuid: resolved, index: end };
}

/** Live result/replay order can differ from disk order. Retain all anchors
 * of the logical prefix, not just the last slot's own UUID. */
export function resolveRecordingCut(records: readonly RecordEntry[], recorded: Recording, count: number): { uuid: string; index: number } {
	validateRecording(recorded);
	if (!count || count > recorded.digests.length || !recorded.cuttable[count - 1]) throw new Error(`Invalid session cut count ${count}`);
	const retained = recorded.uuids.slice(0, count).filter((uuid): uuid is string => uuid !== null);
	const index = Math.max(...retained.map((uuid) => boundaryIndex(records, uuid)));
	const cut = resolveCut(records, records[index].uuid!);
	for (const uuid of recorded.uuids.slice(count)) {
		if (uuid !== null && boundaryIndex(records, uuid) <= cut.index) throw new Error(`Session cut includes later pi content at ${uuid}`);
	}
	return cut;
}

/** The suffix was emitted independently, so link its first root to the kept
 * boundary. Every other field, including sibling parents, stays unchanged. */
export function savePrefixSession(session: Session, prefix: readonly JsonlRecord[], parentUuid: string): number {
	const kept = prefix.map((record) => ({ ...record, sessionId: session.sessionId }));
	const suffix = session.records.map((record, index) => index === 0 ? { ...record, parentUuid } : record);
	mkdirSync(dirname(session.jsonlPath), { recursive: true });
	writeFileSync(session.jsonlPath, [...kept, ...suffix].map((record) => JSON.stringify(record) + "\n").join(""), { flag: "wx" });
	return kept.length + suffix.length;
}
