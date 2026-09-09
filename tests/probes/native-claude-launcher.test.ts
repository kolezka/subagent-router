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

  expect(result.status).toBe(FAKE_EXIT_CODE); // old script always exited 0 via its last echo
});

test("launcher reaches the client for simple mode too", () => {
  const { result } = runCopy("simple");
  expect(result.status).toBe(FAKE_EXIT_CODE);
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
