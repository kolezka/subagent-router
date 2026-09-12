# Transport: gaps

- **Claude Code capability is `pending`.** [verified] direct read of
  [../../tests/fixtures/capabilities/claude-code-2.1.263.json](../../tests/fixtures/capabilities/claude-code-2.1.263.json):
  every probe (`M1`-`M4`, `M10`) is `"pending"`, `status: "pending"`. `assertCapability` refuses
  every `claude-marker`/`claude-correlation`/`claude-fork` gate for this fixture, by design.
- **No measured trusted-start producer for M10-freshness.** `resolveTrustedStart` in the real
  bootstrap ([../../src/transport/claude-hook.ts](../../src/transport/claude-hook.ts)) always
  returns `freshDelegation: false`; channel B and B2 both stay closed in production until a real
  producer exists and M10-freshness passes.
- **Correlation (M1) is untested against a live client.** `CorrelationStore` itself is unit-tested
  ([../../tests/adapters/correlation.test.ts](../../tests/adapters/correlation.test.ts)), but no
  shipped Claude Code version has a passing M1 (identifier entropy) measurement.
- **M1 has a statistical sample analyzer, not a generator-entropy proof.**
  [../../tests/probes/evidence-m1.ts](../../tests/probes/evidence-m1.ts) reads agent ids out of
  run captures and measures their observed variety (length, alphabet, per-position entropy).
  Sample variety is not generator entropy: `judgeM1Sample` can fail a sample outright (a
  collision, or a large clean sample whose format still measures under 64 bits) but can never
  return `passed`. M1 stays `pending` until either the id generator is directly inspected or a
  controlled-generator proof exists.
- **Fork handling (M4, D3, requirement 19)** is covered only by the hermetic
  `unrecognized-fork-pass-through-and-recognized-fork-follows-w19` case in
  [../../tests/e2e/routing.test.ts](../../tests/e2e/routing.test.ts): a fake gateway, a synthetic
  profile. No real-client fork test exists in this worktree.
- **`bun-fetch` (default, non-raw) stays `pending`.** [verified] direct read of
  [../../tests/fixtures/capabilities/transport-bun-fetch-1.4.2.json](../../tests/fixtures/capabilities/transport-bun-fetch-1.4.2.json):
  all fields `"pending"`. Only `bun-fetch-raw` has a passing measurement; the two are not
  interchangeable, and a handler built with the default fetch adapter is refused by
  `assertTransportProfileReady`.
