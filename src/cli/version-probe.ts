/** Upper bound on a version probe. A client binary that hangs must not hang the CLI. */
export const VERSION_PROBE_TIMEOUT_MS = 2_000;

/**
 * Bounded, local version probe: spawns `<binary> --version` and returns the first dotted-numeric
 * token it prints.
 *
 * This is the ONLY form of version detection in the package. It never contacts a provider and
 * never spends a token; it only runs a local binary the operator already has. It is not called at
 * startup or at import: a command asks for it explicitly, and only when the operator did not pass
 * a version.
 *
 * Returns `undefined` — never throws and never exits — when the binary is missing, times out,
 * fails, or prints nothing version-shaped. An unknown version is a reportable condition (a
 * `doctor` line), not a fatal error, so every offline command keeps working without it.
 *
 * The returned string is only ever used to LOOK UP a measured capability profile. It is not
 * evidence of anything by itself: a binary that prints a version whose profile says `pending`
 * stays pending, and no version string can promote a capability to supported.
 */
export async function detectClientVersion(binary: string, timeoutMs: number = VERSION_PROBE_TIMEOUT_MS): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const timer = setTimeout(() => {
      proc.kill();
    }, timeoutMs);
    try {
      const text = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) return undefined;
      return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1];
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}
