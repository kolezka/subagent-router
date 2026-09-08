// Real-client probe: launches the installed opencode CLI (v1.18.29) against a local
// loopback mock gateway and exercises the actual `tool.execute.before` plugin hook.
//
// SCOPE — read this before trusting what passing means:
// This proves the OpenCode native hook MECHANISM (registration, args shape,
// throw-to-deny semantics) works against a real installed build. The plugin used
// here (opencode-deny-plugin.js) is a standalone demo that hardcodes two
// subagent_type values to deny — it is NOT subagent-router's adapter, does not
// consult its config/catalog/capability profile, and this test proves NOTHING
// about subagent-router's own adapter code or about its M6-runtime capability
// probe for that adapter. It only proves opencode's own hook contract.
//
// Opt-in: skipped by default. Run with RUN_NATIVE_PROBES=1 to actually launch
// the real opencode binary. When skipped, no directory, process, or network
// resource is touched at module scope.
//
// Isolation: env passed to every spawned process is an explicit allowlist, not
// ...process.env — real ANTHROPIC/OPENAI keys, real CODEX_HOME/CLAUDE_* config
// dirs, and real XDG_CONFIG_HOME never reach the child. HOME/PWD/OPENCODE_TEST_HOME
// all point into a throwaway directory under this worktree (not the OS tmpdir).
// The mock gateway binds port 0 (OS-assigned) and echoes a random token in a
// response header so readiness polling can confirm it is talking to the
// instance this test started, not an unrelated process on a guessed port.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const RUN_NATIVE = process.env.RUN_NATIVE_PROBES === "1";

