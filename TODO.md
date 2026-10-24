# TODO

Ideas and open questions, ordered by rough priority. Nothing is a commitment.

## Ideas

1. **Synthetic all-zero usage overwrites real counters.** A `<synthetic>` failure message carries all-zero usage, and `recordUsage`/`updateUsage` (`src/usage.ts`) only guard against missing usage, not zeros. A failure after real output in the same turn erases its input/output/cache totals.

2. **CC's typed error fields are ignored.** The SDK assistant frame declares `error?: SDKAssistantMessageError` (`sdk.d.ts:3678`) and the result a snake_case `api_error_status`; the camelCase `apiErrorStatus` / `isApiErrorMessage` seen on disk are transcript fields only. Failure classification downstream of `resultErrorText` (`describeRateLimitFailure` and its consumers) still matches on wording. A contract pin on these fields would let it stop. `rate_limit_event` covers the common case.

3. **Log dropped thinking signatures.** 26 of 2,363 `claude-bridge` thinking blocks have an empty `thinkingSignature`, so `src/convert.ts:138` rightly skips them, but silently. A WARNING at the drop site would turn a 1.1% invisible loss into a number someone can explain.

4. **Replay harness can fake the phantom-tool-call condition.** `diag/replay-write-path.mjs` and `diag/lib/write-path.mjs` (also used by `unit-convert-determinism`) convert without a `customToolNameToSdk` map, so pi's `bash` becomes CC's builtin `Bash`, the condition behind the phantom-tool deadlock. A replay can reproduce or mask that bug for unrelated reasons. Fix: pass the recorded tool list to `convertPiMessages`. Production is unaffected (checked over 86,652 real pi messages).

5. **Surface errors that arrive with no open pi stream.** When a result lands after the turn already ended on a tool call, `consumeQuery` records the error but has no `currentPiStream` to push it to, so the user sees a stall instead of "rate limited". Surfacing it means synthesizing a turn pi didn't ask for. `tests/unit-error-result.mjs` covers the recording, nothing covers surfacing. One of the stall causes behind #35.

6. **Audit tool parameter mismatches.** The bridge adds a 120s bash timeout because pi's bash has none and CC expects one. Compare CC's schemas with pi's for read, write, edit, grep and find for similar mismatches (units, defaults, optional vs required).

7. **Session-sync simplifications.** Each is independent, except do the writer-tracking item first.
    - **Writer-tracking teardown is repeated in four places.** `stopWriting` and the CAS-checked delete pair up at `src/index.ts:2137`/`2145`, `2289`/`2293`, `2389`/`2420`, `2509`/`2514`. A `trackSessionWriter()` returning `{stop, release}` would make the ownership check impossible to forget.
    - **AskClaude's writer registration is never read.** `src/index.ts:2389`, used at `2416`, `2428`, `2509`. Ask always forks to a fresh id and never commits state, so nothing waits on it. Removing it makes the `sync.created` checks at `2419` and `2513` unconditional.
    - **The `"(none)"` mirror bucket is test-only.** `sessionKey`, `src/index.ts:196`. Null ids are never read or written in production. Key the map by id. Touches `unit-discard-rewritten-query.mjs`, `unit-sync-shared-session.mjs`, `unit-deliver-tool-results.mjs`.
    - **`knownSessionIds` / `registry.known` is test-only.** `src/index.ts:228`, `235`, `245`. Only `__test.resetSharedSession` reads it; have the reset remove the sessions dir instead.
    - **`LiveRecording` has parameters only tests use.** `src/session-sync.ts:149`, `186`. Production always passes `acknowledged=false` and `uuid=undefined`. Shrink to `users(messages, start, uuid, steering)` and `assistant(digest, toolCalls, resetTools)`.
    - **`dropParkedQuery`'s else branch is unreachable.** `src/index.ts:1794-1797`: `activeQuery` and `stopProcess` are set together. `unit-discard-rewritten-query.mjs` tests the dead branch; it should set `stopProcess` so it covers the real abort.
    - **AskClaude's launch-identity spread duplicates the provider's.** `src/index.ts:2119-2123` vs `2407-2409`. Move the `resume`/`forkAt`/`created && (!resume || forkAt)` trio, which is the rule that keeps resume and fork exclusive, into one helper.
    - **`extractIsolatedSummaryPrompt` and its `isOneOffSummary` branch are dead.** `src/index.ts:425`, `514-517`; the only caller is gated on `cacheRetention === "none"`. Also a redundant `toBridgeContext` at `498`.
    - **`SnapshotWriter`'s `"possible-writer"` and `"query-ended"` values are never passed.** `src/cache-trace.ts:321`. The only snapshot (`src/index.ts:746`) passes `"no-known-writer"`.
    - **The pending-tool rule is in two places.** `updatePendingTools` (`src/session-sync.ts:53`, import cuts) and `LiveRecording.flush` (`src/session-sync.ts:211-218`, live cuts) both decide whether a cut is safe. Their inputs differ, so a shared helper would be thin, but if the two drift apart they'll silently disagree about cut safety.

## Open questions

- **Never-answered tool calls** (`[no tool result recorded]` as the only stub of a single-`tool_use` turn). 389 historical hits are the fixed parallel-results bug, but one real one appeared after the audit baseline (js13k project, 2026-08-31), so the cause isn't gone. Re-run `diag/audit-transcripts.mjs --since <last good date>` to check for more.

## Testing gaps

- **Int tests pollute the audit scan.** `rpc-harness.mjs` defaults `cwd` to the project root, so int-test sessions land in the real project's sessions dir and the transcript scanner counts them as defects (123 fake hits as of 2026-09-23). Fix: default to a temp dir, or have the scanner skip test sessions.

- **`int-cache.sh` depends on the model calling a tool.** It fails with `Only 1 tool call(s) (expected >= 2)` when Haiku answers from context instead of reading the file (1 in 15 runs). The count proves the recording/cache path ran, so it can't just be dropped; make the prompt harder to answer from context.

## Deferred

- **Superseded session files pile up.** When sync moves a pi session to a new CC session (fork, copied prefix, model or cwd change), the old JSONL in `~/.claude/projects/` is never deleted, nor is an AskClaude fork that made progress. Files from queries with no progress already are. Deleting on `session_shutdown` won't work, since saved state resumes the current CC session after a restart; only superseded files are safe to remove.
