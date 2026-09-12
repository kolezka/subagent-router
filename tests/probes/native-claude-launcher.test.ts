// Hermetic test for native-claude-run.sh. Never runs claude/opencode/codex.
// The launcher + gateway are copied into a disposable fixture repo so ROOT,
// .runs, and .last-run stay isolated from the real tests/probes/ tree. The
// one literal real-client path is replaced by a fake before the copy runs;
// the substitution is asserted first, not assumed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBES_DIR = import.meta.dir;
const REAL_SCRIPT_PATH = join(PROBES_DIR, "native-claude-run.sh");
const REAL_GATEWAY_PATH = join(PROBES_DIR, "native-claude-gateway.mjs");
const REAL_CLIENT_PATH = "/Users/me/.local/bin/claude";
const FAKE_EXIT_CODE = 47;

const fixtureRoot = mkdtempSync(join(tmpdir(), "native-claude-launcher-fixture-"));
const fixtureProbesDir = join(fixtureRoot, "tests", "probes");
const fixtureHome = join(fixtureRoot, "outer-home");
const fakeClaudePath = join(fixtureRoot, "fake-claude");
// Second test double, used only to prove PROBE_CLAUDE_BIN actually redirects which binary runs.
const fakeClaude2Path = join(fixtureRoot, "fake-claude-2");
// A same-named decoy on PATH: a bare PROBE_CLAUDE_BIN must never reach it.
const decoyBinDir = join(fixtureRoot, "decoy-bin");
const decoyClaudePath = join(decoyBinDir, "fake-claude-2");
// A symlink standing in for the real installed one the client updater repoints.
const pinnedLinkPath = join(fixtureRoot, "pinned-claude-link");
// Seam dir holding a fake `timeout`, which runs between the launcher fixing its argv and exec.
const seamBinDir = join(fixtureRoot, "seam-bin");
const notExecutablePath = join(fixtureRoot, "not-executable-client");
const failingReadlinkPath = join(fixtureRoot, "fake-readlink-always-fails");
const launcherCopyPath = join(fixtureProbesDir, "native-claude-run.sh");

