// Idle and total timers for one round.
import { type BridgeError, timeoutError } from "./errors.js";

export interface Guard {
	/** Rejects with a retryable timeout error once a timer fires. */
	readonly rejection: Promise<never>;
	readonly fired: BridgeError | undefined;
	/** Call on every SDK message: restarts the idle timer. */
	touch(): void;
	/** Clears both timers. Safe to call any number of times, on every exit path. */
	dispose(): void;
}

export function makeGuard(idleMs: number, roundMs: number, onFire: (kind: "idle" | "round", ms: number) => void): Guard {
	let idle: ReturnType<typeof setTimeout> | undefined, total: ReturnType<typeof setTimeout> | undefined;
	let fired: BridgeError | undefined;
	let disposed = false;
	let reject!: (e: BridgeError) => void;
	const rejection = new Promise<never>((_, rj) => { reject = rj; });
	rejection.catch(() => {}); // a late timeout must never be an unhandled rejection
	const dispose = () => { disposed = true; if (idle) clearTimeout(idle); if (total) clearTimeout(total); idle = total = undefined; };
	const fire = (kind: "idle" | "round", ms: number) => {
		if (fired || disposed) return;
		fired = timeoutError(kind, ms);
		dispose();
		reject(fired);
		onFire(kind, ms);
	};
	const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => fire("idle", idleMs), idleMs); };
	total = setTimeout(() => fire("round", roundMs), roundMs);
	arm();
	return { rejection, get fired() { return fired; }, touch() { if (!fired && !disposed) arm(); }, dispose };
}
