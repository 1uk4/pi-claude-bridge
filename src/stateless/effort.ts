// pi reasoning level -> Claude Code SDK effort level (same table as the main bridge).
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@earendil-works/pi-ai";

const REASONING_TO_EFFORT: Record<string, EffortLevel> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" };
const VALID = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/** The model's own thinkingLevelMap wins; a null/unknown map entry sends no effort. */
export function effortFor(model: Model<any>, reasoning: string | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapped = (model as any).thinkingLevelMap?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID.has(mapped) ? (mapped as EffortLevel) : undefined;
}
