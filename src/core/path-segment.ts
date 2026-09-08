import { RouterError } from './errors';

// One filesystem path segment this package is willing to build a path from: a codex role name,
// an OpenCode agent name, a model alias. Anything that could change directory once joined into a
// path (a separator, `.`/`..`, a leading dot, an empty string) is refused. Pure string check, no
// filesystem access, so it stays usable from core and adapters alike.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafePathSegment(value: string): boolean {
  return value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && SAFE_PATH_SEGMENT.test(value);
}

export function assertSafePathSegment(value: string, label: string): void {
  if (!isSafePathSegment(value)) {
    throw new RouterError('export-unsafe-name', `export-unsafe-name: ${label} is not a safe path segment (${JSON.stringify(value)})`);
  }
}