beforeAll(() => {
  mkdirSync(fixtureProbesDir, { recursive: true });
  mkdirSync(fixtureHome, { recursive: true });

  writeFileSync(
    fakeClaudePath,
    [
      "#!/bin/bash",
      "# Test double, never a real client.",
      'printf "FAKE_CLAUDE_1=1\\n"',
      'printf "FAKE_CLAUDE_CWD=%s\\n" "$(pwd -P)"',
      'printf "FAKE_CLAUDE_HOME=%s\\n" "$HOME"',
      'printf "FAKE_CLAUDE_CFG=%s\\n" "$CLAUDE_CONFIG_DIR"',
      // ${VAR+yes} expands to "yes" only when VAR is SET (even to an empty string), and to
      // nothing when it is unset -- the only way to tell "set to empty" apart from "absent".
      'printf "SUBAGENT_ROUTER_SECRET_PRESENT=%s\\n" "${SUBAGENT_ROUTER_SECRET+yes}"',
      `exit ${FAKE_EXIT_CODE}`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaudePath, 0o755);

  writeFileSync(
    fakeClaude2Path,
    [
      "#!/bin/bash",
      "# Second test double, never a real client.",
      'printf "FAKE_CLAUDE_2=1\\n"',
      `exit ${FAKE_EXIT_CODE}`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude2Path, 0o755);

  mkdirSync(decoyBinDir, { recursive: true });
  writeFileSync(decoyClaudePath, ['#!/bin/bash', 'printf "FAKE_CLAUDE_DECOY=1\\n"', `exit ${FAKE_EXIT_CODE}`, ''].join('\n'));
  chmodSync(decoyClaudePath, 0o755);

  writeFileSync(notExecutablePath, "#!/bin/bash\nexit 0\n");
  chmodSync(notExecutablePath, 0o644); // exists, but not executable

  writeFileSync(failingReadlinkPath, ['#!/bin/bash', '# Canonicalization always fails here.', 'exit 1', ''].join('\n'));
  chmodSync(failingReadlinkPath, 0o755);

  // Fires between the launcher choosing its argv and exec: repoints the symlink, then runs
  // whatever it was handed. A launcher that kept the symlink path lands on the new target.
  mkdirSync(seamBinDir, { recursive: true });
  writeFileSync(
    join(seamBinDir, "timeout"),
    [
      "#!/bin/bash",
      `/bin/ln -sf ${fakeClaude2Path} ${pinnedLinkPath}`,
      "shift", // drop the duration argument
      'exec "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(join(seamBinDir, "timeout"), 0o755);

  // Self-contained (only node:http/fs/path); safe to copy standalone.
  writeFileSync(join(fixtureProbesDir, "native-claude-gateway.mjs"), readFileSync(REAL_GATEWAY_PATH, "utf8"));

  const original = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(original).toContain(REAL_CLIENT_PATH); // sanity: literal still present to replace

  const patched = original.split(REAL_CLIENT_PATH).join(fakeClaudePath);
  expect(patched).not.toBe(original);
  expect(patched).not.toContain(REAL_CLIENT_PATH); // no real-client reference remains
  expect(patched).toContain(fakeClaudePath);

  writeFileSync(launcherCopyPath, patched);
  chmodSync(launcherCopyPath, 0o755);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true }); // wipes every run dir + .last-run this fixture made
});

// Explicit allowlist: PATH (to find node/python3/timeout) + fixture HOME only.
// No BASH_ENV, no NODE_OPTIONS, no credentials, no spread of process.env.
// `extra` adds only what a test explicitly names (e.g. PROBE_CLAUDE_BIN); the base
// allowlist below is unchanged.
function outerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: fixtureHome,
    ...extra,
  };
}

