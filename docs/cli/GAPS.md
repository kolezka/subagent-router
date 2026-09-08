---
block: cli
doc: GAPS
verified_against: 0480ec2e5403d400cd3e1252fa5886923a01b062
verified_on: 2026-09-08
---

# CLI gaps and unverified paths

Read this before treating anything in CONTRACTS.md or INVARIANTS.md as proof of a working native
integration. None of it is.

## No native runtime proof anywhere in this block

Every capability profile this CLI can load (`loadProfile`, `loadTransportProfile`) is measured
against fixtures or ships `pending`. `doctor`, `config check` and `serve` all show `unknown` or
refuse to start rather than promise a native client actually works. `config export`'s fragments
(`settings-fragment.json`, `plugin-fragment.json`, `pretooluse-fragment.json`) are naming-only
references for manual integration: they name the built hook/plugin entrypoint and the right paths,
but nothing in this CLI confirms a real Claude Code, OpenCode or Codex process ever read them,
merged them, or behaved differently because of them. The Codex fragment says so explicitly in its
own `_status` field (`M7 pending`); the same caveat applies to Claude and OpenCode even though
their fragments do not repeat it inline.

## `tests/probes/run.ts`'s evidence helpers are still not a certification path

`tests/probes/run.ts` contains early probe infrastructure for measuring real client capability
profiles. `judgeM1` and `judgeCodexDeny` now fail closed: neither can return `'passed'` from
aggregate counts alone anymore (a sample count matching a request count, or a model field plus
zero captured requests, is refused as proof and reported `'pending'`; their `'failed'` branches
are unchanged). That closes the specific over-certification gap this document used to flag here.

It does not mean measurement is complete. No harness-specific proof extractor is wired for any
client or probe; `main()`'s own comment says so directly. Every shipped client capability profile
(`claude-code-2.1.263.json`, `opencode-1.18.29.json`, `codex-pending.json`) and every shipped
non-raw `bun-fetch` transport profile still ships `'pending'`; the one exception is
`transport-bun-fetch-raw-1.4.2.json`, which has a real passing measurement
(`tests/adapters/capabilities.test.ts`) for the raw transport layer only, never for a native
client's own runtime behavior. Real proof producers (an actual
`EntropyProof`/`OpencodeHookEvidence`/`CodexHookEvidence` from a real client run) remain missing.
Do not use `tests/probes/run.ts` output, on its own, to mark a client profile `supported` in a
shipped `dist/capabilities/*.json` file. Building those real proof producers is scoped out of this
task; it belongs to the probe/measurement work item that owns that file, not to this CLI
integration pass.

## `config export`'s sidecar does not prove native load

A sidecar's `configHash`/`snapshotHash`/`snapshotGeneration`/`artifacts` fields describe the export
itself: what was loaded and what bytes were written. They are not evidence that any native runtime
later read the same generation, resolved the same effective model, or even opened the exported
directory. That confirmation (native resolver parity with core's decision) is explicitly deferred
to later measurement work (M6-runtime, M7) per the design spec.

## No CLI command confirms a real client adopted an exported artifact

There is no `config export --verify` or equivalent that spawns a real client and checks it picked
up the exported fragment. Building one requires a measured native resolver first (see above); until
then, "the export ran successfully" and "a client is using this" are two separate, unlinked claims,
and this documentation does not conflate them.

## Stale claims already fixed elsewhere in this task

Prior to this change, `docs/gateways/cliproxyapi.md` and `docs/poc.md` both stated that `models
sync` and the CLI export command did not exist. Both are now implemented and both docs have been
updated to reflect that. Native-client routing through either path remains unmeasured; see each
document's own "Native-client status" section.
