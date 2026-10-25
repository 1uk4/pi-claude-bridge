// Error-text shaping for pi-ai's retry policy.
//
// pi-ai decides whether to retry with a regex over `errorMessage`
// (utils/retry.js isRetryableAssistantError): "overloaded", "rate.?limit",
// 429/500/502/503/504, "server.?error", "connection.?lost" retry;
// "billing", "quota exceeded" do not. The SDK reports a class (`rate_limit`, ...)
// or free text, so the provider must shape the *text* to land on the right side.

/** Max-plan usage-limit exhaustion arrives as text; it resets in hours, so it must NOT retry. */
export const USAGE_LIMIT = /usage limit|limit reached|5-hour|weekly limit/i;

/** A dead CLI process: retryable ("connection lost"). */
export const CONNECTION_LOST = "claude process ended unexpectedly (connection lost)";

/** SDK error class (or undefined) + detail → text pi-ai's retry regexes classify correctly. */
export function mapSdkError(code: string | undefined, detail: string): string {
	// Subscription exhaustion can be reported under any class, including rate_limit —
	// check it first or a 5-hour cap would be retried with backoff for hours.
	if (USAGE_LIMIT.test(detail)) return `quota exceeded: ${detail}`;
	switch (code) {
		case "rate_limit": return `rate limit (429): ${detail}`; // retryable
		case "overloaded": return `overloaded: ${detail}`; // retryable
		case "server_error": return `server error (500): ${detail}`; // retryable
		case "billing_error":
		case "account_on_hold": return `billing: ${detail}`; // terminal
		case "authentication_failed":
		case "oauth_org_not_allowed":
		case "verification_required": return `authentication_failed: ${detail}`; // terminal
		default: return detail;
	}
}

/** Error text for a failed SDK `result` message. */
export function resultErrorText(result: { subtype?: string; result?: unknown }): string {
	return typeof result.result === "string" && result.result ? result.result : `sdk result ${result.subtype}`;
}
