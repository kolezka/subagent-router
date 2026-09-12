import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHANNEL_A_AGENTS, PARENT_CLIENT_MODEL } from './native-claude-handler';

const [captureDir, upstreamCaptureDir, profilePath, clientVersion] = process.argv.slice(2);
if (captureDir === undefined || upstreamCaptureDir === undefined || profilePath === undefined || clientVersion === undefined) {
  throw new Error('usage: packaged-serve-capture.ts <capture-dir> <upstream-capture-dir> <profile-path> <client-version>');
}

const preDir = join(captureDir, 'packaged-pre');
const postDir = join(upstreamCaptureDir, 'packaged-post');
const entries = await readdir(preDir);
await writeFile(join(captureDir, '001-profile.json'), await readFile(profilePath));
await writeFile(join(captureDir, '001-profile-scaffold.json'), JSON.stringify({ overriddenPaths: [] }));
await writeFile(
  join(captureDir, 'route-expectations.json'),
  JSON.stringify({
    client: 'claude-code',
    version: clientVersion,
    parentModel: PARENT_CLIENT_MODEL,
    childModelsByType: Object.fromEntries(CHANNEL_A_AGENTS.map((agent) => [agent.name, agent.upstreamModel])),
  }, null, 2),
);

let sequence = 1;
for (const entry of entries.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))) {
  if (!entry.endsWith('.json')) continue;
  const record = await readFile(join(preDir, entry));
  await writeFile(join(captureDir, `${String(++sequence).padStart(3, '0')}-pre-handler.json`), record);
  try {
    const post = await readFile(join(postDir, entry));
    await writeFile(join(captureDir, `${String(++sequence).padStart(3, '0')}-post-handler-upstream.json`), post);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}
