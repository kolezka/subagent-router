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
    // The read itself is raced against the deadline, not only signalled. Signalling alone does not
    // bound this call: a binary that traps SIGTERM, or one that exits while a grandchild still
    // holds the inherited stdout pipe, leaves the read pending and hangs every caller, including
    // the console's /api/detect. SIGKILL cannot be trapped.
    //
    // The stream is read through an explicit reader so the deadline can also cancel it. Returning
    // from the race is not enough on its own: an open read keeps the pipe, and the pipe keeps the
    // event loop, so `doctor` printed its answer in 301 ms and then sat there for the 30 s the
    // grandchild lived (measured 2026-09-19 against a `sleep 30 &; exit 0` wrapper).
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const read = (async () => {
      let text = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      const exitCode = await proc.exited;
      if (exitCode !== 0) return undefined;
      return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1];
    })().catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        void reader.cancel().catch(() => undefined);
        resolve(undefined);
      }, timeoutMs);
    });
    try {
      return await Promise.race([read, deadline]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}
