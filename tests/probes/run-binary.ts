import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ProbeResult } from '../../src/core/types';

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function isInsideRun(runDir: string, path: string): Promise<boolean> {
  try {
    const [realRunDir, realPath] = await Promise.all([realpath(runDir), realpath(path)]);
    const pathFromRun = relative(resolve(realRunDir), resolve(realPath));
    return pathFromRun !== '' && !pathFromRun.startsWith('..') && !isAbsolute(pathFromRun);
  } catch {
    return false;
  }
}

export interface RunBinaryIdentity {
  result: ProbeResult;
  diagnostic?: string;
}

// A version string and matching snippets in another executable do not identify this run.
export async function verifyRunBinary(runDir: string, inspectedBinaryPath: string | undefined): Promise<RunBinaryIdentity> {
  if (inspectedBinaryPath === undefined) {
    return { result: 'pending', diagnostic: 'binary-identity-expected-binary-missing: no verified expected binary exists for this observed version' };
  }

  let executedPath: string;
  let capturedDigest: string;
  try {
    executedPath = (await readFile(join(runDir, 'capture', 'client-binary'), 'utf8')).trim();
    capturedDigest = (await readFile(join(runDir, 'capture', 'client-binary.sha256'), 'utf8')).trim();
  } catch (error) {
    if (isMissing(error)) return { result: 'pending', diagnostic: 'binary-identity-missing: no executable digest was recorded when the run began' };
    throw error;
  }
  if (!isAbsolute(executedPath) || !(await isInsideRun(runDir, executedPath)) || !/^[a-f0-9]{64}$/.test(capturedDigest)) {
    return { result: 'pending', diagnostic: 'binary-identity-missing: capture-time executable identity is incomplete or not run-local' };
  }

  try {
    const [executedDigest, inspectedDigest] = await Promise.all([digestFile(executedPath), digestFile(inspectedBinaryPath)]);
    if (executedDigest !== capturedDigest || inspectedDigest !== capturedDigest) {
      return { result: 'pending', diagnostic: 'binary-digest-mismatch: the captured executable and the inspected binary are not the same bytes' };
    }
  } catch (error) {
    if (isMissing(error)) return { result: 'pending', diagnostic: 'binary-unavailable: the captured executable or inspected binary cannot be read' };
    throw error;
  }
  return { result: 'passed' };
}
