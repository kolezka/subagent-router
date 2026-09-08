// Runnable check for detectClientVersion. Imports the probe module directly (not src/bun.ts,
// which also pulls the still-unwritten CLI), so it runs today.
//
// It proves the probe is bounded and non-fatal: a real binary yields a version, a missing binary
// and a version-less binary both yield undefined rather than throwing, and a hanging binary is
// killed at the timeout instead of blocking the CLI forever.
import { detectClientVersion } from '../../src/cli/version-probe';

const real = await detectClientVersion('bun');
if (real === undefined || !/^\d+\.\d+\.\d+$/.test(real)) throw new Error(`expected a dotted version from bun, got ${String(real)}`);

const missing = await detectClientVersion('subagent-router-no-such-binary-xyz');
if (missing !== undefined) throw new Error(`missing binary must yield undefined, got ${String(missing)}`);

const junk = await detectClientVersion('true');
if (junk !== undefined) throw new Error(`version-less output must yield undefined, got ${String(junk)}`);

const started = Date.now();
const hung = await detectClientVersion('sleep', 300);
const elapsed = Date.now() - started;
if (hung !== undefined) throw new Error('a hanging probe must not report a version');
if (elapsed > 2000) throw new Error(`probe did not honour its timeout: ${elapsed}ms`);

console.log(JSON.stringify({ real, missing, junk, hung, elapsedMs: elapsed }));
