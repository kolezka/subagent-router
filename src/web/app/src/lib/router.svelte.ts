/** Hash routing. Eight fixed views, no library: the console has no dynamic segments to parse. */

export const VIEWS = ['status', 'setup', 'gateway', 'models', 'routing', 'install', 'logs', 'diagnostics'] as const;

export type ViewId = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<ViewId, string> = {
  status: 'Status',
  setup: 'Setup',
  gateway: 'Gateway',
  models: 'Models',
  routing: 'Routing',
  install: 'Install',
  logs: 'Logs',
  diagnostics: 'Diagnostics',
};

function parseHash(hash: string): ViewId {
  const name = hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';
  return (VIEWS as readonly string[]).includes(name) ? (name as ViewId) : 'status';
}

class HashRouter {
  current = $state<ViewId>('status');

  start(): () => void {
    const sync = () => {
      this.current = parseHash(window.location.hash);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }
}

export const router = new HashRouter();

export function hrefFor(view: ViewId): string {
  return `#/${view}`;
}
