// Orphan `claude` sweep. A parked query is process-memory state: if the host dies
// (SIGKILL, crash) between a tool round's `done{toolUse}` and the next call, the CLI child
// is orphaned (reparented to pid 1) and nothing references it. Called once on provider
// init. Only processes that are BOTH reparented to pid 1 AND carry the Agent SDK's
// stream-json transport flags are touched, so interactive `claude` sessions and live
// children of other hosts are never matched.

import { execFile } from "node:child_process";

export interface ProcRow { pid: number; ppid: number; command: string }

export function listProcesses(): Promise<ProcRow[]> {
	return new Promise((resolve) => {
		execFile("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
			if (err) return resolve([]);
			const rows: ProcRow[] = [];
			for (const line of stdout.split("\n")) {
				const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
				if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
			}
			resolve(rows);
		});
	});
}

export function isOrphanedSdkChild(row: ProcRow): boolean {
	return row.ppid === 1
		&& /claude/i.test(row.command)
		&& /--input-format[ =]stream-json/.test(row.command)
		&& /--output-format[ =]stream-json/.test(row.command);
}

/** SIGTERM orphaned SDK children; returns the pids signalled. Never throws. */
export async function sweepOrphanClaudeProcesses(
	deps: { list?: () => Promise<ProcRow[]>; kill?: (pid: number) => void } = {},
): Promise<number[]> {
	const kill = deps.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
	const killed: number[] = [];
	try {
		for (const row of await (deps.list ?? listProcesses)()) {
			if (row.pid === process.pid || !isOrphanedSdkChild(row)) continue;
			try { kill(row.pid); killed.push(row.pid); } catch { /* already gone */ }
		}
	} catch { /* best effort */ }
	return killed;
}
