// Error classes for a failed round, shaped so pi-ai's isRetryableAssistantError() agrees.
//
//   retryable: rate limit, quota/usage limit, overloaded, 5xx, timeouts, lost connection
//   fatal:     authentication, account, invalid request, unknown model
//   unknown:   message passed through unchanged (pi decides from its own patterns)
//
// pi-ai treats an error as retryable when its text matches a transient pattern (e.g.
// "rate limit", "overloaded", "connection lost") and does NOT match a permanent-limit
// pattern ("quota exceeded", "billing"). Retryable messages are therefore worded to hit the
// first list and to avoid the second; fatal messages avoid every transient pattern.

export type ErrorClass = "retryable" | "fatal" | "unknown";

const FATAL_CODES = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "invalid_request", "model_not_found", "cloud_credential_error"]);
const RETRYABLE_CODES = new Set(["rate_limit", "overloaded", "server_error", "max_output_tokens"]);

const FATAL_TEXT = /authenticat|unauthori[sz]ed|invalid.{0,12}(api.?key|token|credential)|not logged in|please run \/login|oauth|permission|forbidden|invalid.?request|bad request|model.{0,20}not.?found|\b40[0134]\b/i;
const RETRYABLE_TEXT = /rate.?limit|usage limit|limit reached|quota|too many requests|overloaded|capacity|temporar|unavailable|timed? ?out|timeout|connection|network|socket|ECONN|ETIMEDOUT|\b(429|5\d\d)\b|server.?error|internal.?error/i;

export function classifyError(text: string, opts: { code?: string; status?: number | null } = {}): ErrorClass {
	const { code, status } = opts;
	if (code && FATAL_CODES.has(code)) return "fatal";
	if (code && RETRYABLE_CODES.has(code)) return "retryable";
	if (status === 429 || (status != null && status >= 500)) return "retryable";
	if (status === 400 || status === 401 || status === 403 || status === 404) return "fatal";
	if (FATAL_TEXT.test(text)) return "fatal";
	if (RETRYABLE_TEXT.test(text)) return "retryable";
	return "unknown";
}

export class BridgeError extends Error {
	constructor(message: string, readonly errorClass: ErrorClass, readonly code?: string) {
		super(message);
		this.name = "BridgeError";
	}
}

/** Build the error for a failed round with pi-ai-compatible wording. */
export function roundError(text: string, opts: { code?: string; status?: number | null } = {}): BridgeError {
	const cls = classifyError(text, opts);
	const clean = text.trim() || "Claude Code returned an error";
	if (cls === "retryable") {
		// Keep the original text, but never let it flip pi's classification to permanent.
		const safe = clean.replace(/quota exceeded/gi, "quota reached").replace(/billing/gi, "account");
		const label = opts.code === "overloaded" || /overloaded|capacity/i.test(clean) ? "Claude overloaded"
			: opts.code === "server_error" || /server.?error|internal.?error|\b5\d\d\b/i.test(clean) ? "Claude server error"
			: "Claude rate limit";
		return new BridgeError(`${label} (retryable): ${safe}`, cls, opts.code);
	}
	if (cls === "fatal") return new BridgeError(`Claude request failed (fatal, do not retry): ${clean.replace(TRANSIENT_WORDS, "…")}`, cls, opts.code);
	return new BridgeError(clean, cls, opts.code);
}

// Words that would make pi-ai retry a fatal error.
const TRANSIENT_WORDS = /overloaded|rate.?limit|too many requests|\b(429|5\d\d)\b|service.?unavailable|server.?error|internal.?error|connection.?(error|lost|refused)|network.?error|fetch failed|other side closed/gi;

const fmt = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);

/** Timeouts read as a lost connection, which pi-ai retries. */
export function timeoutError(kind: "idle" | "round", ms: number): BridgeError {
	return new BridgeError(
		kind === "idle"
			? `Claude connection lost: no message from Claude Code for ${fmt(ms)} (idle timeout), query killed`
			: `Claude connection lost: round did not finish within ${fmt(ms)} (round timeout), query killed`,
		"retryable", kind === "idle" ? "idle_timeout" : "round_timeout");
}