function runCopy(mode: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("/bin/bash", [launcherCopyPath, mode], {
    cwd: fixtureRoot,
    env: outerEnv(extraEnv),
    timeout: 20000,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const runMatch = (result.stdout ?? "").match(/^=== RUN mode=\S+ port=\d+ run=(\S+)/m);
  return { result, runDir: runMatch?.[1] };
}

// Same fixture root, so a variant computes the same ROOT and .runs as the copy it came from.
function launcherVariant(basename: string, transform: (source: string) => string): string {
  const variantPath = join(fixtureProbesDir, basename);
  const source = readFileSync(launcherCopyPath, "utf8");
  const patched = transform(source);
  expect(patched).not.toBe(source); // the seam must actually have been substituted
  writeFileSync(variantPath, patched);
  chmodSync(variantPath, 0o755);
  return variantPath;
}

function runsSnapshot(): string[] {
  const runsDir = join(fixtureProbesDir, ".runs");
  return existsSync(runsDir) ? readdirSync(runsDir) : [];
}

test("launcher runs the client from WORK and propagates its real exit code (mode=delegate)", () => {
  const { result, runDir } = runCopy("delegate");
  expect(runDir).toBeTruthy();

  const workDir = join(runDir!, "work");
  const homeDir = join(runDir!, "home");
  const cfgDir = join(runDir!, "config");
  const clientStdout = readFileSync(join(runDir!, "cli-stdout.json"), "utf8");

  const cwdMatch = clientStdout.match(/FAKE_CLAUDE_CWD=(.*)/);
  const homeMatch = clientStdout.match(/FAKE_CLAUDE_HOME=(.*)/);
  const cfgMatch = clientStdout.match(/FAKE_CLAUDE_CFG=(.*)/);
  expect(cwdMatch).toBeTruthy();
  expect(homeMatch).toBeTruthy();
  expect(cfgMatch).toBeTruthy();

  const cwd = cwdMatch?.[1];
  const home = homeMatch?.[1];
  const config = cfgMatch?.[1];
  if (cwd === undefined || home === undefined || config === undefined) {
    throw new Error("Fake client omitted an isolation field");
  }
  // Real getcwd (pwd -P), not the spoofable PWD env var.
  expect(realpathSync(cwd)).toBe(realpathSync(workDir));
  expect(home).toBe(homeDir);
  expect(config).toBe(cfgDir);
  expect(home).not.toBe(fixtureHome);

  // simple/delegate mode must never add SUBAGENT_ROUTER_SECRET to the client's env at all --
  // not even set to an empty string. That var only belongs to handler mode with the
  // production freshness hook, which needs it to sign a FreshDelegationEnvelope proof.
  expect(clientStdout).toContain('SUBAGENT_ROUTER_SECRET_PRESENT=\n');

  expect(result.status).toBe(FAKE_EXIT_CODE); // old script always exited 0 via its last echo
});

test("launcher reaches the client for simple mode too", () => {
  const { result } = runCopy("simple");
  expect(result.status).toBe(FAKE_EXIT_CODE);
});

test("launcher script parses as valid bash (syntax check only, the production hook branch is never executed here)", () => {
  const result = spawnSync("/bin/bash", ["-n", REAL_SCRIPT_PATH], { encoding: "utf8" });
  expect(result.status).toBe(0);
});

test("handler-mode production hook wrapper carries every flag parseHookArgs requires", () => {
  // Structural-text check only, per the brief: PROBE_FRESHNESS_HOOK=production can never be
  // exercised here (no real claude binary, no RUN_NATIVE_PROBES), so this asserts the wrapper
  // script's own literal source instead of running it. src/transport/claude-hook.ts's
  // parseHookArgs requires exactly these four flags (HOOK_FLAGS); a run manifest declaration
  // must also be present.
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(script).toContain("PROBE_FRESHNESS_HOOK");
  expect(script).toContain("src/transport/claude-hook.ts");
  expect(script).toContain("--config");
  expect(script).toContain("--profile-dir");
  expect(script).toContain("--client-version");
  expect(script).toContain("--control-url");
  expect(script).toContain("000-run-manifest.json");
  expect(script).toContain("phasesExercised");
  expect(script).toContain("freshnessHook");
});

test("SUBAGENT_ROUTER_SECRET is assigned exactly once, and only inside the handler+production-freshness-hook branch", () => {
  // Structural-text check for the branch that can never run here (PROBE_FRESHNESS_HOOK=production
  // needs a real claude binary + bun, per the file's other structural test above). The delegate
  // test above already proves BEHAVIORALLY that the simple/delegate branch never sets it.
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  const occurrences = script.match(/SUBAGENT_ROUTER_SECRET=/g) ?? [];
  expect(occurrences).toHaveLength(1); // never duplicated into the simple/delegate branch

  // The same guard text also opens the (unrelated) hook.sh-selection branch earlier in the
  // file; lastIndexOf targets the later, env -i-selection branch this fix actually added.
  const guardIndex = script.lastIndexOf('if is_handler_like && [ "$FRESHNESS_HOOK" = "production" ]; then');
  const elseIndex = script.indexOf("\nelse\n", guardIndex);
  const secretIndex = script.indexOf("SUBAGENT_ROUTER_SECRET=");
  expect(guardIndex).toBeGreaterThan(-1);
  expect(elseIndex).toBeGreaterThan(guardIndex);
  expect(secretIndex).toBeGreaterThan(guardIndex);
  expect(secretIndex).toBeLessThan(elseIndex); // inside the handler+production branch, not after it
});

test("next-turn mode is accepted at mode validation (fails later at fake-client version observation, same as handler mode would)", () => {
  // next-turn shares handler mode's is_handler_like branch, which needs a real `claude --version`
  // to observe the client version before it can start the bun fixture. This fixture's fake
  // client understands no flags and prints no version, so the run fails there -- never at mode
  // validation. That is enough to prove the case statement accepts "next-turn" without needing a
  // real claude binary or bun in this harness (mirrors why handler mode itself is never run
  // end-to-end here either; see the structural tests below).
  const { result } = runCopy("next-turn");
  expect(result.stderr ?? "").not.toMatch(/unknown mode/i);
  expect(result.stdout ?? "").toContain("FAIL: could not observe client version");
});

test("next-turn mode's structural additions are present and scoped to next-turn, never handler", () => {
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(script).toContain("simple|delegate|handler|next-turn");
  expect(script).toContain("is_handler_like");
  expect(script).toContain("PROBE_CHILD_READ_FILE");
  expect(script).toContain('CHILD_TOOLS_LINE="[Read]"');
  expect(script).toContain('ALLOW_JSON=\'["Agent", "Read"]\'');

  // The two Read-granting additions are gated on uses_child_read (next-turn or compaction), never
  // on is_handler_like: handler, resume and nested must still get tools: [] and no Read in the
  // allow list. compaction joined next-turn here, which is why the guard is a named predicate
  // rather than a literal mode test.
  const toolsGuardIndex = script.indexOf('if uses_child_read; then\n  CHILD_TOOLS_LINE="[Read]"');
  const allowGuardIndex = script.indexOf("if uses_child_read; then\n  ALLOW_JSON=");
  expect(toolsGuardIndex).toBeGreaterThan(-1);
  expect(allowGuardIndex).toBeGreaterThan(-1);
  expect(script).toContain('uses_child_read() { [ "$MODE" = "next-turn" ] || [ "$MODE" = "compaction" ]; }');
});

test("resume mode is accepted at mode validation (fails later at fake-client version observation, same as handler mode would)", () => {
  // resume shares handler mode's is_handler_like branch, which needs a real `claude --version`
  // to observe the client version before it can start the bun fixture. This fixture's fake
  // client understands no flags and prints no version, so the run fails there -- never at mode
  // validation. That is enough to prove the case statement accepts "resume" without needing a
  // real claude binary or bun in this harness (mirrors the next-turn test above).
  const { result } = runCopy("resume");
  expect(result.stderr ?? "").not.toMatch(/unknown mode/i);
  expect(result.stdout ?? "").toContain("FAIL: could not observe client version");
});

test("resume mode's structural additions are present and scoped to resume, never handler or next-turn", () => {
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(script).toContain("simple|delegate|handler|next-turn|resume");
  expect(script).toContain("PROBE_RESUME"); // handler-fixture opt-in that lets a resumed parent re-delegate

  // Anchor on the TWO-INVOCATION block specifically. The earlier `elif [ "$MODE" = "resume" ]`
  // (the handler dispatch branch) also contains the substring `if [ "$MODE" = "resume" ]`, so a
  // plain indexOf would match it instead. lastIndexOf lands on the actual two-invocation block,
  // which sits after the dispatch branch.
  const resumeBlockGuard = script.lastIndexOf('if [ "$MODE" = "resume" ]; then');
  expect(resumeBlockGuard).toBeGreaterThan(-1);

  // Both invocation flags must sit AFTER the block guard (inside the resume block), not in an
  // earlier comment or the dispatch branch. -c resumes the same session in invocation 2.
  expect(script.indexOf('-c -p "$PROMPT2"')).toBeGreaterThan(resumeBlockGuard);
  expect(script.indexOf('--session-id "$PROBE_SESSION_ID"')).toBeGreaterThan(resumeBlockGuard);

  // The second invocation's capture file is written exactly once, only in the resume block.
  const cli2Count = script.match(/cli2-stdout\.json/g) ?? [];
  expect(cli2Count).toHaveLength(1);
  expect(script.indexOf("cli2-stdout.json")).toBeGreaterThan(resumeBlockGuard);
});

test("resume mode rejects PROBE_FRESHNESS_HOOK=production inside the resume block", () => {
  // resume runs TWO env -i invocations that carry no SUBAGENT_ROUTER_SECRET, so the production
  // freshness hook would silently lose the secret it needs to sign a FreshDelegationEnvelope.
  // The resume block must refuse that combination up front. Structural-text check: the guard
  // text must sit inside the resume block (after its opening guard, before the single-invocation
  // handler+production branch that follows).
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  const resumeBlockGuard = script.lastIndexOf('if [ "$MODE" = "resume" ]; then');
  const rejectIndex = script.indexOf("FAIL: resume mode does not support PROBE_FRESHNESS_HOOK=production yet");
  expect(rejectIndex).toBeGreaterThan(resumeBlockGuard);
  expect(rejectIndex).toBeLessThan(script.lastIndexOf('if is_handler_like && [ "$FRESHNESS_HOOK" = "production" ]; then'));
});

test("nested mode is accepted at mode validation (fails later at fake-client version observation, same as handler mode would)", () => {
  // nested shares handler mode's is_handler_like branch, which needs a real `claude --version`
  // to observe the client version before it can start the bun fixture. This fixture's fake
  // client understands no flags and prints no version, so the run fails there -- never at mode
  // validation. That is enough to prove the case statement accepts "nested" without needing a
  // real claude binary or bun in this harness (mirrors the next-turn and resume tests above).
  const { result } = runCopy("nested");
  expect(result.stderr ?? "").not.toMatch(/unknown mode/i);
  expect(result.stdout ?? "").toContain("FAIL: could not observe client version");
});

test("nested mode's structural additions are present and scoped to nested, never handler, next-turn, or resume", () => {
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(script).toContain("simple|delegate|handler|next-turn|resume|nested");
  expect(script).toContain("PROBE_NESTED_AGENT"); // handler-fixture opt-in for the one-shot nested delegation

  // The nested dispatch branch (PROBE_NESTED_AGENT wiring) must be gated on the literal mode.
  const nestedDispatchGuard = script.lastIndexOf('elif [ "$MODE" = "nested" ]; then');
  expect(nestedDispatchGuard).toBeGreaterThan(-1);
  expect(script.indexOf('PROBE_NESTED_AGENT="native-probe-alpha"')).toBeGreaterThan(nestedDispatchGuard);

  // The per-agent tools override: exactly native-probe-alpha gets [Agent], gated on the literal
  // mode AND the agent name, so beta (and handler/next-turn/resume) keep tools: [].
  const toolsOverrideGuard = script.indexOf('if [ "$MODE" = "nested" ] && [ "$name" = "native-probe-alpha" ]; then');
  expect(toolsOverrideGuard).toBeGreaterThan(-1);
  expect(script.indexOf('AGENT_TOOLS_LINE="[Agent]"')).toBeGreaterThan(toolsOverrideGuard);

  // The [Agent] grant must never leak into the shared handler/next-turn/resume tools line: the
  // only place it is assigned is inside the nested gate (the override guard above), so the
  // shared CHILD_TOOLS_LINE stays "[Read]" (next-turn) or "[]" (everything else).
  const agentGrantCount = script.match(/AGENT_TOOLS_LINE="\[Agent\]"/g) ?? [];
  expect(agentGrantCount).toHaveLength(1);
});

test("compaction mode is accepted at mode validation (fails later at fake-client version observation, same as handler mode would)", () => {
  // compaction shares handler mode's is_handler_like branch, which needs a real `claude --version`
  // to observe the client version before it can start the bun fixture. This fixture's fake client
  // understands no flags and prints no version, so the run fails there -- never at mode
  // validation. That is enough to prove the case statement accepts "compaction" without needing a
  // real claude binary or bun in this harness (mirrors the next-turn, resume and nested tests).
  const { result } = runCopy("compaction");
  expect(result.stderr ?? "").not.toMatch(/unknown mode/i);
  expect(result.stdout ?? "").toContain("FAIL: could not observe client version");
});

test("compaction mode declares mode: compaction in the run manifest", () => {
  // Structural proof chain: the manifest heredoc writes "$MODE" verbatim, it is gated on
  // is_handler_like, and is_handler_like answers yes for compaction. The manifest itself is
  // written only after the client-version observation, which no fake client here can satisfy, so
  // this branch is unreachable behaviorally in this harness (same reason the handler-mode
  // production hook wrapper is asserted structurally above).
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(script).toContain('[ "$MODE" = "compaction" ]; }'); // the last clause of is_handler_like
  expect(script).toContain('{ "mode": "$MODE", "phasesExercised": $PHASES_JSON, "freshnessHook": "$FRESHNESS_HOOK" }');

  const manifestGuard = script.lastIndexOf("if is_handler_like; then");
  expect(manifestGuard).toBeGreaterThan(-1);
  expect(script.indexOf("000-run-manifest.json")).toBeGreaterThan(manifestGuard);
});

test("compaction mode sets both auto-compaction env vars for the client and never the disable vars", () => {
  // The whole point of the mode: auto-compaction is opt-out only in the client, so naming either
  // disable var anywhere in the launcher would silently turn off what this mode measures.
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");

  const compactionBranch = script.lastIndexOf('if [ "$MODE" = "compaction" ]; then');
  expect(compactionBranch).toBeGreaterThan(-1);
  const branchEnd = script.indexOf("\nelif is_handler_like", compactionBranch);
  expect(branchEnd).toBeGreaterThan(compactionBranch);
  const branch = script.slice(compactionBranch, branchEnd);

  // Both vars live inside the compaction invocation branch, not anywhere else in the file.
  // Anchored to the env -i continuation-line indentation so the explanatory comment above the
  // branch, which names both vars in prose, is not counted as an assignment.
  expect(branch).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000");
  expect(branch).toContain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1");
  expect(script.match(/^\s+CLAUDE_CODE_AUTO_COMPACT_WINDOW=/gm) ?? []).toHaveLength(1);
  expect(script.match(/^\s+CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=/gm) ?? []).toHaveLength(1);

  // Never assigned anywhere, in any mode. A comment naming them is fine; an assignment is not.
  expect(script).not.toMatch(/DISABLE_COMPACT=/);
  expect(script).not.toMatch(/DISABLE_AUTO_COMPACT=/);
});

test("compaction mode's child scripting reuses the forced-Read channel with more than one round", () => {
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(script).toContain("simple|delegate|handler|next-turn|resume|nested|compaction");

  // The dispatch branch reuses PROBE_CHILD_READ_FILE (next-turn's existing channel) rather than a
  // new one, and adds the rounds knob so the child still has a turn after the threshold is crossed.
  const dispatchGuard = script.indexOf('elif [ "$MODE" = "compaction" ]; then');
  expect(dispatchGuard).toBeGreaterThan(-1);
  expect(script.indexOf("PROBE_CHILD_READ_ROUNDS=2")).toBeGreaterThan(dispatchGuard);
  expect(script.match(/PROBE_CHILD_READ_ROUNDS=/g) ?? []).toHaveLength(1); // never leaks into another mode

  // The Read tool must actually be grantable for both forced-Read modes, via one shared predicate.
  expect(script).toContain('uses_child_read() { [ "$MODE" = "next-turn" ] || [ "$MODE" = "compaction" ]; }');
  expect(script).toContain("if uses_child_read; then\n  ALLOW_JSON='[\"Agent\", \"Read\"]'");
  expect(script).toContain('if uses_child_read; then\n  CHILD_TOOLS_LINE="[Read]"');
});

test("compaction mode rejects PROBE_FRESHNESS_HOOK=production inside its own branch", () => {
  // Same trap resume guards against: this branch carries no SUBAGENT_ROUTER_SECRET, so the
  // production hook would lose the secret it needs to sign a FreshDelegationEnvelope.
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  const compactionBranch = script.lastIndexOf('if [ "$MODE" = "compaction" ]; then');
  const rejectIndex = script.indexOf("FAIL: compaction mode does not support PROBE_FRESHNESS_HOOK=production yet");
  expect(rejectIndex).toBeGreaterThan(compactionBranch);
  expect(rejectIndex).toBeLessThan(script.lastIndexOf('elif is_handler_like && [ "$FRESHNESS_HOOK" = "production" ]; then'));
});

test("launcher refuses an unknown mode before touching the filesystem", () => {
  const runsDir = join(fixtureProbesDir, ".runs");
  const before = existsSync(runsDir) ? readdirSync(runsDir) : [];

  const { result, runDir } = runCopy("bogus");

  const after = existsSync(runsDir) ? readdirSync(runsDir) : [];
  expect(runDir).toBeUndefined(); // never reached the "=== RUN" line
  expect(after.filter((d) => d.startsWith("bogus-"))).toEqual([]);
  expect(after.length).toBe(before.length); // no new run dir at all
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/unknown mode/i);
});

test("PROBE_CLAUDE_BIN redirects which client binary the launcher runs (mode=delegate)", () => {
  // The point of the pin: a run must target a chosen binary, not whatever the
  // /Users/me/.local/bin/claude symlink (repointed by the client's own updater) happens to be.
  const { result, runDir } = runCopy("delegate", { PROBE_CLAUDE_BIN: fakeClaude2Path });
  expect(runDir).toBeTruthy();

  const clientStdout = readFileSync(join(runDir!, "cli-stdout.json"), "utf8");
  expect(clientStdout).toContain("FAKE_CLAUDE_2=1"); // the pinned binary ran
  expect(clientStdout).not.toContain("FAKE_CLAUDE_1=1"); // the default one did not
  expect(result.status).toBe(FAKE_EXIT_CODE);
});

test("launcher rejects a missing PROBE_CLAUDE_BIN with exit 2 and no run dir", () => {
  const before = runsSnapshot();
  const { result, runDir } = runCopy("delegate", { PROBE_CLAUDE_BIN: join(fixtureRoot, "no-such-client") });

  expect(runDir).toBeUndefined(); // never reached the "=== RUN" line
  expect(result.stdout ?? "").not.toContain("=== RUN");
  expect(result.status).toBe(2);
  expect(result.stderr ?? "").toMatch(/not executable/i);
  expect(runsSnapshot()).toEqual(before); // nothing created on disk
});

test("launcher rejects a present-but-not-executable PROBE_CLAUDE_BIN with exit 2 and no run dir", () => {
  const before = runsSnapshot();
  const { result, runDir } = runCopy("delegate", { PROBE_CLAUDE_BIN: notExecutablePath });

  expect(runDir).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stderr ?? "").toMatch(/not executable/i);
  expect(runsSnapshot()).toEqual(before);
});

