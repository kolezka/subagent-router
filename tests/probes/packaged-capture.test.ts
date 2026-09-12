import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

test('packaged captures preserve numeric request order and declare no profile overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'packaged-capture-order-'));
  const capture = join(dir, 'capture');
  const upstream = join(dir, 'upstream');
  await mkdir(join(capture, 'packaged-pre'), { recursive: true });
  await mkdir(join(upstream, 'packaged-post'), { recursive: true });
  const profile = join(dir, 'profile.json');
  await writeFile(profile, JSON.stringify({ client: 'claude-code', version: '9.9.9' }));
  for (const id of [1, 2, 10]) {
    const record = { captureRequestId: `request-${id}`, url: '/v1/messages', headers: {}, body: { model: 'parent' } };
    await writeFile(join(capture, 'packaged-pre', `request-${id}.json`), JSON.stringify(record));
    await writeFile(join(upstream, 'packaged-post', `request-${id}.json`), JSON.stringify(record));
  }
  const result = Bun.spawnSync([process.execPath, join(ROOT, 'tests/probes/packaged-serve-capture.ts'), capture, upstream, profile, '9.9.9']);
  expect(result.exitCode).toBe(0);
  const files = (await readdir(capture)).filter((name) => name.endsWith('-pre-handler.json')).sort();
  const ids = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(capture, name), 'utf8')).captureRequestId));
  expect(ids).toEqual(['request-1', 'request-2', 'request-10']);
  expect((await readdir(capture)).includes('001-profile-scaffold.json')).toBe(true);
  expect(JSON.parse(await readFile(join(capture, '001-profile-scaffold.json'), 'utf8'))).toEqual({ overriddenPaths: [] });
});

test('packaged resume materializes invocation-one captures before taking its boundary', async () => {
  const script = await readFile(join(ROOT, 'tests/probes/native-claude-run.sh'), 'utf8');
  const firstComplete = script.indexOf('echo "exit-inv1=$CLI1_EXIT"');
  const boundary = script.indexOf('BOUNDARY_SEQ=', firstComplete);
  expect(firstComplete).toBeGreaterThan(-1);
  expect(boundary).toBeGreaterThan(firstComplete);
  expect(script.slice(firstComplete, boundary)).toContain('assemble_packaged_capture');
});
