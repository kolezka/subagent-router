// The console's in-memory event log. Bounded on purpose: this is a live view for an operator
// watching a router, not an audit trail, so it holds a fixed window and counts what fell off
// instead of growing without limit. Nothing here is written to disk and nothing survives a
// restart. Everything that lands in it is already redacted by its producer; this module only
// enforces the last rendering rule, that no stored string carries a control character.
import { escapeControl } from '../cli/output';
import type { HandlerEvent } from '../transport/handler';
import type { EventPage, RouterEvent, RouterEventKind } from './api-types';

export interface EventLogOptions {
  /** Maximum retained events. Default 500. */
  capacity?: number;
  now: () => Date;
}

/** What a caller hands to `append`. `seq` and `at` are the log's to assign, never the caller's. */
export interface EventLogInput {
  kind: RouterEventKind;
  level: RouterEvent['level'];
  message: string;
  detail?: RouterEvent['detail'];
}

const DEFAULT_CAPACITY = 500;

// Detail carries identifiers copied from a request (an agent id, a role name, a model id). They
// are rendered in a browser, so they cross the same control-character boundary the message does.
function sanitizeDetail(detail: RouterEvent['detail']): RouterEvent['detail'] {
  if (detail === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    out[key] = typeof value === 'string' ? escapeControl(value) : value;
  }
  return out as RouterEvent['detail'];
}

export class EventLog {
  private readonly capacity: number;
  private readonly clock: () => Date;
  private readonly buffer: RouterEvent[] = [];
  private readonly listeners = new Set<(event: RouterEvent) => void>();
  private nextSeq = 1;
  private droppedCount = 0;

  constructor(options: EventLogOptions) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.clock = options.now;
  }

  /** Highest seq ever appended. It is always still retained: the newest entry is never evicted. */
  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Lowest seq still held, 0 while the log is empty. A client polling below it missed events. */
  get oldestSeq(): number {
    return this.buffer[0]?.seq ?? 0;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** Appends and returns the stored event with its assigned seq. */
  append(input: EventLogInput): RouterEvent {
    const detail = sanitizeDetail(input.detail);
    const event: RouterEvent = {
      seq: this.nextSeq,
      at: this.clock().toISOString(),
      kind: input.kind,
      level: input.level,
      // escapeControl also collapses a newline to its escaped form, which is what keeps the
      // message a single line no matter what the producer handed over.
      message: escapeControl(input.message),
      ...(detail !== undefined ? { detail } : {}),
    };
    this.nextSeq += 1;
    this.buffer.push(event);
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
      this.droppedCount += 1;
    }
    // Copied first so a listener that unsubscribes itself during delivery cannot mutate the set
    // mid-iteration. A listener that throws loses only its own notification.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Intentionally empty; a broken listener must not break append or the other listeners.
      }
    }
    return event;
  }

  /** Events with seq > after, oldest first. */
  since(after: number, limit = this.capacity): EventPage {
    const events = this.buffer.filter((event) => event.seq > after).slice(0, Math.max(0, limit));
    return { events, latestSeq: this.latestSeq, oldestSeq: this.oldestSeq, dropped: this.droppedCount };
  }

  /** Registers a live listener; returns an unsubscribe function. */
  subscribe(listener: (event: RouterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function describeHandlerEvent(event: HandlerEvent): string {
  const who = event.role !== undefined ? `${event.scope} ${event.role}` : event.scope;
  if (event.kind === 'route-error') {
    const status = event.status !== undefined ? ` ${event.status}` : '';
    return `${who} ${event.path}${status} error ${event.code ?? 'unknown'} (${event.durationMs}ms)`;
  }
  if (event.decision === 'route') {
    return `${who} ${event.path} route to ${event.upstreamModel ?? 'unknown'} via ${event.source ?? 'unknown'} (${event.durationMs}ms)`;
  }
  return `${who} ${event.path} pass-through (${event.durationMs}ms)`;
}

/** Turns a HandlerEvent into a RouterEvent input. Pure. */
export function handlerEventToLogInput(event: HandlerEvent): EventLogInput {
  const detail: RouterEvent['detail'] = {
    scope: event.scope,
    path: event.path,
    durationMs: event.durationMs,
    ...(event.role !== undefined ? { role: event.role } : {}),
    ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
    ...(event.decision !== undefined ? { decision: event.decision } : {}),
    ...(event.source !== undefined ? { source: event.source } : {}),
    ...(event.upstreamModel !== undefined ? { upstreamModel: event.upstreamModel } : {}),
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
  };
  return {
    kind: event.kind,
    level: event.kind === 'route-error' ? 'error' : 'info',
    message: describeHandlerEvent(event),
    detail,
  };
}
