// Error classes for a failed round, checked against pi-ai's own isRetryableAssistantError().
//
//   retryable: real transient failures only: rate_limit, overloaded, 5xx, connection lost, timeouts
//   fatal:     authentication, account, invalid request, unknown model, output limit, and
//              usage-limit / quota exhaustion (a Max plan limit resets in hours, not seconds)
//   unknown:   passed through unchanged (pi decides from its own patterns)
//
// pi-ai decides from the message text alone, so the oracle is used directly: a fatal message is
// masked until it tests false, a retryable one is neutralised until it tests true. The raw text
// is kept in BridgeError.raw (and the debug log), never in the pi-visible message when unsafe.
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

export type ErrorClass = "retryable" | "fatal" | "unknown";

const FATAL_CODES = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "invalid_request", "model_not_found", "cloud_credential_error", "max_output_tokens"]);
const RETRYABLE_CODES = new Set(["rate_limit", "overloaded", "server_error"]);

const QUOTA_TEXT = /usage limit|limit reached|quota|resets? (at|in)\b|\d+-hour limit|weekly limit|out of (credits|budget)/i;
const FATAL_TEXT = /authenticat|unauthori[sz]ed|invalid.{0,12}(api.?key|token|credential)|not logged in|please run \/login|oauth|permission|forbidden|invalid.?request|bad request|model.{0,20}not.?found/i;
const RETRYABLE_TEXT = /rate.?limit|too many requests|overloaded|capacity|temporar|unavailable|timed? ?out|timeout|connection|network|socket|ECONN|ETIMEDOUT|server.?error|internal.?error/i;

/** Max usage-limit / quota exhaustion: fatal. A plain "rate limit reached" stays a transient throttle. */
export function isQuotaExhaustion(text: string): boolean {
	if (!QUOTA_TEXT.test(text)) return false;
	return !(/rate.?limit/i.test(text) && !/usage|quota|resets?|hour|weekly|credits|budget/i.test(text));
}

export function classifyError(text: string, opts: { code?: string; status?: number | null } = {}): ErrorClass {
	const { code, status } = opts;
	if (code && FATAL_CODES.has(code)) return "fatal";
	if (isQuotaExhaustion(text)) return "fatal";
	if (code && RETRYABLE_CODES.has(code)) return "retryable";
	if (status != null && status >= 500) return "retryable";
	if (status === 400 || status === 401 || status === 403 || status === 404) return "fatal";
	if (FATAL_TEXT.test(text)) return "fatal";
	if (RETRYABLE_TEXT.test(text)) return "retryable";
	if (status === 429) return "fatal"; // throttle with no retry-after and no rate-limit wording: treat as an exhausted limit
	return "unknown";
}

export class BridgeError extends Error {
	constructor(message: string, readonly errorClass: ErrorClass, readonly code?: string, readonly raw: string = message) {
		super(message);
		this.name = "BridgeError";
	}
}

const asMessage = (errorMessage: string) => ({ stopReason: "error", errorMessage } as any);
const piRetries = (text: string) => isRetryableAssistantError(asMessage(text));

// Words and codes pi-ai treats as permanent: neutralised in retryable text.
const PERMANENT = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/gi;
// Transient phrases: masked in fatal text.
const TRANSIENT = /overloaded|server_busy|servers are currently busy|high demand|at capacity|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|provider.?returned.?(an.?)?error|network.?error|connection.?(error|refused|lost)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|timed? ?out|timeout|temporar/gi;

function fatalText(raw: string, code?: string): string {
	const reset = raw.match(/resets?\s+(?:at|in)?\s*[^.\n]{1,60}/i)?.[0].trim();
	let detail = isQuotaExhaustion(raw) ? `usage limit reached${reset ? `; ${reset}` : ""}`
		: code === "max_output_tokens" ? "the output token limit was hit"
		: raw.trim() || "Claude Code returned an error";
	const head = "Claude request failed (fatal, do not retry): ";
	let msg = head + detail;
	if (!piRetries(msg)) return msg;
	detail = detail.replace(/\d{3,}/g, "#");
	msg = head + detail;
	if (!piRetries(msg)) return msg;
	detail = detail.replace(TRANSIENT, "…");
	msg = head + detail;
	if (!piRetries(msg)) return msg;
	return head + "see the debug log for details";
}

function retryableText(raw: string, code?: string): string {
	const label = code === "overloaded" || /overloaded|capacity/i.test(raw) ? "Claude overloaded"
		: code === "server_error" || /server.?error|internal.?error/i.test(raw) ? "Claude server error"
		: "Claude rate limit";
	const head = `${label} (retryable): `;
	let msg = head + (raw.trim() || "temporary failure").replace(PERMANENT, "…");
	if (piRetries(msg)) return msg;
	msg = `${label} (retryable)`;
	return piRetries(msg) ? msg : "Claude rate limit (retryable): rate limit";
}

/** Build the error for a failed round with pi-ai-compatible wording. Raw text stays in `.raw`. */
export function roundError(text: string, opts: { code?: string; status?: number | null } = {}): BridgeError {
	const cls = classifyError(text, opts);
	if (cls === "retryable") return new BridgeError(retryableText(text, opts.code), cls, opts.code, text);
	if (cls === "fatal") return new BridgeError(fatalText(text, opts.code), cls, opts.code, text);
	return new BridgeError(text.trim() || "Claude Code returned an error", cls, opts.code, text);
}

const fmt = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);

/** Timeouts read as a lost connection, which pi-ai retries. */
export function timeoutError(kind: "idle" | "round", ms: number): BridgeError {
	return new BridgeError(
		kind === "idle"
			? `Claude connection lost: no message from Claude Code for ${fmt(ms)} (idle timeout), query killed`
			: `Claude connection lost: round did not finish within ${fmt(ms)} (round timeout), query killed`,
		"retryable", kind === "idle" ? "idle_timeout" : "round_timeout");
}
