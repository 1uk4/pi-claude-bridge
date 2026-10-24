# TODO

Ideas and open questions, ordered by rough priority. Nothing is a commitment.

## Ideas

1. **Synthetic all-zero usage overwrites real counters.** A `<synthetic>` failure
   message carries all-zero usage, and `recordUsage`/`updateUsage` (`src/usage.ts`)
   guard absence, not zeros — so a failure after real output in the same turn erases
   input/output/cache totals. Pre-existing (the synthetic message always reached
   `recordUsage`); reachable pre-#162 too, since synthetic ids are UUIDs and always
   pass the different-id check.

2. **CC's typed error fields are ignored.** The SDK assistant frame declares only
   `error?: SDKAssistantMessageError` (`sdk.d.ts:3678`), the result a snake_case
   `api_error_status`; the camelCase `apiErrorStatus` / `isApiErrorMessage: true`
   seen on disk are transcript-record fields, and `error: "rate_limit"` rides on the
   assistant frame. `resultErrorText` already types off `is_error`/`subtype`/`errors[]`
   — the word-matching lives downstream (`describeRateLimitFailure` and consumers).
   A contract pin on these fields would let failure classification stop relying on
   wording. The `rate_limit_event` path covers the common case.

3. **Make the dropped-thinking-signature rate visible.** 26 of 2,363
   `claude-bridge` thinking blocks carry an empty `thinkingSignature`, so
   `src/convert.ts:138` correctly refuses to replay them (Anthropic rejects
   unverifiable signatures) -- but silently. A WARNING at the drop site turns a
   1.1% invisible loss into a number, which is the prerequisite for ever
   explaining it.

4. **Per-query rewrite staleness — done for the serving instance; worktree-spawn instances still mark via the `Symbol.for` hook registry** (`claude-bridge:markRebuildHooks`), which relies on every instance loading the same module. If a future pi loader change makes that unreliable, the hook registry needs to grow into a shared state channel (per-session mark records the serving instance reads). Session id attribution rides on `options.sessionId`, which pi-ai documents as ignorable metadata — verify it stays set on `streamSimple` calls (agent.ts passes `sessionManager.getSessionId()` today).
5. **Decide which other `WARNING:` lines should fail integration runs.** The suite gates bridge-origin `BUG:` and stranded MCP-handler markers; `diag/audit-warnings.mjs` inventories the remaining warnings. Add a warning only when its meaning and any intentional test cases are pinned.

6. **Stop the diag replay harness manufacturing the phantom-tool-call condition.**
   `diag/replay-write-path.mjs` and `diag/lib/write-path.mjs` (also used by
   `unit-convert-determinism`) call the conversion without a populated
   `customToolNameToSdk` map, so pi's `bash` is rebuilt as Claude Code's builtin
   `Bash` -- the prompt condition behind the deadlock fixed in 122914dd. A replay
   run can therefore reproduce *or mask* that bug for reasons unrelated to the code
   under test. Fix: pass the recorded tool list through to `convertPiMessages`.
   Production is unaffected (verified over 86,652 real pi messages).

7. **Surface errors that arrive with no open pi stream.** When a result lands
   after the turn already ended on a tool call, `consumeQuery` records the error
   (stopReason, errorMessage, log) but there is no open `currentPiStream` to push
   an error event onto, so the user sees a stalled turn rather than "rate limited".
   Surfacing it means synthesizing a turn pi did not ask for.
   `tests/unit-error-result.mjs` covers the recording; nothing covers the
   surfacing. This is also the third stall cause behind GitHub #35.

8. **Handler timeout / stall watchdog** -- whether the bridge should give up on an
   MCP handler that has waited implausibly long instead of only warning.

9. **Markdown rendering** in expanded tool result view. Currently plain text.
   Use `Markdown` from `@earendil-works/pi-tui` with a `MarkdownTheme`.

10. **`/claude config` slash command** for runtime configuration. Currently
    requires editing JSON and `/reload`.

11. **`/claude:btw` command** for ephemeral questions: response displayed but
    not added to LLM context.