test("every client invocation goes through $CLAUDE_BIN, resolved once before the first of them", () => {
  // The literal must stay present exactly once: the hermetic fixture above swaps it for a fake
  // client by plain text substitution, so zero occurrences would silently break isolation and
  // more than one would leave an un-pinned invocation behind.
  const script = readFileSync(REAL_SCRIPT_PATH, "utf8");
  expect(script).toContain('CLAUDE_BIN_SELECTED="${PROBE_CLAUDE_BIN:-/Users/me/.local/bin/claude}"');
  expect(script.split(REAL_CLIENT_PATH).length - 1).toBe(1);

  // One --version observe plus five `env -i` invocations (compaction, handler+production, default,
  // and the two resume invocations).
  const invocations = script.match(/"\$CLAUDE_BIN" (\\|--version)/g) ?? [];
  expect(invocations).toHaveLength(6);

  // Resolved exactly once, before any invocation, so a symlink moving later cannot change targets.
  expect(script.match(/\/usr\/bin\/readlink -f/g) ?? []).toHaveLength(1);
  const resolveIndex = script.indexOf("/usr/bin/readlink -f");
  expect(resolveIndex).toBeGreaterThan(-1);
  expect(resolveIndex).toBeLessThan(script.indexOf('"$CLAUDE_BIN" --version'));
  expect(resolveIndex).toBeLessThan(script.indexOf('"$TIMEOUT" 90 "$CLAUDE_BIN"'));

  // The recorded evidence is that same frozen path, never a second resolution.
  expect(script).toContain('printf \'%s\\n\' "$CLAUDE_BIN" > "$RUN/capture/client-binary"');
});

