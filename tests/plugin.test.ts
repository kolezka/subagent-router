// The repository is also a Claude Code plugin and its own plugin marketplace. These tests lock the
// parts an operator cannot check by reading the manifests: the two manifests agree with
// `package.json`, every path a manifest names exists and is spawnable, and the session-start hook
// stays silent only when a real router answers. A hook that warned on a healthy session, or that
// exited non-zero, would break every session the plugin is enabled in.
import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const HEALTH_PATH = '/subagent-router/control/instance';

async function readJson(relative: string): Promise<Record<string, unknown>> {
  return (await Bun.file(join(ROOT, relative)).json()) as Record<string, unknown>;
}

interface HookRun {
  code: number;
  output: string;
}

async function runHook(baseUrl: string | undefined): Promise<HookRun> {
  const proc = Bun.spawn([join(ROOT, 'hooks', 'check-router.sh')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(baseUrl !== undefined ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: `${stdout}${stderr}` };
}

describe('plugin manifests', () => {
  test('the plugin version is the package version', async () => {
    const plugin = await readJson('.claude-plugin/plugin.json');
    const pkg = await readJson('package.json');
    expect(plugin.name).toBe('subagent-router');
    expect(plugin.version).toBe(pkg.version);
  });

  test('the marketplace lists this repository as the plugin source', async () => {
    const marketplace = (await readJson('.claude-plugin/marketplace.json')) as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    };
    expect(marketplace.owner.name.length).toBeGreaterThan(0);
    // A relative source resolves against the marketplace root, which is this repository. `./` is
    // what makes `/plugin marketplace add kolezka/subagent-router` install the plugin from the
    // same checkout instead of looking for a subdirectory that does not exist.
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'subagent-router', source: './' })]);
  });

  test('every path the plugin declares exists and is spawnable', async () => {
    const hooks = (await readJson('hooks/hooks.json')) as { hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] } };
    const entries = hooks.hooks.SessionStart.flatMap((matcher) => matcher.hooks);
    expect(entries.length).toBe(1);

    for (const entry of entries) {
      expect(entry.type).toBe('command');
      // ${CLAUDE_PLUGIN_ROOT} is the installed plugin directory; in the checkout it is the root.
      const relative = entry.command.replaceAll('"${CLAUDE_PLUGIN_ROOT}"', '').replace(/^\/+/, '');
      const mode = (await stat(join(ROOT, relative))).mode & 0o111;
      expect(`${relative} mode ${mode.toString(8)}`).toBe(`${relative} mode 111`);
    }

    const wrapper = (await stat(join(ROOT, 'bin', 'subagent-router-plugin'))).mode & 0o111;
    expect(wrapper).not.toBe(0);
  });

  test('each command carries the frontmatter description Claude Code lists it by', async () => {
    for (const command of ['commands/status.md', 'commands/setup.md']) {
      const text = await Bun.file(join(ROOT, command)).text();
      expect(`${command}: ${text.split('\n')[0]}`).toBe(`${command}: ---`);
      expect(text).toContain('\ndescription: ');
    }
  });
});

describe('the session-start hook', () => {
  test('says routing is off when the session has no base url, and still exits 0', async () => {
    const run = await runHook(undefined);
    expect(run.code).toBe(0);
    expect(run.output).toContain('routing is off');
  });

  test('warns when nothing answers at the base url, and still exits 0', async () => {
    // Port 1 is privileged and unbound here, so the connection is refused rather than timing out.
    const run = await runHook('http://127.0.0.1:1');
    expect(run.code).toBe(0);
    expect(run.output).toContain('no router answers');
  });

  test('is silent only when the control endpoint answers like a router', async () => {
    // Positive control: without it, a hook that never printed anything would pass the two warning
    // tests above by accident. The body matters, not the status code: any proxy can return 200.
    const router = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) =>
        new URL(request.url).pathname === HEALTH_PATH
          ? Response.json({ handlerInstanceId: 'test-instance' })
          : new Response('ok', { status: 200 }),
    });
    try {
      const base = `http://127.0.0.1:${router.port}`;
      const healthy = await runHook(base);
      expect(healthy.code).toBe(0);
      expect(healthy.output).toBe('');

      const notARouter = await runHook(`${base}/some-other-proxy`);
      expect(notARouter.code).toBe(0);
      expect(notARouter.output).toContain('no router answers');
    } finally {
      await router.stop(true);
    }
  });
});
