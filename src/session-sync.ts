// Content coverage shared by imports and live queries. A null boundary is only
// an intentional import omission, never an unacknowledged live message.
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { repairWithOrigin, type Session, type ContentBlock, type UserContentBlock } from "cc-session-io";
import { convertPiMessages } from "./convert.js";
import { digestMessage, digestMessages } from "./message-digests.js";
import { placeCarriedAttachments, type CarriedAttachment } from "./attachments.js";

export interface Recording {
	digests: string[];
	uuids: (string | null)[];
	cuttable: boolean[];
}

export interface SessionState extends Recording {
	ccSessionId: string;
	cwd: string;
	model: string;
	piSessionId?: string;
	dirtyTail: boolean;
}

export function validateRecording(recorded: Recording): void {
	if (!Array.isArray(recorded.digests) || !Array.isArray(recorded.uuids) || !Array.isArray(recorded.cuttable)
		|| recorded.digests.length !== recorded.uuids.length || recorded.digests.length !== recorded.cuttable.length) {
		throw new Error("Session recording arrays must be present and aligned");
	}
	for (let i = 0; i < recorded.digests.length; i++) {
		const uuid = recorded.uuids[i];
		if (typeof recorded.digests[i] !== "string" || typeof recorded.cuttable[i] !== "boolean"
			|| (uuid !== null && (typeof uuid !== "string" || !uuid.length)) || (uuid === null && recorded.cuttable[i])) {
			throw new Error(`Invalid session recording slot ${i}`);
		}
	}
}

export function copyRecording(recorded: Recording = { digests: [], uuids: [], cuttable: [] }): Recording {
	validateRecording(recorded);
	return { digests: [...recorded.digests], uuids: [...recorded.uuids], cuttable: [...recorded.cuttable] };
}

export function compareHistory(priors: string[], recorded: Recording): { commonPrefix: number; cutCount: number; equal: boolean } {
	validateRecording(recorded);
	let commonPrefix = 0;
	while (commonPrefix < priors.length && priors[commonPrefix] === recorded.digests[commonPrefix]) commonPrefix++;
	let cutCount = commonPrefix;
	while (cutCount && !recorded.cuttable[cutCount - 1]) cutCount--;
	return { commonPrefix, cutCount, equal: commonPrefix === priors.length && commonPrefix === recorded.digests.length };
}

function updatePendingTools(pending: Set<string>, message: PiMessage): void {
	if (message.role === "assistant" && message.content.length) {
		pending.clear();
		for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
	} else if (message.role === "toolResult") pending.delete(message.toolCallId);
}

/** Emit the repaired messages ourselves: importMessages hides the write mapping
 * and can emit two records for a mixed user message. Track the actual writes. */
export function importHistory(session: Session, messages: PiMessage[], names?: Map<string, string>, carried: readonly CarriedAttachment[] = []): Recording {
	const converted = convertPiMessages(messages, names);
	const repaired = repairWithOrigin(converted.anthropicMessages);
	const placed = placeCarriedAttachments(carried, repaired.messages);
	const writes: { uuid: string; sources: number[]; pending: number }[] = [];
	const direct = new Set<number>();
	const pending = new Set<string>();
	let previousSources: number[] = [];
	const emit = (uuid: string, sources: number[]) => writes.push({ uuid, sources, pending: pending.size });
	for (const [i, message] of repaired.messages.entries()) {
		const origin = repaired.origin[i];
		const sources = origin === null ? previousSources : converted.origins[origin].filter((index) => {
			const pi = messages[index];
			return pi.role !== "toolResult" || (Array.isArray(message.content) && message.content.some((b) => b.type === "tool_result" && b.tool_use_id === converted.sanitizedIds.get(pi.toolCallId)));
		});
		if (origin !== null) sources.forEach((index) => direct.add(index));
		if (message.role === "assistant") {
			const blocks: ContentBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
			for (const block of blocks) if (block.type === "tool_use") pending.add(block.id);
			emit(session.addAssistantMessage(blocks), sources);
		} else if (typeof message.content === "string") {
			emit(session.addUserMessage(message.content), sources);
		} else {
			const results = message.content.filter((b) => b.type === "tool_result");
			const rest = message.content.filter((b) => b.type !== "tool_result") as UserContentBlock[];
			if (results.length) {
				for (const block of results) pending.delete(block.tool_use_id);
				emit(session.addToolResults(results.map((b) => ({ toolUseId: b.tool_use_id, content: b.content, isError: b.is_error }))), sources);
			}
			if (rest.length) emit(session.addUserMessage(rest), sources);
		}
		for (const attachment of placed.attachments.filter((a) => a.afterIndex === i)) emit(session.addAttachment(attachment.attachment), sources);
		previousSources = sources;
	}
	const recorded: Recording = { digests: digestMessages(messages), uuids: [], cuttable: [] };
	let boundary = -1;
	// Repair closes CC's batches with synthetic results, but only a real pi
	// result closes the logical prefix: a later suffix must retain its call.
	const piPending = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		updatePendingTools(piPending, messages[i]);
		for (let j = 0; j < writes.length; j++) if (writes[j].sources.includes(i)) boundary = Math.max(boundary, j);
		const real = direct.has(i) && boundary >= 0;
		recorded.uuids.push(real ? writes[boundary].uuid : null);
		recorded.cuttable.push(real && piPending.size === 0 && writes[boundary].pending === 0 && !writes.slice(0, boundary + 1).some((w) => w.sources.some((index) => index > i)));
	}
	validateRecording(recorded);
	return recorded;
}

