/** Provider core: error text must land on the right side of pi-ai's retry regexes; env/auth/orphans hygiene. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { mapSdkError, CONNECTION_LOST } from "../src/core/errors.js";
import { childEnv, CC_CHILD_ENV } from "../src/core/env.js";
import { detectClaudeLogin } from "../src/core/auth.js";
import { sweepOrphanClaudeProcesses, isOrphanedSdkChild } from "../src/core/orphans.js";

const retryable = (text) => isRetryableAssistantError({ stopReason: "error", errorMessage: text });

describe("core error shaping", () => {
	it("retryable: rate limit, overloaded, server error, connection lost", () => {
		for (const [code, detail] of [["rate_limit", "slow down"], ["overloaded", "busy"], ["server_error", "oops"]]) {
			assert.equal(retryable(mapSdkError(code, detail)), true, code);
		}
		assert.equal(retryable(CONNECTION_LOST), true);
	});

	it("terminal: billing, auth, subscription usage limit (even under a rate_limit class)", () => {
		assert.equal(retryable(mapSdkError("billing_error", "card declined")), false);
		assert.equal(retryable(mapSdkError("authentication_failed", "please /login")), false);
		assert.equal(retryable(mapSdkError(undefined, "5-hour limit reached ∙ resets 3pm")), false);
		assert.equal(retryable(mapSdkError("rate_limit", "Weekly limit reached")), false);
		assert.match(mapSdkError("rate_limit", "Weekly limit reached"), /^quota exceeded/);
	});
});

describe("core env hygiene", () => {
	it("strips API credentials and applies the CC child env", () => {
		const env = childEnv({ ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "t", PATH: "/bin" });
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
		assert.equal(env.PATH, "/bin");
		for (const [k, v] of Object.entries(CC_CHILD_ENV)) assert.equal(env[k], v);
	});
});

describe("core auth detection", () => {
	const none = { fileExists: () => false, keychain: async () => false, platform: "darwin" };
	it("reports no login when nothing is found", async () => {
		assert.equal(await detectClaudeLogin({ ...none, env: {} }), undefined);
	});
	it("finds the env token, credentials file, or Keychain", async () => {
		assert.equal(await detectClaudeLogin({ ...none, env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }), "CLAUDE_CODE_OAUTH_TOKEN");
		assert.match(await detectClaudeLogin({ ...none, env: {}, fileExists: () => true }), /credentials/);
		assert.equal(await detectClaudeLogin({ ...none, env: {}, keychain: async () => true }), "macOS Keychain");
	});
	it("does not probe the Keychain off macOS", async () => {
		assert.equal(await detectClaudeLogin({ ...none, env: {}, platform: "linux", keychain: async () => true }), undefined);
	});
});

describe("core orphan sweep", () => {
	const sdk = "/x/claude --output-format stream-json --input-format stream-json --verbose";
	it("only matches pid-1 children carrying the SDK transport flags", () => {
		assert.equal(isOrphanedSdkChild({ pid: 5, ppid: 1, command: sdk }), true);
		assert.equal(isOrphanedSdkChild({ pid: 5, ppid: 700, command: sdk }), false); // live parent
		assert.equal(isOrphanedSdkChild({ pid: 5, ppid: 1, command: "/x/claude" }), false); // interactive session
	});
	it("signals only orphans", async () => {
		const killed = [];
		const rows = [{ pid: 11, ppid: 1, command: sdk }, { pid: 12, ppid: 99, command: sdk }, { pid: 13, ppid: 1, command: "vim" }];
		const res = await sweepOrphanClaudeProcesses({ list: async () => rows, kill: (p) => killed.push(p) });
		assert.deepEqual(res, [11]);
		assert.deepEqual(killed, [11]);
	});
});
