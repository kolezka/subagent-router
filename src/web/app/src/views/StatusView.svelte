<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import Health from '../lib/Health.svelte';
  import Badge from '../lib/Badge.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Loading from '../lib/Loading.svelte';
  import Empty from '../lib/Empty.svelte';
  import Findings from '../lib/Findings.svelte';
  import EnvTable from '../lib/EnvTable.svelte';
  import ConfirmButton from '../lib/ConfirmButton.svelte';
  import { getDetect, startRouter, stopRouter, restartRouter, type ApiFailure } from '../lib/api';
  import { store, pollWhileVisible } from '../lib/store.svelte';
  import { formatTime, relativeAge, toPositiveInt } from '../lib/format';
  import type { DetectReport, RouterStartRequest } from '../../../api-types';

  let detect = $state<DetectReport | null>(null);
  let detectError = $state<ApiFailure | null>(null);
  let now = $state(Date.now());

  let port = $state('');
  let host = $state('');
  let claudeVersion = $state('');
  let busy = $state(false);
  let actionError = $state<ApiFailure | null>(null);
  let actionMessage = $state('');

  let status = $derived(store.status);

  async function loadDetect(): Promise<void> {
    const result = await getDetect(false);
    if (result.ok) {
      detect = result.value;
      detectError = null;
      return;
    }
    detectError = result.error;
  }

  // Five seconds while visible; pollWhileVisible stops the timer when the tab goes to the
  // background, so an open console does not keep re-reading the config file all day.
  $effect(() => {
    return pollWhileVisible(() => {
      now = Date.now();
      void store.refresh();
      void loadDetect();
    }, 5000);
  });

  function startRequest(): RouterStartRequest {
    const parsedPort = toPositiveInt(port);
    return {
      ...(parsedPort !== undefined ? { port: parsedPort } : {}),
      ...(host.trim() !== '' ? { host: host.trim() } : {}),
      ...(claudeVersion.trim() !== '' ? { claudeVersion: claudeVersion.trim() } : {}),
    };
  }

  async function runAction(name: string, call: () => ReturnType<typeof stopRouter>): Promise<void> {
    busy = true;
    actionError = null;
    actionMessage = `${name}...`;
    const result = await call();
    busy = false;
    if (!result.ok) {
      actionError = result.error;
      actionMessage = '';
      return;
    }
    const router = result.value;
    actionMessage = router.running
      ? `Router running at ${router.url ?? 'unknown URL'}.`
      : `Router stopped.${router.lastError !== null ? ` Last error: ${router.lastError}` : ''}`;
    await store.refresh();
  }

  let snapshotTone = $derived(
    status === null ? 'idle' : !status.snapshot.present ? 'bad' : status.snapshot.stale ? 'warn' : 'ok',
  );
  let snapshotLabel = $derived(
    status === null ? 'unknown' : !status.snapshot.present ? 'missing' : status.snapshot.stale ? 'stale' : 'present',
  );
  let configTone = $derived(
    status === null ? 'idle' : status.configHealth === 'ok' ? 'ok' : status.configHealth === 'missing' ? 'warn' : 'bad',
  );
</script>

