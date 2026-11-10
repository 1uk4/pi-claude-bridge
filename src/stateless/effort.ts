// pi reasoning level -> Claude Code SDK effort level (same table as the main bridge).
import type { EffortLevel, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@earendil-works/pi-ai";

const REASONING_TO_EFFORT: Record<string, EffortLevel> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" };
const VALID = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/**
 * pi sends no reasoning level when thinking is off; CC then applies its default (thinking on).
 * Disable it for reasoning models, unless the model's thinkingLevelMap marks "off" unsupported (null).
 * Ported from upstream thinkingForReasoning (0b096a8).
 */
export function thinkingFor(model: Model<any>, reasoning: string | undefined): ThinkingConfig | undefined {
	if (reasoning || !model.reasoning || (model as any).thinkingLevelMap?.off === null) return undefined;
	return { type: "disabled" };
}

/** The model's own thinkingLevelMap wins; a null/unknown map entry sends no effort. */
export function effortFor(model: Model<any>, reasoning: string | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapped = (model as any).thinkingLevelMap?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID.has(mapped) ? (mapped as EffortLevel) : undefined;
}
