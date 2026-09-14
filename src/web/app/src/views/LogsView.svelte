<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import Badge from '../lib/Badge.svelte';
  import Health from '../lib/Health.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Empty from '../lib/Empty.svelte';
  import { EVENT_STREAM_PATH, getEvents, type ApiFailure } from '../lib/api';
  import { formatClock } from '../lib/format';
  import type { RouterEvent } from '../../../api-types';

  /** Ring cap. An operator-tool log view that grows without bound eventually kills the tab. */
  const MAX_EVENTS = 2000;
  const POLL_INTERVAL_MS = 2000;

  let events = $state<RouterEvent[]>([]);
  let paused = $state(false);
  let transport = $state<'connecting' | 'stream' | 'polling' | 'paused'>('connecting');
  let dropped = $state(0);
  let gapNotice = $state('');
  let pollError = $state<ApiFailure | null>(null);

  let levelFilter = $state<'all' | 'info' | 'warn' | 'error'>('all');
  let textFilter = $state('');

  // Plain variable, deliberately not $state: the connection effect must not re-run on every event.
  let cursor = 0;

  function accept(event: RouterEvent): void {
    if (event.seq <= cursor) return;
    if (cursor > 0 && event.seq > cursor + 1) {
      gapNotice = `Sequence jumped from ${cursor} to ${event.seq}. Events in between never reached this page.`;
    }
    cursor = event.seq;
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  function isRouterEvent(value: unknown): value is RouterEvent {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.seq === 'number' && typeof candidate.at === 'string' && typeof candidate.message === 'string';
  }

  $effect(() => {
    if (paused) {
      transport = 'paused';
      return;
    }

    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function pollOnce(): Promise<void> {
      const result = await getEvents(cursor);
      if (stopped) return;
      if (!result.ok) {
        pollError = result.error;
        return;
      }
      pollError = null;
      const page = result.value;
      dropped = page.dropped;
      // oldestSeq above our cursor means the server's buffer rolled past what we had read.
      if (cursor > 0 && page.oldestSeq > cursor + 1) {
        gapNotice = `The server buffer no longer holds events ${cursor + 1} to ${page.oldestSeq - 1}. They are gone.`;
      }
      for (const event of page.events) accept(event);
      if (page.latestSeq > cursor) cursor = page.latestSeq;
    }

    function startPolling(): void {
      if (stopped || timer !== null) return;
      transport = 'polling';
      void pollOnce();
      timer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    }

    function startStream(): void {
      transport = 'connecting';
      const stream = new EventSource(EVENT_STREAM_PATH);
      source = stream;
      stream.onopen = () => {
        if (stopped) return;
        transport = 'stream';
      };
      stream.onmessage = (message: MessageEvent<string>) => {
        if (stopped) return;
        try {
          const parsed: unknown = JSON.parse(message.data);
          if (isRouterEvent(parsed)) accept(parsed);
        } catch {
          // A malformed frame is not a reason to tear down a working stream; skip it.
        }
      };
      stream.onerror = () => {
        if (stopped) return;
        // EventSource retries on its own, but a server that closed the endpoint would leave the
        // view silently empty. Close it and poll, which reports its own failures out loud.
        stream.close();
        source = null;
        startPolling();
      };
    }

    // Catch up on anything the buffer already holds, then follow live.
    void pollOnce().then(() => {
      if (!stopped) startStream();
    });

    return () => {
      stopped = true;
      if (source !== null) source.close();
      if (timer !== null) clearInterval(timer);
    };
  });

  let visible = $derived.by(() => {
    const needle = textFilter.trim().toLowerCase();
    return events.filter((event) => {
      if (levelFilter !== 'all' && event.level !== levelFilter) return false;
      if (needle === '') return true;
      const detail = event.detail ?? {};
      const haystack = [event.kind, event.message, detail.role, detail.agentId, detail.decision, detail.source, detail.upstreamModel, detail.code]
        .filter((part) => typeof part === 'string')
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  });

  let transportTone = $derived(
    transport === 'stream' ? 'ok' : transport === 'polling' ? 'warn' : transport === 'paused' ? 'idle' : 'warn',
  );
  let transportLabel = $derived(
    transport === 'stream'
      ? 'live stream'
      : transport === 'polling'
        ? 'polling, stream unavailable'
        : transport === 'paused'
          ? 'paused'
          : 'connecting',
  );

  function clear(): void {
    events = [];
    gapNotice = '';
  }
</script>

<div class="stack">
  <Panel title="Activity">
    {#snippet actions()}
      <Health tone={transportTone as 'ok' | 'warn' | 'bad' | 'idle'} label={transportLabel} />
      <button type="button" onclick={() => (paused = !paused)}>{paused ? 'Resume' : 'Pause'}</button>
      <button type="button" onclick={clear} disabled={events.length === 0}>Clear</button>
    {/snippet}

    {#if dropped > 0}
      <p class="alarm" role="alert">
        The router's event buffer overflowed and dropped {dropped}
        {dropped === 1 ? 'event' : 'events'}. What you see below is incomplete.
      </p>
    {/if}
    {#if gapNotice !== ''}
      <p class="alarm" role="alert">{gapNotice}</p>
    {/if}
    {#if pollError !== null}
      <ErrorBox error={pollError} />
    {/if}

    <div class="row center controls">
      <label class="field">
        <span>Level</span>
        <select bind:value={levelFilter}>
          <option value="all">all</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </label>
      <label class="field">
        <span>Text</span>
        <input type="search" bind:value={textFilter} placeholder="message, agent, role, model" size="30" />
      </label>
      <span class="spacer"></span>
      <span class="muted">{visible.length} of {events.length} shown{paused ? ', paused' : ''}</span>
    </div>

    {#if events.length === 0}
      <Empty
        label={paused ? 'Paused, nothing is being collected.' : 'No events yet.'}
        hint="Route a subagent through a running router and the decision appears here."
      />
    {:else if visible.length === 0}
      <Empty label="No event matches the current filters." />
    {:else}
      <div class="table-scroll log">
        <table>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Level</th>
              <th scope="col">Kind</th>
              <th scope="col">Message</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {#each visible as event (event.seq)}
              <tr>
                <td class="mono nowrap">{formatClock(event.at)}</td>
                <td>
                  <Badge tone={event.level === 'error' ? 'bad' : event.level === 'warn' ? 'warn' : 'idle'} label={event.level} />
                </td>
                <td class="nowrap">{event.kind}</td>
                <td>{event.message}</td>
                <td class="detail">
                  {#if event.detail !== undefined}
                    {#each [['role', event.detail.role], ['agent', event.detail.agentId], ['decision', event.detail.decision], ['source', event.detail.source], ['upstream', event.detail.upstreamModel], ['code', event.detail.code], ['status', event.detail.status], ['ms', event.detail.durationMs]] as [key, value] (key)}
                      {#if value !== undefined}
                        <span class="pair"><span class="pk">{key}</span><span class="pv mono">{value}</span></span>
                      {/if}
                    {/each}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Panel>
</div>

<style>
  .controls {
    margin-bottom: var(--space-3);
  }

  .alarm {
    margin: 0 0 var(--space-3) 0;
    border: 1px solid var(--amber);
    border-radius: var(--radius-1);
    padding: var(--space-2) var(--space-3);
    color: var(--amber);
    font-size: var(--size-3);
  }

  .log {
    max-height: 65vh;
    overflow-y: auto;
  }

  .nowrap {
    white-space: nowrap;
  }

  .detail {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .pair {
    display: inline-flex;
    gap: var(--space-1);
    font-size: var(--size-2);
  }

  .pk {
    color: var(--muted);
  }
</style>