<div class="stack">
  {#if store.error !== null}
    <ErrorBox error={store.error} onreload={() => store.refresh()} />
  {/if}

  {#if status === null && store.error === null}
    <Loading label="Reading system status" />
  {:else if status !== null}
    <div class="grid">
      <Panel title="Config">
        <div class="kv"><span class="k">Health</span><span class="v"><Health tone={configTone as 'ok' | 'warn' | 'bad' | 'idle'} label={status.configHealth} /></span></div>
        <div class="kv"><span class="k">Path</span><span class="v mono">{status.configPath}</span></div>
        <div class="kv"><span class="k">Generation</span><span class="v mono">{status.generation ?? 'none'}</span></div>
        {#if status.configError !== null}
          <div class="kv"><span class="k">Error code</span><span class="v bad-text mono">{status.configError}</span></div>
        {/if}
      </Panel>

      <Panel title="Model snapshot">
        <div class="kv"><span class="k">State</span><span class="v"><Health tone={snapshotTone as 'ok' | 'warn' | 'bad' | 'idle'} label={snapshotLabel} /></span></div>
        <div class="kv">
          <span class="k">Fetched</span>
          <span class="v">{formatTime(status.snapshot.fetchedAt)} <span class="muted">({relativeAge(status.snapshot.fetchedAt, now)})</span></span>
        </div>
        <div class="kv"><span class="k">Models</span><span class="v">{status.snapshot.modelCount ?? 'unknown'}</span></div>
      </Panel>

      <Panel title="Console">
        <div class="kv"><span class="k">URL</span><span class="v mono">{status.console.url}</span></div>
        <div class="kv"><span class="k">Version</span><span class="v">{status.version}</span></div>
        <div class="kv">
          <span class="k">Mode</span>
          <span class="v"><Badge tone={status.console.readOnly ? 'warn' : 'info'} label={status.console.readOnly ? 'read only' : 'read write'} /></span>
        </div>
      </Panel>
    </div>

    <Panel title="Router">
      <div class="kv">
        <span class="k">State</span>
        <span class="v">
          <Health
            tone={status.router.running ? (status.router.stale ? 'warn' : 'ok') : 'idle'}
            label={status.router.running ? 'running' : 'stopped'}
          />
          {#if status.router.stale}<Badge tone="warn" label="stale: config changed after start" />{/if}
          {#if status.router.owner !== 'none'}<Badge label={status.router.owner} />{/if}
        </span>
      </div>
      <div class="kv"><span class="k">URL</span><span class="v mono">{status.router.url ?? '-'}</span></div>
      <div class="kv"><span class="k">Serving generation</span><span class="v mono">{status.router.generation ?? '-'}</span></div>
      <div class="kv"><span class="k">Started</span><span class="v">{formatTime(status.router.startedAt)}</span></div>
      {#if status.router.lastError !== null}
        <div class="kv"><span class="k">Last error</span><span class="v bad-text mono">{status.router.lastError}</span></div>
      {/if}

      <div class="row controls">
        <label class="field">
          <span>Port</span>
          <input type="text" inputmode="numeric" bind:value={port} placeholder={String(status.router.port ?? 8787)} size="6" />
        </label>
        <label class="field">
          <span>Host</span>
          <input type="text" bind:value={host} placeholder={status.router.host ?? '127.0.0.1'} size="12" />
        </label>
        <label class="field">
          <span>Claude version</span>
          <input type="text" bind:value={claudeVersion} placeholder="2.1.270" size="10" />
        </label>
        <button type="button" class="primary" disabled={busy || status.router.running} onclick={() => runAction('Starting the router', () => startRouter(startRequest()))}>
          Start
        </button>
        <button type="button" disabled={busy || !status.router.running} onclick={() => runAction('Stopping the router', () => stopRouter())}>
          Stop
        </button>
        <ConfirmButton
          label="Restart"
          question="Restarting drops every in-flight request the router is handling."
          confirmLabel="Restart the router"
          disabled={busy}
          onconfirm={() => runAction('Restarting the router', () => restartRouter(startRequest()))}
        />
      </div>
      <p class="note">
        The router reads its environment from the shell that started this console. A start with a missing gateway
        variable fails with the variable's name, never its value.
      </p>
      <p class="action-status" aria-live="polite">{actionMessage}</p>
      {#if actionError !== null}
        <ErrorBox error={actionError} onreload={() => store.refresh()} />
      {/if}
    </Panel>

    <Panel title="Config check">
      <Findings problems={status.problems} warnings={status.warnings} emptyLabel="config check found no problems." />
    </Panel>

    <Panel title="Environment variables">
      <EnvTable env={status.env} />
    </Panel>
  {/if}

  <Panel title="Detected clients">
    {#if detectError !== null}
      <ErrorBox error={detectError} onreload={() => loadDetect()} />
    {:else if detect === null}
      <Loading label="Detecting clients" />
    {:else if detect.clients.length === 0}
      <Empty label="No clients detected." hint="Install Claude Code, OpenCode or Codex on this machine, then refresh." />
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Installed</th>
              <th scope="col">Version</th>
              <th scope="col">Capability profile</th>
              <th scope="col">Agent roots</th>
            </tr>
          </thead>
          <tbody>
            {#each detect.clients as client (client.client)}
              <tr>
                <td>{client.client}</td>
                <td>
                  <Health tone={client.binary === null ? 'idle' : 'ok'} label={client.binary === null ? 'not found' : 'installed'} />
                </td>
                <td class="mono">{client.version ?? '-'}</td>
                <td>
                  <Health
                    tone={client.profileStatus === 'supported' ? 'ok' : client.profileStatus === 'unsupported' ? 'bad' : 'warn'}
                    label={client.profileStatus}
                  />
                </td>
                <td>
                  {#if client.agentRoots.length === 0}
                    <span class="muted">none</span>
                  {:else}
                    <ul class="roots">
                      {#each client.agentRoots as root (root.path)}
                        <li><span class="mono">{root.path}</span> <span class="muted">{root.scope}, {root.agentCount} agents</span></li>
                      {/each}
                    </ul>
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
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .action-status {
    margin: var(--space-2) 0 0 0;
    font-size: var(--size-3);
    color: var(--muted);
    min-height: 1.2em;
  }

  ul.roots {
    margin: 0;
    padding-left: 16px;
    font-size: var(--size-2);
  }
</style>