if (!RUN_NATIVE) {
  test.skip("opencode native probe (skipped: set RUN_NATIVE_PROBES=1 to run the real installed opencode CLI)", () => {});
} else {
  const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const root = join(import.meta.dir, ".native-probe-tmp", runId);
  const home = join(root, "home");
  const project = join(root, "project");
  const reqLog = join(root, "requests.log");
  const pluginLog = join(root, "plugin.log");
  const gatewayToken = randomBytes(8).toString("hex");

  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(reqLog, "");
  writeFileSync(pluginLog, "");

  const pluginPath = join(root, "deny-plugin.js");
  writeFileSync(
    pluginPath,
    readFileSync(join(import.meta.dir, "opencode-deny-plugin.js"), "utf8").replace(
      "/tmp/oc_trial/plugin.log",
      pluginLog,
    ),
  );

  // Explicit allowlist only — no ...process.env spread. Nothing from the real
  // environment leaks in: no real ANTHROPIC_API_KEY/OPENAI_API_KEY, no real
  // CODEX_HOME/CLAUDE_* config dirs, no real XDG_CONFIG_HOME/OPENCODE_CONFIG*.
  //
  // HOME is passed through at its REAL value, not overridden to the isolated
  // dir — deliberately. This is a directory path needed so bun can resolve its
  // own already-cached npm package (~/.bun/install/cache), not a credential or
  // an opencode/claude config source: opencode itself never reads real HOME for
  // its own state, because OPENCODE_TEST_HOME unconditionally overrides that
  // (packages/core/src/global.ts: `home: OPENCODE_TEST_HOME ?? os.homedir()`).
  // Overriding HOME to the throwaway dir was tried first and broke bun's module
  // resolution, causing it to attempt a network install and time out under the
  // sandbox (ETIMEDOUT) — confirmed by reproducing it directly.
  function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      PWD: project, // opencode resolves its project root from PWD, not just spawn cwd
      OPENCODE_TEST_HOME: home,
      OPENCODE_API_KEY: "dummy-local-key", // fake key only, never a real credential
      ...extra,
    };
  }

  let serverProc: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    const proc = spawn("python3", [join(import.meta.dir, "opencode-mock-gateway.py"), "0"], {
      env: isolatedEnv({ MOCK_GATEWAY_LOG: reqLog, MOCK_GATEWAY_TOKEN: gatewayToken }),
    });
    serverProc = proc;

    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock gateway did not announce a port in time")), 5000);
      let buf = "";
      proc.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        const match = buf.match(/LISTENING:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      proc.on("error", reject);
      proc.on("exit", (code) => reject(new Error(`mock gateway exited early with code ${code}`)));
    });

    // Confirm readiness AND identity: the response must carry this run's token,
    // proving we are talking to the instance we just spawned, not a stray
    // process that happened to already be bound to the same ephemeral port.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
        if (res.ok && res.headers.get("x-mock-gateway-token") === gatewayToken) {
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
      if (Date.now() >= deadline) throw new Error("mock gateway did not become ready with the expected token");
    }

    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          mockgw: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${port}/v1` },
            models: { "mock-model": {} },
          },
        },
        plugin: [pluginPath],
        agent: { reviewer: { mode: "subagent", description: "Reviews code", model: "mockgw/mock-model" } },
      }),
    );
  });

  afterAll(() => {
    serverProc?.kill();
    if (!process.env.KEEP_NATIVE_PROBE_TMP) rmSync(root, { recursive: true, force: true });
  });

  function countRequests(): number {
    if (!existsSync(reqLog)) return 0;
    return (readFileSync(reqLog, "utf8").match(/^PATH=/gm) ?? []).length;
  }

  // opencode --format json prints one pretty-printed (multi-line) JSON object
  // per event, not compact NDJSON, so split on brace balance rather than lines.
  function parseEvents(stdout: string): any[] {
    const events: any[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < stdout.length; i++) {
      const c = stdout[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "{") { if (depth === 0) start = i; depth++; }
      else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          try { events.push(JSON.parse(stdout.slice(start, i + 1))); } catch {}
          start = -1;
        }
      }
    }
    return events;
  }

  function findToolUse(events: any[], predicate: (state: any) => boolean): any | undefined {
    for (const ev of events) {
      if (ev?.type === "tool_use" && ev?.part?.type === "tool" && predicate(ev.part.state)) return ev.part;
    }
    return undefined;
  }

  function runOpencode(userMessage: string, timeoutMs = 20000) {
    const result = spawnSync(
      "opencode",
      ["run", userMessage, "--agent", "build", "--model", "mockgw/mock-model", "--format", "json"],
      { cwd: project, env: isolatedEnv(), timeout: timeoutMs, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    return result;
  }

  test("opencode: real tool.execute.before hook throw denies unknown subagent variant before any child session exists", () => {
    const before = countRequests();
    const result = runOpencode("spawn:reviewer@ghost");
    const after = countRequests();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const events = parseEvents(result.stdout ?? "");
    expect(events.length).toBeGreaterThan(0);

    const denied = findToolUse(events, (s) => s?.status === "error");
    expect(denied).toBeDefined();
    expect(denied.input?.subagent_type).toBe("reviewer@ghost");
    expect(denied.state?.error ?? denied.error).toBe("subagent-router: unknown-model (reviewer@ghost)");

    // No tool_use event may carry child-session metadata: the denial must have
    // happened before any child session was created, not merely been reported
    // as an error after the fact.
    const anyChildSession = events.some((ev) => ev?.part?.state?.metadata?.parentSessionId);
    expect(anyChildSession).toBe(false);

    const plugin = readFileSync(pluginLog, "utf8");
    expect(plugin).toContain("tool.execute.before called tool=task");
    expect(plugin).toContain("DENYING via throw for subagent_type=reviewer@ghost");

    expect(after).toBeGreaterThan(before); // gateway stayed reachable; denial wasn't a network failure
  }, 30000); // real opencode CLI turn; bun's default 5s test timeout is too short

  test("positive control: an allowed subagent_type actually spawns a distinct child session", () => {
    const before = countRequests();
    const result = runOpencode("spawn:reviewer");
    const after = countRequests();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const events = parseEvents(result.stdout ?? "");
    const completed = findToolUse(events, (s) => s?.status === "completed");
    expect(completed).toBeDefined();

    const metadata = completed.state?.metadata ?? completed.metadata;
    expect(metadata?.parentSessionId).toBeTruthy();
    expect(metadata?.sessionId).toBeTruthy();
    expect(metadata.parentSessionId).not.toBe(metadata.sessionId);

    // The child session made its own real HTTP round trip against the gateway.
    expect(after).toBeGreaterThan(before);
  }, 30000);
}
