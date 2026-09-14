/**
 * One shared read of `/api/system/status`, because every view needs the generation and several
 * need the health lights. Holding it in one place means a mutation cannot be sent with a
 * generation some other view happened to load ten minutes ago.
 */
import { getSystemStatus, type ApiFailure } from './api';
import type { SystemStatus } from '../../../api-types';

class ConsoleStore {
  status = $state<SystemStatus | null>(null);
  error = $state<ApiFailure | null>(null);
  loading = $state(false);
  loadedAt = $state<number | null>(null);

  /** The generation every write carries. Null until a status or config load succeeds. */
  get generation(): string | null {
    return this.status?.generation ?? null;
  }

  async refresh(): Promise<void> {
    this.loading = true;
    const result = await getSystemStatus();
    this.loading = false;
    this.loadedAt = Date.now();
    if (result.ok) {
      this.status = result.value;
      this.error = null;
      return;
    }
    // The previous status is kept on screen; replacing it with nothing would hide the last known
    // good reading behind a transient failure.
    this.error = result.error;
  }
}

export const store = new ConsoleStore();

/**
 * Runs `tick` every `intervalMs` while the tab is visible, and once immediately. Returns a stop
 * function for the caller's $effect cleanup. Polling a hidden tab burns the operator's CPU and
 * keeps a config file being edited under constant read load.
 */
export function pollWhileVisible(tick: () => void, intervalMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (timer !== null) return;
    timer = setInterval(tick, intervalMs);
  };
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (document.hidden) {
      stop();
      return;
    }
    tick();
    start();
  };

  tick();
  if (!document.hidden) start();
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