interface LiveSlot { digest: string; uuid?: string; toolCalls: string[]; resultId?: string; assistant?: boolean; nonCuttable?: boolean; resetTools?: boolean }

/** Pending slots keep their pi positions even when acknowledgements arrive out
 * of order. Only the contiguous acknowledged prefix is exposed as recorded. */
export class LiveRecording {
	readonly recorded: Recording;
	private slots = new Map<number, LiveSlot>();
	private steers = new Map<string, { indexes: number[]; unsafe: boolean; steering: boolean }>();
	private progress = 0;
	get hasProgress(): boolean { return this.progress > 0; }
	get hasGaps(): boolean { return this.nextIndex > this.recorded.digests.length; }
	gap(): void { this.nextIndex++; }
	/** A later-turn steer follows output pi merges into its next assistant.
	 * Cutting at that steer would keep the unrepresented earlier output twice. */
	assistantObserved(): void {
		for (const steer of this.steers.values()) if (steer.steering) steer.unsafe = true;
	}
	private resultUuids = new Map<string, string>();
	private outstanding = new Set<string>();
	private nextIndex: number;
	private previousUuid: string | undefined;
	constructor(recorded?: Recording, messages: PiMessage[] = []) {
		this.recorded = copyRecording(recorded);
		this.nextIndex = this.recorded.digests.length;
		for (const message of messages.slice(0, this.nextIndex)) updatePendingTools(this.outstanding, message);
	}
	users(messages: PiMessage[], start: number, uuid: string, acknowledged: boolean, steering = !acknowledged): void {
		const indexes: number[] = [];
		for (let i = start; i < messages.length; i++) {
			if (messages[i].role !== "user") continue;
			this.slots.set(i, { digest: digestMessage(messages[i]), ...(acknowledged ? { uuid } : {}), toolCalls: [] });
			indexes.push(i);
		}
		this.nextIndex = Math.max(this.nextIndex, messages.length);
		if (!acknowledged) this.steers.set(uuid, { indexes, unsafe: false, steering });
		this.flush();
	}
	acknowledge(uuid: string): void {
		const steer = this.steers.get(uuid);
		for (const i of steer?.indexes ?? []) {
			const slot = this.slots.get(i)!;
			slot.uuid = uuid;
			slot.nonCuttable = steer!.unsafe;
		}
		this.steers.delete(uuid);
		this.flush();
	}
	assistant(digest: string, toolCalls: string[], uuid?: string, resetTools = true): number {
		const index = this.nextIndex++;
		this.slots.set(index, { digest, uuid, toolCalls, assistant: true, resetTools });
		this.flush();
		return index;
	}
	completeAssistant(index: number, uuid: string): void {
		const slot = this.slots.get(index);
		if (slot) slot.uuid = uuid;
		this.flush();
	}
	results(messages: PiMessage[]): void {
		for (let i = this.recorded.digests.length; i < messages.length; i++) {
			const message = messages[i];
			if (message.role !== "toolResult" || this.slots.has(i)) continue;
			this.slots.set(i, { digest: digestMessage(message), uuid: this.resultUuids.get(message.toolCallId), toolCalls: [], resultId: message.toolCallId });
		}
		this.nextIndex = Math.max(this.nextIndex, messages.length);
		this.flush();
	}
	result(id: string, uuid: string): void {
		this.resultUuids.set(id, uuid);
		for (const slot of this.slots.values()) if (slot.resultId === id) slot.uuid = uuid;
		this.flush();
	}
	private flush(): void {
		while (true) {
			const i = this.recorded.digests.length;
			const slot = this.slots.get(i);
			if (!slot?.uuid) break;
			if (slot.resetTools) this.outstanding.clear();
			for (const id of slot.toolCalls) this.outstanding.add(id);
			if (slot.resultId) this.outstanding.delete(slot.resultId);
			// Store each live slot's own anchor. Stream acknowledgement order is
			// not physical file order; cut resolution derives the group boundary
			// from all retained anchors, including steer source_uuid aliases.
			if (i && this.previousUuid === slot.uuid) this.recorded.cuttable[i - 1] = false;
			const cuttable = this.outstanding.size === 0 && !slot.nonCuttable;
			this.recorded.digests.push(slot.digest);
			this.recorded.uuids.push(slot.uuid);
			this.recorded.cuttable.push(cuttable);
			this.previousUuid = slot.uuid;
			if (slot.assistant) this.progress++;
			this.slots.delete(i);
		}
	}
}
