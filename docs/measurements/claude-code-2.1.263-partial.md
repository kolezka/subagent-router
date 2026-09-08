# Claude Code 2.1.263: partial historical review

Reviewed 2026-09-08 against `.superpowers/sdd/recovery-and-merge/historical-evidence.json`
(coordinator-validated). This is a review of pre-existing historical artifacts, not a new
native run and not a capability promotion. No probe status in
[../transport/GAPS.md](../transport/GAPS.md) or any capabilities fixture changes because of
this note.

Reported client billing version in the artifacts: `2.1.263.269`.

## What the artifacts show

- **Parent request field, and a separate canned result.** The parent request's model field was
  the fixed probe placeholder `probe-parent-model`, the same value in both the before and after
  captures, not a real model id. `decoded_final_result: PARENT_ROUNDTRIP_OK` is a canned success
  sentinel written by the probe script, not an echo of any model name.
- **Child model observations (two children).** Each child's decoded tool-result echo matched
  its requested model exactly:
  - `native-probe-alpha` requested `claude-haiku-4-5-20251001`, echoed
    `CHILD_SAW_MODEL=claude-haiku-4-5-20251001`.
  - `native-probe-beta` requested `claude-sonnet-5`, echoed
    `CHILD_SAW_MODEL=claude-sonnet-5`.
- **Hook/request agent-id matching.** For both children, the SubagentStart hook payload's
  agent id matched the corresponding request's agent id (`hook_and_request_agent_id_match:
  true`). The actual id values are not reproduced here.
- **Hook-context location.** For both children, hook context appeared in the messages
  channel, not the system channel (`hook_context_in_system: false`,
  `hook_context_in_messages: true`).
- **Working directory is the worker checkout, not the intended run directory.** For both
  children, `hook_cwd_is_throwaway_work_directory: false`: the hook ran in the worker's own
  checkout directory, not the shared throwaway run/work directory the harness intends. This is
  not a claim about per-child directory isolation.

## Explicitly unproven by this review

The matching hook/request agent ids and matching hook-context location are partial
observations, not proof: they do not satisfy or close the M1, M3/M3-B2, M4 or M10/freshness
gates. Identifier entropy (M1), the router's own handling path, and lifecycle/freshness stay
unproven, and no provider behavior was measured. Per the source artifact's own recorded limits:

- Historical artifact inspection only, not a new native run.
- No router-handler proof.
- No identifier entropy proof (M1).
- No lifecycle or freshness proof (M10).
- No provider behavior proof.
- No capability promotion.

See [../transport/GAPS.md](../transport/GAPS.md) for the full standing gap list this review
does not close.

## Locally retained artifacts (not shipped, not backed up)

The source captures these observations were read from are retained only on the machine that
ran the historical review, as relative paths under the run directory, with their sha256
checksums for local integrity checking. Neither the captures nor absolute paths to them are
reproduced here.

| Relative path | sha256 |
| --- | --- |
| `capture/003-parent_first.json` | `319def41e29c30ce569074cb8bb5cb9348de55d0e01e5dcaad7a1e01a4163a9b` |
| `capture/004-child.json` | `99dfbd09a3e23cde97de649daa92a3694651be18940415ccc2da3354b36c4e11` |
| `capture/005-child.json` | `ac680eaeb66db679224be16f6de9051685a090e9b62f7e2e0a3c6be2db945ab6` |
| `capture/006-parent_final.json` | `4713bb33c6cdb22f70e789cd18cf2ffe7fe08963de60b89a96db6f653ee602f5` |
| `capture/hook-subagentstart-70505.json` | `a0215c04e6559326a82f0e2616cf1304580e25c4458b128f02f63c6f9dcb0f28` |
| `capture/hook-subagentstart-70506.json` | `40bc90ec6e2b0d5a2607c36e40d9f111a2c5e985bd929499f8c83f813d179a84` |
| `cli-stdout.json` | `769f1d1f92b270982fcc0fa04b1b8b137858268343a339bf75a5831ab8cfb7b5` |
