// Runs `work`, then `cleanup`, and keeps the right error primary. A plain `try/finally` whose
// finally block throws replaces the original failure with the cleanup failure, so the operator
// sees "could not remove temp file" instead of the write error that caused it. Here the work
// error always wins; a cleanup error is attached to it as `suppressed` (readable through
// `suppressedErrors`) rather than dropped. A cleanup error after successful work still throws.
const SUPPRESSED = Symbol.for('subagent-router.suppressed');

interface WithSuppressed {
  [SUPPRESSED]?: unknown[];
}

export function suppressedErrors(error: unknown): unknown[] {
  if (typeof error !== 'object' || error === null) return [];
  return (error as WithSuppressed)[SUPPRESSED] ?? [];
}

function attachSuppressed(primary: unknown, suppressed: unknown): unknown {
  // A thrown non-object (a string, a number) or a frozen/sealed object cannot carry the
  // attachment; writing to it would throw a TypeError that replaces the real failure. Those are
  // wrapped once, with the original kept as `cause`.
  const canCarry = typeof primary === 'object' && primary !== null && Object.isExtensible(primary);
  const carrier: unknown = canCarry ? primary : new Error(String(primary), { cause: primary });
  const list = ((carrier as WithSuppressed)[SUPPRESSED] ??= []);
  list.push(suppressed);
  return carrier;
}

export async function runWithCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (workError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw attachSuppressed(workError, cleanupError);
    }
    throw workError;
  }
  await cleanup();
  return result;
}
