/** Small display helpers. Nothing here touches the network or the API envelope. */
import type { EnvVarReport } from '../../../api-types';

const PURPOSE_LABELS: Record<EnvVarReport['purpose'], string> = {
  'gateway-url': 'Gateway URL',
  'gateway-headers': 'Gateway headers',
  'models-base-url': 'Models base URL',
  'models-auth': 'Models auth',
  'models-headers': 'Models headers',
  'correlation-secret': 'Correlation secret',
};

export function purposeLabel(purpose: EnvVarReport['purpose']): string {
  return PURPOSE_LABELS[purpose];
}

/** ISO timestamp to something readable in the operator's own locale, or a plain dash. */
export function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export function formatClock(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString();
}

export function relativeAge(value: string | null | undefined, now: number): string {
  if (value === null || value === undefined || value === '') return 'never';
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return value;
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Splits a comma or whitespace separated list of env var names into a clean array. */
export function parseNameList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function joinNameList(names: readonly string[]): string {
  return names.join(', ');
}

export function toPositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
