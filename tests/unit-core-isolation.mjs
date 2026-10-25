/**
 * The provider core must stay loadable by a headless host (e.g. pi-durable): no pi UI,
 * coding-agent, tui or cc-session-io imports anywhere in its transitive relative import graph.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN = [/^@earendil-works\/pi-tui/, /^@earendil-works\/pi-coding-agent/, /^cc-session-io/];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src/core/index.ts");

function walk(file, seen = new Map()) {
	if (seen.has(file)) return seen;
	const src = readFileSync(file, "utf8");
	const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
	seen.set(file, specs);
	for (const spec of specs) if (spec.startsWith(".")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")), seen);
	return seen;
}

describe("core isolation", () => {
	it("imports no pi UI/session packages (transitively)", () => {
		const graph = walk(root);
		assert.ok(graph.size > 8, "walked the core graph");
		for (const [file, specs] of graph) {
			for (const spec of specs) assert.ok(!FORBIDDEN.some((f) => f.test(spec)), `${file} imports ${spec}`);
		}
	});
	it("never reaches src/index.ts (the TUI entry)", () => {
		for (const file of walk(root).keys()) assert.ok(!/src\/index\.ts$/.test(file), file);
	});
});