test("a relative PROBE_CLAUDE_BIN resolves against the caller cwd, not the client's work dir", () => {
  // The client runs after a `cd` into the run's work dir, so an unresolved relative path would
  // exec nothing there.
  const { result, runDir } = runCopy("delegate", { PROBE_CLAUDE_BIN: "./fake-claude-2" });
  expect(runDir).toBeTruthy();

  const clientStdout = readFileSync(join(runDir!, "cli-stdout.json"), "utf8");
  expect(clientStdout).toContain("FAKE_CLAUDE_2=1");
  expect(result.status).toBe(FAKE_EXIT_CODE);
});

test("a bare PROBE_CLAUDE_BIN resolves against the caller cwd, never a same-named binary on PATH", () => {
  const { result, runDir } = runCopy("delegate", {
    PROBE_CLAUDE_BIN: "fake-claude-2",
    PATH: `${decoyBinDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  expect(runDir).toBeTruthy();

  const clientStdout = readFileSync(join(runDir!, "cli-stdout.json"), "utf8");
  expect(clientStdout).toContain("FAKE_CLAUDE_2=1"); // the one next to the caller
  expect(clientStdout).not.toContain("FAKE_CLAUDE_DECOY=1"); // never the PATH hit
  expect(result.status).toBe(FAKE_EXIT_CODE);
});

test("a PROBE_CLAUDE_BIN symlink repointed mid-run still runs the target chosen at selection", () => {
  if (existsSync(pinnedLinkPath)) unlinkSync(pinnedLinkPath);
  symlinkSync(fakeClaudePath, pinnedLinkPath); // starts on client 1

  const { result, runDir } = runCopy("delegate", {
    PROBE_CLAUDE_BIN: pinnedLinkPath,
    PATH: `${seamBinDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  expect(runDir).toBeTruthy();

  // Positive control: the seam really did repoint the link before the client was exec'd, so a
  // launcher that re-resolved at exec time would have landed on client 2.
  expect(readlinkSync(pinnedLinkPath)).toBe(fakeClaude2Path);

  const clientStdout = readFileSync(join(runDir!, "cli-stdout.json"), "utf8");
  expect(clientStdout).toContain("FAKE_CLAUDE_1=1");
  expect(clientStdout).not.toContain("FAKE_CLAUDE_2=1");
  expect(result.status).toBe(FAKE_EXIT_CODE);
});

test("launcher exits 2 without running any client when canonicalization fails", () => {
  // Seam lives only in this disposable variant; the real readlink is never touched.
  const variant = launcherVariant("native-claude-run-readlink-fails.sh", (source) =>
    source.split("/usr/bin/readlink").join(failingReadlinkPath),
  );
  const before = runsSnapshot();

  const result = spawnSync("/bin/bash", [variant, "delegate"], {
    cwd: fixtureRoot,
    env: outerEnv(),
    timeout: 20000,
    encoding: "utf8",
  });

  expect(result.status).toBe(2); // never the fake client's exit code
  expect(result.stdout ?? "").not.toContain("=== RUN");
  expect(result.stderr ?? "").toMatch(/could not resolve/i);
  expect(runsSnapshot()).toEqual(before);
});