12. **Audit tool parameter mismatches**: The bash timeout default (120s) was added
    because pi's bash has no default while Claude Code expects one. Other bridged
    tools may have similar mismatches (units, defaults, optional-vs-required params).
    Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

13. **AskUserQuestion pi shim** (main provider only): CC never sees
    AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the
    user questions interactively. Port a pi-native version using `ctx.ui.custom()`
    for an option picker with free-text fallback. Not applicable to AskClaude
    subagents (can't interact with user). See `fractary/pi-claude-code`
    `AskUserQuestion.ts` for reference.

14. **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/
    ExitPlanMode are blocked. A pi-native plan mode could use
    `pi.setActiveTools()` to restrict to read-only tools, block destructive bash
    via `tool_call` event, and surface plan approval through pi's TUI. Not
    applicable to AskClaude subagents. See `fractary/pi-claude-code`
    `PlanMode.ts`.

15. **Session-sync simplifications.** Verified dead or redundant by the final
    reviews. Each is independent, but land the writer-tracking item before the
    child-lifecycle one.
    - **Writer-tracking teardown is duplicated in four places.** `stopWriting`
      and the CAS-checked delete pair up at `src/index.ts:2137`/`2145`,
      `2289`/`2293`, `2389`/`2420`, `2509`/`2514`. A `trackSessionWriter()`
      returning `{stop, release}` makes the ownership check impossible to
      forget on a future teardown path.
    - **AskClaude's writer registration is never read.** `src/index.ts:2389`
      and its call sites `2416`, `2428`, `2509`. Ask always forks a fresh
      target id and never commits state, so no reader can wait on it. Removing
      it also makes the `sync.created` checks at `2419` and `2513`
      unconditional. Deprecated path: delete machinery, don't add it.
    - **The `"(none)"` mirror bucket is test-only.** `sessionKey`,
      `src/index.ts:196`. `syncSharedSession` reads state only for a non-null
      id and null ids are never writable. Key the map by the id and drop the
      bucket comments. Needs updates in `unit-discard-rewritten-query.mjs`,
      `unit-sync-shared-session.mjs`, `unit-deliver-tool-results.mjs`.
    - **`knownSessionIds` / `registry.known` is test-only state.**
      `src/index.ts:228`, `235`, `245`. Its only reader is
      `__test.resetSharedSession`, and tests already isolate
      `PI_CODING_AGENT_DIR`. Have the reset remove the sessions dir instead.
    - **`LiveRecording` keeps parameters only tests use.**
      `src/session-sync.ts:149`, `186`. Production always passes
      `acknowledged=false` and `uuid=undefined` since replay became the sole
      acknowledgement. Shrink to `users(messages, start, uuid, steering)` and
      `assistant(digest, toolCalls, resetTools)`.
    - **`dropParkedQuery`'s else branch is unreachable.**
      `src/index.ts:1794-1797`. `activeQuery` and `stopProcess` are set in the
      same synchronous block. `unit-discard-rewritten-query.mjs` currently
      exercises the dead branch and should set `stopProcess` instead, so it
      covers the real abort.
    - **The AskClaude launch-identity spread duplicates the provider's.**
      `src/index.ts:2119-2123` vs `2407-2409`. The `resume`/`forkAt`/`created &&
      (!resume || forkAt)` trio belongs in one helper: that expression is the
      mutual-exclusion rule between resume and fork.
    - **`done` waits for the CC child to exit before finalizing the stream.**
      `src/index.ts:2289-2293`, so every successful turn's terminal event is
      delayed until the child is gone (bounded: the SDK escalates SIGTERM to
      SIGKILL). Reordering `finalizeCurrentStream` ahead of the deferred save
      restores responsiveness if the rare stale-`activeQuery` re-entrant path
      during that window ever matters.
    - **Child-lifecycle cleanup repeats terminate/wait/delete/unregister** in
      the query-constructor failure handler and the provider and AskClaude
      `finally` blocks. One helper is possible, but the three differ in
      ordering and persistence; only worth it after the writer-tracking item.
    - **`extractIsolatedSummaryPrompt` and its `isOneOffSummary` branch are
      dead.** `src/index.ts:425`, `514-517`. The sole caller is gated on
      `cacheRetention === "none"`. Also a redundant `toBridgeContext` at
      `498`. Predates the session-sync work: remove only if already touching
      that area.
    - **`SnapshotWriter`'s `"possible-writer"` and `"query-ended"` arms are
      never passed.** `src/cache-trace.ts:321`. The only snapshot, at rotation
      (`src/index.ts:746`), passes `"no-known-writer"` and no longer precedes a
      deletion. Belongs to the cache trace, not session sync.
    - **The pending-tool rule lives in two places.** `updatePendingTools`
      (`src/session-sync.ts:53`, import cuts) and `LiveRecording.flush`
      (`src/session-sync.ts:211-218`, live cuts) both decide whether a cut is
      safe. Their shapes differ (pi messages vs slots), so a shared helper is
      thin -- but divergence between the two would silently disagree about
      cut safety. Unify when next in that code.

## Open questions

- **18 never-answered tool calls** (`[no tool result recorded]` as the lone stub of
  a single-`tool_use` turn). 389 of the historical occurrences are the fixed
  parallel-results bug, but one is NEW since the audit baseline (js13k project,
  2026-08-31, real session) -- so the cause is not extinct. Two other grep hits
  are docs quoting the marker, not records. Re-run
  `diag/audit-transcripts.mjs --since <last good date>` to check for growth.

## Lower-priority testing gaps

- **Int tests pollute the audit scan.** `rpc-harness.mjs` defaults `cwd` to the
  project root, so int sessions (SlowTool fixtures, `token0.txt`) write JSONLs
  into the real `-Users-esd-projects-pi-claude-code-acp` sessions dir and the
  transcript scanner counts them as real-project defects -- 123 fake hits
  in-window as of 2026-09-23. Fix: default test cwd to a temp dir, or teach the
  scanner to exclude self-authored test sessions.

- **Structured diagnostics for tests**: Tests grep debug-log strings to verify
  internal state. The `syncResult:` marker added on `simplify-session-sync`
  narrows this for session sync (tests parse a single targeted line per
  decision instead of the old Case-1/2/3/4 labels), but it's still grep-based.
  A proper diagnostic channel (NDJSON or dedicated diagLog entries) would be
  cleaner and resilient to log-format churn.

- **`int-cache.sh` asserts on model whim**: the run fails with `Only 1 tool call(s)
  (expected >= 2)` when Haiku answers the read prompt from context instead of
  calling the tool. Observed once in 15 runs. The tool-call count is a proxy for
  "the recording/cache path got exercised", so it cannot simply be dropped; making the
  prompt harder to satisfy from context would be the fix.

## Upstream

Nothing to fix here -- filed or inherent in the other project.

- **CC's resume reorders same-millisecond `tool_result` blocks.** 8 of 10 sessions
  (10 parallel `Read` calls, then a resume): the resumed request's block order
  differs from the on-disk record order, always as adjacent-pair swaps, and in all
  8 every swapped pair shared a millisecond timestamp. The live request matched
  disk 10 of 10, so CC's writer is faithful and its reader is not. Deterministic
  per session file, so it costs one cache write rather than a recurring tax, and
  rare: 2 of 417 real parallel groups carry a tie. Repro pattern in
  `diag/AUDIT.md`.

## Deferred

- **Session JSONL cleanup**: When sync moves a pi session to a new CC session
  (fork, copied prefix, model or cwd change), the bridge never deletes the
  previous JSONL in `~/.claude/projects/`, nor an AskClaude fork that made
  progress. Files of queries that made no progress are already deleted. Deleting
  on `session_shutdown` won't work: the saved session state resumes the current
  CC session after a restart, so only superseded files are safe to remove.
  (`persistSession: false` is already used on the isolated paths.)

- **CC CLI debug log accumulation**: When `CLAUDE_BRIDGE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.

- **Bun/Node hash mismatch for >200-char paths** (cc-session-io known
  limitation, documented in its README). Node writes with djb2, Bun reads
  with wyhash -- for long encoded paths the dirs don't match and CC can't
  find the session. Rare in practice (requires deep nesting), but the fix is
  to make cc-session-io's `projectPathToHash` Bun-aware at write time. Would
  live upstream in cc-session-io.
