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
  realpathSync,
  rmSync,
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
const launcherCopyPath = join(fixtureProbesDir, "native-claude-run.sh");

beforeAll(() => {
  mkdirSync(fixtureProbesDir, { recursive: true });
  mkdirSync(fixtureHome, { recursive: true });

  writeFileSync(
    fakeClaudePath,
    [
      "#!/bin/bash",
      "# Test double, never a real client.",
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
function outerEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: fixtureHome,
  };
}

function runCopy(mode: string) {
  const result = spawnSync("/bin/bash", [launcherCopyPath, mode], {
    cwd: fixtureRoot,
    env: outerEnv(),
    timeout: 20000,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const runMatch = (result.stdout ?? "").match(/^=== RUN mode=\S+ port=\d+ run=(\S+)/m);
  return { result, runDir: runMatch?.[1] };
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

  // The two mode-specific additions are gated on the literal mode, never on is_handler_like:
  // handler mode itself must still get tools: [] and no Read in the allow list.
  const toolsGuardIndex = script.indexOf('if [ "$MODE" = "next-turn" ]; then\n  CHILD_TOOLS_LINE="[Read]"');
  const allowGuardIndex = script.indexOf('if [ "$MODE" = "next-turn" ]; then\n  ALLOW_JSON=');
  expect(toolsGuardIndex).toBeGreaterThan(-1);
  expect(allowGuardIndex).toBeGreaterThan(-1);
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