- Hermetic and loopback coverage
  ([../../tests/e2e/routing.test.ts](../../tests/e2e/routing.test.ts),
  [../../tests/integration/cliproxyapi.test.ts](../../tests/integration/cliproxyapi.test.ts),
  named case: "streams thinking, tool_use and message completion, only releasing the remainder
  after downstream reads the first bytes") proves the handler and a synthetic-profile,
  fixture-gateway pair behave correctly together, including causal first-byte-then-rest ordering.
  Neither is a native Claude Code run or a live CLIProxyAPI deployment; both use synthetic profiles
  or a local fixture server, not a real client or a real remote gateway.

See [../measurements/claude-code-2.1.263-partial.md](../measurements/claude-code-2.1.263-partial.md)
for a review of historical parent/child model artifacts. It is not a new native run and closes
none of the gaps above; M1, M3/M3-B2, M4, M10 and freshness stay unproven.

- **M3-A has an extractor and judge; the first real pass is for 2.1.267 (next bullet), and 2.1.268 has since passed too (last two bullets).** [verified] direct read of
  [../../tests/probes/evidence-m3a.ts](../../tests/probes/evidence-m3a.ts): `readRunCapture` +
  `extractM3AEvidence` + `judgeM3A` turn a native-claude-handler.ts run capture into a
  pending/failed/passed verdict, refusing to pass on an undeclared scaffold override or a
  version-'synthetic-hermetic' profile. The one recorded run
  (`tests/probes/.runs/handler-4r0D99`) predates the scaffold-manifest requirement and has no
  `NNN-profile-scaffold.json`, so it judges `pending` by construction; the earlier synthetic
  handler trial referenced above cannot and does not count as an M3-A pass. `M3-A` in
  [../../tests/fixtures/capabilities/claude-code-2.1.266.json](../../tests/fixtures/capabilities/claude-code-2.1.266.json)
  stays `pending` -- this run never touched that fixture -- until a future approved loopback run
  against that exact version, scaffolded and declared, judges `passed` and is narrowed in via
  `tests/probes/fixture-writer.ts`.
- **First real M3-A pass exists, but was not narrowed into any fixture.** [verified] direct read
  of `tests/probes/.runs/handler-yYv981` (2026-09-10, real `claude` 2.1.267, `native-claude-run.sh
  handler` with `PROBE_PROFILE_BASE=real`, judged with `tests/probes/judge-run.ts`): the injected
  profile is based on the real (then all-pending) `claude-code-2.1.267.json` fixture via
  `loadCapabilityProfile`, with exactly `status`, `probes.M10`, `probes.M3-A`, `lifecycle.*` and
  `parentPromptPosition` overridden (`realLayoutProfile` in
  [../../tests/probes/native-claude-handler.ts](../../tests/probes/native-claude-handler.ts)).
  `judgeM3A` returned `passed` for both captured channel-A pairs (all six per-pair booleans true:
  `block0ByteIdentical`, `block0MatchesScaffold`, `markerOnBlock1Line1`, `markerStrippedUpstream`,
  `versionMatchesProfile`, `agentIdMatchesHook`). The run's own manifest declared `parallel`
  (`PROBE_PHASES_EXERCISED=parallel`), but `judgeLifecyclePhase('parallel')` judged `pending`
  (`parallel-requires-interleaved-sequence-numbers`): with exactly one routed request per agent,
  the merged sequence has only the strict-minimum one agent-to-agent transition, which
  `isSequenceInterleaved` in
  [../../tests/probes/evidence-m10.ts](../../tests/probes/evidence-m10.ts) can never distinguish
  from a purely sequential dispatch -- a genuine limitation of that check for single-request-per-
  agent runs, not evidence the real client dispatched sequentially. M3-A and `parallel` are
  independent probes, so `fixture-writer.ts` narrowed exactly one key into
  [../../tests/fixtures/capabilities/claude-code-2.1.267.json](../../tests/fixtures/capabilities/claude-code-2.1.267.json):
  `probes.M3-A: passed`, with a `diagnostics` entry naming run `handler-yYv981`. At that checkpoint
  `status`, `M10`, every lifecycle phase and every other probe stayed `pending`, so the alternate
  slot was still closed in production until M10 and the lifecycle phases are measured for this
  version.

- **M10 lifecycle-phase and M10-freshness judges exist, but no real pass is recorded.**
  [verified] direct read of
  [../../tests/probes/evidence-m10.ts](../../tests/probes/evidence-m10.ts) and
  [../../tests/probes/evidence-freshness.ts](../../tests/probes/evidence-freshness.ts):
  `extractLifecycleEvidence` + `judgeLifecyclePhase` turn a run's declared
  `capture/000-run-manifest.json` (`phasesExercised`, `mode`) plus its request/response pairs
  into a per-phase `next-turn`/`resume`/`compaction`/`nested`/`parallel` verdict, and
  `extractFreshnessEvidence` + `judgeM10Freshness` turn instance-fetch/register/consume/replay
  records into an `M10-freshness` verdict; both fail closed to `pending` when the run declares
  nothing. `compaction` additionally stays `pending` until a later request of the same agent
  is observed opening with the client's post-compaction continuation wrapper
  (`compaction-requires-observed-compact-boundary`; the diagnostic name predates the 2026-09-12
  signal change, when the transcript-only `compact_boundary` marker was found never to reach a
  request body);
  nothing in the current saved runs or fixtures ever exercises real lifecycle transitions, so
  every phase and `M10-freshness` in
  [../../tests/fixtures/capabilities/claude-code-2.1.266.json](../../tests/fixtures/capabilities/claude-code-2.1.266.json)
  stay `pending`. `tests/probes/.runs/handler-yYv981` (see above) is the first run whose manifest
  declares a phase at all (`parallel`), and it still judged `pending` there (see above); every
  other phase stayed `pending` too (`*-not-declared`, since the manifest names only `parallel`).
- **The production freshness hook has now been run once, exactly as predicted.**
  `tests/probes/native-claude-handler.ts` records instance-fetch/delegation-register/consume/replay
  capture files when `PROBE_FRESHNESS_HOOK=production` is set (gated inside the existing
  `RUN_NATIVE_PROBES` block only), and `tests/probes/native-claude-run.sh`'s handler mode can
  swap its static fake `hook.sh` for a wrapper that runs the real published `claude-hook`
  entrypoint against the run's own front server. [verified] `tests/probes/.runs/handler-yYv981`
  (2026-09-10) ran this wiring under the operator-scoped authorization for this worktree
  (`native-claude-run.sh handler` via `tests/probes/native-claude-run.sh`, never a direct
  `RUN_NATIVE_PROBES` invocation outside that script). It confirms the prediction exactly:
  `src/transport/claude-hook.ts`'s own bootstrap still always resolves `freshDelegation: false`,
  so the run recorded zero instance-fetch, delegation-register, delegation-consume and
  delegation-replay files (all four counts 0; `judgeM10Freshness` returned `pending` with
  `freshness-no-records`). This closes the "never run" half of the gap; the underlying bootstrap
  limitation it confirmed is unchanged and still requires a real `resolveTrustedStart` producer
  before `M10-freshness` can ever measure past `pending`.

- **`next-turn` and `parallel` now have a real pass, from a run designed to give each child two
  requests.** [verified] direct read of `tests/probes/.runs/next-turn-jFdsmI` (2026-09-10, real
  `claude` 2.1.267, `native-claude-run.sh next-turn` with `PROBE_PROFILE_BASE=real
  PROBE_FRESHNESS_HOOK=production PROBE_PHASES_EXERCISED=parallel,next-turn`, judged with
  `tests/probes/judge-run.ts`): `next-turn` mode (added alongside `handler` mode in
  `tests/probes/native-claude-run.sh` and `tests/probes/native-claude-handler.ts`) grants each
  probe child agent the `Read` tool and points `createHandlerFixture`'s new opt-in
  `childReadFilePath` option at a file the launcher creates in the CLI's own sandboxed WORK
  directory; a routed child's first request is now answered with a forced `tool_use` for `Read`
  instead of the immediate echo, so the real client executes it for real and sends a genuine
  second request carrying the resulting `tool_result` before it gets the echo. `handler` mode
  itself is unchanged (`childReadFilePath` absent, one request per child, exactly as before).
  Both channel-A agents made exactly two forwarded requests each in this run, to a stable
  upstream model on both (no drift), and the two agents' requests interleaved by sequence number
  (`native-probe-beta`, `native-probe-alpha`, `native-probe-beta`, `native-probe-alpha`) -- the
  exact condition `isSequenceInterleaved` in
  [../../tests/probes/evidence-m10.ts](../../tests/probes/evidence-m10.ts) requires, and which the
  prior `handler-yYv981` run (one request per agent) could not produce. `judgeLifecyclePhase`
  returned `passed` for both `parallel` and `next-turn` (the run manifest's declared `mode`
  matched `next-turn`); `judgeM3A` also returned `passed` on this same run (4 channel-A pairs, all
  six per-pair booleans true), reconfirming the 2.1.267 M3-A pass on genuinely different traffic.
  `tests/probes/fixture-writer.ts` narrowed exactly `lifecycle.parallel: passed` and
  `lifecycle["next-turn"]: passed` into
  [../../tests/fixtures/capabilities/claude-code-2.1.267.json](../../tests/fixtures/capabilities/claude-code-2.1.267.json),
  with one `diagnostics` entry per key naming run `next-turn-jFdsmI`. At that checkpoint `status`,
  `M10`, `M10-freshness` and the three remaining lifecycle phases (`resume`, `compaction`, `nested`)
  stayed `pending` -- this run never declared or exercised them -- so the alternate slot stayed
  closed in production until M10 itself and the remaining phases are measured for this version.
- **M10-freshness confirmed pending again on the next-turn run, same root cause as before, not a
  new gap.** [verified] direct read of `tests/probes/.runs/next-turn-jFdsmI/capture`: zero
  instance-fetch/delegation-register/delegation-consume/delegation-replay files were recorded
  despite `PROBE_FRESHNESS_HOOK=production`; `judgeM10Freshness` returned `pending` with
  `freshness-no-records`, identical in shape to `handler-yYv981` (see above) -- the same
  `src/transport/claude-hook.ts` bootstrap limitation (`resolveTrustedStart` always returns
  `freshDelegation: false`) reconfirmed on a second, independent real-client run, now including
  one where every child made two requests. **What M10 (the probe itself, not the lifecycle
  phases) still needs**: a real `resolveTrustedStart` producer in the production bootstrap that
  can actually issue a fresh-delegation envelope before a child's first request, so
  `native-claude-handler.ts`'s existing production-hook wiring
  (`instance-fetch`/`delegation-register`/`delegation-consume`/`delegation-replay` capture,
  already exercised twice now with zero records both times) has something real to register and
  consume. Until that producer exists, no run through this probe -- `handler` or `next-turn` --
  can move `M10-freshness` past `pending`, regardless of how many requests a child makes.
- **`resume` lifecycle measured: the child agent id does NOT persist across a real resume
  boundary, so the phase stays `pending` (honest, not faked).** [verified] direct read of
  `tests/probes/.runs/resume-euk9s4` (2026-09-10, real `claude` 2.1.267,
  `PROBE_PROFILE_BASE=real PROBE_PHASES_EXERCISED=resume tests/probes/native-claude-run.sh
  resume`, judged with `tests/probes/judge-run.ts`): a new `resume` launcher mode
  (`tests/probes/native-claude-run.sh`) drives TWO sequential CLI invocations against the same
  handler server and capture dir. Invocation 1 creates the session under a fixed `--session-id
  c0ffee00-0000-4000-8000-000000000000` and delegates to the two channel-A children (two routed
  requests); invocation 2 resumes with `-c` (continue) so the parent re-delegates. Passing the
  same `--session-id` twice fails with "Session ID ... already in use" (confirmed empirically),
  and `--fork-session` was deliberately avoided (it forks to a new id). The
  `native-claude-handler.ts` fixture gained a one-shot `resumeReDelegate` opt-in
  (`PROBE_RESUME=1`) so a resumed parent turn replaying its prior `tool_result` history
  re-delegates exactly once instead of ending the turn. Both invocations completed
  (`PARENT_FINAL_OK` each, the same `session_id` echoed back both times, and every request in
  both invocations carrying the same `x-claude-code-session-id`), so the resume boundary itself
  worked: invocation 2 genuinely re-delegated. But the measured child ids did NOT persist:
  invocation 1 sent two `x-claude-code-agent-id` values and invocation 2 sent two different
  ones, four distinct ids in all, one routed request each, none with two requests. The same
  shape was measured twice (the earlier run `resume-TVSClp`, before the review fixes below, and
  this one). The real client keeps the session id but assigns a fresh child id on re-delegation
  across a resume boundary, so
  `judgeLifecyclePhase('resume')` returned `pending` with `resume-insufficient-requests: no agent
  has two routed requests spanning the declared boundary`. This is the honest, correct outcome;
  the fixture was deliberately left at `lifecycle.resume: pending` (no headers rewritten, no
  capture seeded, no forced second request within one invocation). `judgeM3A` returned `passed`
  on this same run (4 channel-A pairs, all six per-pair booleans true), reconfirming the 2.1.267
  M3-A pass on genuinely different traffic. `resume` stays `pending` until a client version
  reuses the child id across the resume boundary, or the judge gains a resume-specific signal
  other than same-id-two-requests (an operator decision, RED first, not made here). Review fixes
  folded in before this run: a retried final request (identical body, no new user turn) never
  consumes the one-shot re-delegation; a resumed round gets its own tool_use id prefix so a
  request carrying both rounds' `tool_result` blocks still matches; a failed first invocation
  exits with its own code instead of being masked by the second; `resume` refuses
  `PROBE_FRESHNESS_HOOK=production` up front because its two `env -i` invocations carry no
  `SUBAGENT_ROUTER_SECRET`.
- **`compaction` lifecycle measured: print mode never compacted under any controllable knob, so
  the phase stays `pending` (honest, not faked).** [verified] direct read of three read-only probe
  runs against the real `claude` 2.1.267 binary (`tests/probes/.runs/compaction-probe-8A67hu`,
  `compaction-probe-mTVmOA`, `compaction-probe-YoOZas`, 2026-09-10, a throwaway
  `next-turn`-shaped driver in `tests/probes/redcheck-tmp/` that was removed after these runs): the
  driver copied `native-claude-run.sh` `next-turn` mode (same `env -i` allowlist, isolated
  HOME/CLAUDE_CONFIG_DIR, the bun handler fixture with `PROBE_CHILD_READ_FILE` so each child makes
  two requests, fake auth token, loopback base URL) and added exactly one compaction knob to the
  client env per run: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200` (run `8A67hu`),
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000` (run `mTVmOA`), and
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000` plus `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1` (run `YoOZas`).
  Every run exited 0 and the CLI still decoded `PARENT_FINAL_OK` (each child made exactly two
  routed requests, no drift), but not one pre-handler request body, post-handler upstream body, or
  isolated transcript line (`config/projects/*/**/*.jsonl`) contained the `compact_boundary`
  substring: marker count 0 across all three runs. `judgeLifecyclePhase('compaction')` returned
  `pending` with `compaction-requires-observed-compact-boundary`, as expected. The
  `DISABLE_AUTO_COMPACT` knob was not tried (it disables, not enables). `compaction` stays
  `pending` in `tests/fixtures/capabilities/claude-code-2.1.267.json` until either a client
  version emits a `compact_boundary` marker under a controllable setting, or the judge gains a
  compaction-specific signal other than a later request carrying that marker (an operator
  decision, RED first, not made here). That `until either` sentence is historical, true only
  until 2026-09-12: the second branch was taken, the judge now reads the client's on-the-wire
  continuation wrapper, and the phase has since been measured for 2.1.268. See the compaction
  bullet at the end of this file.
- **`nested` lifecycle, first attempt (2026-09-10, historical): the probe mode exists, but this
  run hit a client auto-update to 2.1.268 and could not route any child, so it left the phase
  `pending` for 2.1.267 (unmeasured) and 2.1.268 (fail-closed). The pinned 2.1.267 rerun in the
  next bullet has since measured the phase; the 2.1.268 result below stands as measured.**
  [verified] direct read of
  `tests/probes/.runs/nested-PogPYc` (2026-09-10, `PROBE_PROFILE_BASE=real
  PROBE_PHASES_EXERCISED=nested tests/probes/native-claude-run.sh nested`): a new `nested`
  launcher mode grants exactly `native-probe-alpha` the `Agent` tool (beta and every other mode
  keep their tools line) and the fixture opt-in `PROBE_NESTED_AGENT=native-probe-alpha`
  (`nestedDelegatingAgent` in `native-claude-handler.ts`) answers alpha's first routed request with
  one scripted Agent `tool_use` delegating to beta (id `toolu_nested_0`, keyed by
  `x-claude-code-agent-id`), so a grandchild request can be measured for
  `x-claude-code-parent-agent-id`; alpha's second request carrying that `tool_result` gets the
  echo. Hermetic coverage: judge tests for the `nested` branch (pass with the header naming
  another routed child, pending without it, pending when undeclared, failed on drift), four
  fixture tests, two launcher tests. The run itself observed `claude --version` 2.1.268: the
  `/Users/me/.local/bin/claude` symlink had been repointed from 2.1.267 to 2.1.268 by the client's
  own updater earlier that evening (the launcher sets `DISABLE_AUTOUPDATER=1` only for its own
  isolated invocations; the operator's interactive sessions are not covered). No
  `claude-code-2.1.268.json` fixture existed, so `loadCapabilityProfile` returned the synthetic
  newer-version profile (`capability-newer-version-unmeasured`, every probe `pending`), the scaffold
  then overrode it for the run, and the handler bound the alternate slot to version 2.1.268. Both
  children still got `422 missing-selection`, the parent decoded `PARENT_MISMATCH`, and the capture
  holds two child pre-handler requests but zero child upstream requests: under 2.1.268 a child's
  first user message carries THREE text blocks (block 0: the operator's instruction files wrapped
  in `<system-reminder>`, block 1: the dated context scaffold that 2.1.267 put in block 0, block 2:
  the delegation prompt with the channel-A marker on its first line). The alternate slot requires
  exactly two blocks with the scaffold in block 0, so it correctly fell back to the legacy slot,
  which never sees the marker. This is the fail-closed behaviour the spec requires, not a probe
  defect, and it means the 2.1.267 M3-A pass does not carry over. `judgeLifecyclePhase('nested')`
  returned `pending` with `nested-requires-observed-parent-agent-id-header`; as of this run neither
  2.1.268 nor 2.1.267 had been seen sending that header on a grandchild request, because no
  grandchild was ever spawned. The pinned run in the next bullet has since observed it on 2.1.267,
  and the 2026-09-11 `nested-uxI3hK` run below has since observed it on 2.1.268, so the
  "unmeasured for 2.1.268" reading of this bullet is historical. A new all-pending `claude-code-2.1.268.json` fixture is added so the next run
  starts from a real fixture; nothing in it or in the 2.1.267 fixture changed by hand. Next: pin
  the launcher to an explicit versioned binary so a run can target 2.1.267 deliberately and rerun
  `nested` there. The 2.1.268 three-block layout has since been measured as its own M3-A run; see
  the `after-native-context-v2` bullet below.

- **`nested` lifecycle is `passed` for 2.1.267 on a version-pinned run.** [verified]
  `tests/probes/.runs/nested-gBXfBh` (2026-09-11), judged by
  [../../tests/probes/judge-run.ts](../../tests/probes/judge-run.ts); the launcher used the
  canonical versioned path `/Users/me/.local/share/claude/versions/2.1.267` and every captured
  client request reports 2.1.267. The parent decoded `PARENT_FINAL_OK` (`is_error: false`, empty
  `permission_denials`) and `subagent_stats` shows a real grandchild: `spawned` 3, `max_depth` 2,
  `spawned_by_subagents` 1. Exactly one of the four routed child requests carried
  `x-claude-code-parent-agent-id`, matching another observed child id; this run newly observes that
  header, superseding the runs documented above where it was absent. The clause that it stays
  unmeasured for 2.1.268 is historical: `nested-uxI3hK` (2026-09-11, see the last bullet) observes
  it there too. Upstream models held stable: alpha twice on `gateway/fast-worker`, each beta once on
  `gateway/smart-worker`, the parent on `probe-parent-model`. `lifecycle.nested` judged `passed` and
  `m3a.result` `passed` (`pairCount` 4, all six per-pair booleans true, zero diagnostics); a
  negative control removing the parent header from the in-memory evidence flipped nested back to
  `pending` with `nested-requires-observed-parent-agent-id-header`, and the saved capture is
  unmodified. `writeCapabilityFixture` narrowed exactly `lifecycle.nested: passed` into
  [../../tests/fixtures/capabilities/claude-code-2.1.267.json](../../tests/fixtures/capabilities/claude-code-2.1.267.json)
  with one `diagnostics` entry naming the run. Still `pending` for 2.1.267: `status`, `M1`-`M4`,
  `M3-B2`, `M10`, `M10-freshness`, `resume`, `compaction`; `parentPromptPosition` is untouched, so
  the alternate slot stays closed in production.

- **`after-native-context-v2`: the 2.1.268 three-block layout is measured and `M3-A` is `passed`
  for that version. The headline clause "no fixture declares the layout" held only until
  2026-09-11 and is historical; see the closing paragraph of this bullet.** [verified] `tests/probes/.runs/handler-yXSP4o` (2026-09-11, real `claude` 2.1.268,
  `/Users/me/.local/bin/claude` confirmed pointing at `versions/2.1.268` immediately before the
  run, `PROBE_LAYOUT=v2 PROBE_PROFILE_BASE=real PROBE_PHASES_EXERCISED=parallel
  tests/probes/native-claude-run.sh handler`), judged by `tests/probes/judge-run.ts`:
  `m3a.result` `passed`, `pairCount` 2, all six per-pair booleans true on both pairs, zero
  diagnostics. Both children carried the three text block envelope; block 2's first line was the
  `model="fast"` marker for one child and `model="smart"` for the other; the forwarded upstream
  models were `gateway/fast-worker` and `gateway/smart-worker`; blocks 0 and 1 were byte identical
  from pre-handler to upstream on both pairs and the marker line was gone from block 2 upstream;
  the parent decoded `PARENT_FINAL_OK`. A new `after-native-context-v2` position, an
  `isNativeInstructionsBlockV2` grammar for block 0, and a layout-aware `evidence-m3a.ts` back it;
  a capture judged with the other layout's rules now returns `pending`, never `passed`.
  `claude-code-2.1.268.json` was narrowed to `probes."M3-A": "passed"` through
  `writeCapabilityFixture` only, run id recorded in its `diagnostics` line, nothing edited by hand.
  Historical, true at the time of that run only: the writer never emits `parentPromptPosition`, so
  the fixture then carried no layout field and production fell back to the legacy slot. That gap was
  closed on 2026-09-11 by the operator-approved hand edit described in the next bullet;
  `writeCapabilityFixture` still never emits the field, which is why the edit was manual.
  `after-native-context-v1` is untouched and still undeclared for 2.1.266 and 2.1.267.

- **2.1.268 lifecycle: `next-turn`, `parallel` and `nested` are `passed`; `resume` stays `pending`;
  `compaction` is UNMEASURED for this version.** [verified] three real runs on 2026-09-11 against the
  pinned binary `/Users/me/.local/share/claude/versions/2.1.268` (`PROBE_LAYOUT=v2
  PROBE_PROFILE_BASE=real`), each judged by
  [../../tests/probes/judge-run.ts](../../tests/probes/judge-run.ts); every captured client request
  reports version 2.1.268.
  - `tests/probes/.runs/next-turn-UJqWfM` (manifest mode `next-turn`, phases `parallel,next-turn`):
    both phases judged `passed`. The parent decoded `PARENT_FINAL_OK` with `is_error: false`, empty
    `permission_denials` and `subagent_stats` `spawned` 2 / `completed` 2; each child made exactly
    two forwarded requests on a stable, distinct upstream model (`gateway/fast-worker` and
    `gateway/smart-worker`) and the parent stayed on `probe-parent-model`.
  - `tests/probes/.runs/nested-uxI3hK` (manifest mode `nested`, phase `nested`): `nested` judged
    `passed`. `PARENT_FINAL_OK`, `is_error: false`, empty `permission_denials`, `subagent_stats`
    `spawned` 3 / `max_depth` 2 / `spawned_by_subagents` 1. Alpha made two requests on a stable
    `gateway/fast-worker`; the direct beta and the grandchild beta made one each on a stable
    `gateway/smart-worker`; exactly one request carried `x-claude-code-parent-agent-id`, and it
    matched a different observed child id, not its own. This is the first observation of that header
    on 2.1.268.
  - `tests/probes/.runs/resume-D30trq` (manifest mode `resume`, phase `resume`): `resume` stays
    `pending` with `resume-insufficient-requests`. Both CLI invocations exited with
    `PARENT_FINAL_OK` and `is_error: false` under the same session id
    (`c0ffee00-0000-4000-8000-000000000000` echoed back twice), and each invocation delegated to two
    fresh children, so four distinct child ids with exactly one routed request each. Same shape as
    2.1.267's `resume-euk9s4`: the client keeps the session id and issues a new child id on
    re-delegation. Neither the judge nor the phase criterion was changed and `resume` was not
    narrowed.

  `judgeM3A` returned `passed` on all three runs (`pairCount` 4, all six per-pair booleans 4 of 4,
  zero diagnostics), reconfirming the 2.1.268 M3-A pass on three independent traffic shapes: the
  client-owned prefix blocks survived byte for byte from pre-handler to upstream on every pair and
  the parent's own messages were untouched. `M10-freshness` stays `pending` on all three
  (`freshnessHook: fake`, zero instance-fetch/register/consume/replay records), the same bootstrap
  limitation documented above. Two negative controls were run on disposable copies of the run
  directories under a temp dir, never on the saved captures: clearing `phasesExercised` returns every
  claimed phase to `pending` with `*-not-declared`, and deleting the single
  `x-claude-code-parent-agent-id` header while leaving the manifest intact returns `nested` to
  `pending` with `nested-requires-observed-parent-agent-id-header` while `M3-A` still judges
  `passed`.

  Recorded into
  [../../tests/fixtures/capabilities/claude-code-2.1.268.json](../../tests/fixtures/capabilities/claude-code-2.1.268.json):
  `writeCapabilityFixture` narrowed exactly `lifecycle.parallel: passed` and
  `lifecycle["next-turn"]: passed` from `next-turn-UJqWfM`, and `lifecycle.nested: passed` from
  `nested-uxI3hK`, one `diagnostics` entry per key naming its run, with `scaffoldDeclared` taken from
  each run's own `extractM3AEvidence` output rather than asserted by the caller. Separately, and
  under explicit operator approval, `"parentPromptPosition": "after-native-context-v2"` was added to
  that fixture by hand, because `writeCapabilityFixture` only ever writes probes, lifecycle and
  diagnostics. Nothing else in the fixture changed: the earlier `M3-A` diagnostics line is preserved
  and `status` is still `pending`.

  What is still blocked for 2.1.268: `status` stays `pending`, and `M1`, `M2`, `M3`, `M3-B2`, `M4`,
  `M10` and `M10-freshness` stay `pending` (`M3-A` is excluded from that list because it already
  `passed`). `lifecycle.resume` is `pending` for the measured reason above. `lifecycle.compaction` is
  UNMEASURED for 2.1.268: no run in this set declared or exercised it, so its `pending` is an absence
  of measurement, not an observed failed compaction. Production therefore still refuses every 2.1.268
  child request: [verified] `assertCapability(profile, 'claude-marker', ...)` against the real fixture
  throws `unsupported-path` at the first check, `capability profile claude-code 2.1.268 is pending,
  not supported`, before lifecycle or `M10` are even consulted. Declaring the layout opened the
  marker slot, not the path. The operator ruling of 2026-09-11 keeps the existing bar unchanged: with
  the lifecycle phase unknown, `assertCapability` still requires all five phases `passed`, so
  `resume` and `compaction` keep the path closed for 2.1.268 even once `status` and `M10` move.

- **M2 is `failed` for 2.1.268: the `Agent` tool's `model` parameter rejects a full model id
  before any child request is made.** [verified] four `delegate` runs on 2026-09-11 against the
  pinned binary `/Users/me/.local/share/claude/versions/2.1.268` (every parent request reports
  `claude-cli/2.1.268`), via the plain capture gateway `tests/probes/native-claude-gateway.mjs`,
  which gained one opt-in knob, `PROBE_AGENT_MODEL`, that puts a value into the scripted `Agent`
  call's `model` parameter. Control without the knob (`delegate-TPrwMe`): both children ran and
  their `clientModel` came from the agent frontmatter aliases (`claude-haiku-4-5-20251001`,
  `claude-sonnet-5`). Positive control with the alias `haiku` in the parameter (`delegate-J6ctNL`):
  both children ran on `claude-haiku-4-5-20251001`, so the parameter does override frontmatter.
  Full ids (`delegate-8EiyAy` with `gateway/probe-full-id`, `delegate-IiHhdB` with
  `claude-haiku-4-5-20251001`): the client returned a `tool_result` with `is_error: true` and
  `InputValidationError ... "code": "invalid_value", "values": ["sonnet","opus","haiku","fable"],
  "path": ["model"]` for both calls, `subagent_stats.spawned` 0, zero child requests captured,
  parent still decoded `PARENT_ROUNDTRIP_OK`. The rejection is local schema validation, not an
  upstream error: the tool schema in the captured request declares `model` as an enum of those four
  aliases, and the same enum is in the binary (`Y(["sonnet","opus","haiku","fable"]).optional()` at
  offset 168183014). So the spec's M2 question is answered negatively: a parent cannot select an
  arbitrary upstream model natively, `clientModel` is limited to alias classes, and the router's
  marker channel remains the only per-child model selection path. `writeCapabilityFixture` set
  exactly `probes.M2: failed` in
  [../../tests/fixtures/capabilities/claude-code-2.1.268.json](../../tests/fixtures/capabilities/claude-code-2.1.268.json)
  with one `diagnostics` entry naming both failing runs. Not measured: whether frontmatter `model`
  accepts a full id (the docs say yes; M2 as specified is about the call parameter), and 2.1.267.

- **`compaction` lifecycle measured for 2.1.268: the compaction fired, the boundary is real, and
  the phase is `failed`.** [verified] run `tests/probes/.runs/compaction-sbnVo0` (2026-09-12, real
  `claude` 2.1.268 driven through the loopback capture gateway). Only the reactive compactor is
  reachable from a probe, and it has two requirements the run has to meet. It decides from a
  usage-driven context estimate, so the run ramps the injected child token usage until the client
  compacts. It also needs a real text summary in the reply to the compaction request, because an
  empty summary is rejected and no boundary is produced. Both routed children compacted.

  Wire evidence: the `compact_boundary` literal appeared in 0 request bodies, pre-handler or
  upstream. What appears instead is the client's continuation wrapper. Each child's next request
  opens with a `user` message whose `content` is a plain string (not an array of blocks) starting
  `This session is being continued from a previous conversation that ran out of context.`, and that
  request's message count dropped from 11 to 4. Every request that was forwarded carried the same
  `upstreamModel` for its child, so there is no model drift anywhere in the run.

  Transcript evidence: each child's isolated transcript file gained exactly one line with
  `"subtype":"compact_boundary"`. That is the only place the literal exists. The boundary object is
  a `type:"system"` transcript message with no `message` field, and the client's API-facing readers
  skip `type:"system"`, so it can never reach a request body.

  Why the phase is `failed` and not a pass: the compacted history replaced the child's first line,
  which is where the channel-A marker lives, so the next request had no marker to select with. The
  production handler refused both post-compaction child requests with `422 missing-selection`
  (`capture/034-pre-handler.json` and `capture/035-pre-handler.json` have no paired
  post-handler-upstream record at all), and the parent's `tool_result` for each child carries
  `API Error: 422 {"error":{"code":"missing-selection"}}`. `judgeLifecyclePhase('compaction')`
  returns `failed` with `compaction-later-request-not-forwarded`, and `lifecycle.compaction` is
  recorded `failed` for 2.1.268. The marker-only path does not survive a compaction.

  What did survive: the post-compaction request carried the same `x-claude-code-agent-id` as before
  the boundary. A correlation binding keyed on that id is therefore the only known way to keep a
  child's routing across a compaction, and that channel stays closed until `M1` is ruled on.

  Judge change, RED first, in this branch: the compaction signal in
  [../../tests/probes/evidence-m10.ts](../../tests/probes/evidence-m10.ts) moved from the
  transcript-only `compact_boundary` marker to the on-the-wire wrapper (`COMPACTION_SUMMARY_PREFIX`,
  matched only at the start of a `user` message's text). The old predicate searched request bodies
  for a string that cannot appear in one, so it was unsatisfiable by construction on this client.
  The diagnostic name `compaction-requires-observed-compact-boundary` is unchanged. A second
  defect one layer down was fixed in the same change, also RED first: `readRunCapture` built its
  `pairs` only from a pre-handler record that had an upstream record beside it, so a refused
  request was dropped from the capture entirely and the judge could not see the very refusal that
  defines this failure. Refused requests now reach the lifecycle judge as `unforwarded`, while
  `pairs` keeps its forwarded-only meaning for M3-A.

No status here becomes `supported` by editing a fixture; each line needs its named measurement.
