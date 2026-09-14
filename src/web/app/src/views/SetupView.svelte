<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import Health from '../lib/Health.svelte';
  import Badge from '../lib/Badge.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Loading from '../lib/Loading.svelte';
  import Empty from '../lib/Empty.svelte';
  import EnvTable from '../lib/EnvTable.svelte';
  import CopyButton from '../lib/CopyButton.svelte';
  import ConfirmButton from '../lib/ConfirmButton.svelte';
  import { getDetect, initConfig, syncCatalog, startRouter, install, type ApiFailure } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import { parseNameList, toPositiveInt } from '../lib/format';
  import type { DetectReport, SyncPayload, InstallResult, ConfigInitRequest } from '../../../api-types';

  let detect = $state<DetectReport | null>(null);
  let detectError = $state<ApiFailure | null>(null);
  let detectLoading = $state(false);
  let probing = $state(false);

  let status = $derived(store.status);
  let configDone = $derived(status !== null && status.configHealth === 'ok');
  let snapshotDone = $derived(status !== null && status.snapshot.present);
  let routerDone = $derived(status !== null && status.router.running);

  async function loadDetect(probe: boolean): Promise<void> {
    if (probe) probing = true;
    else detectLoading = true;
    const result = await getDetect(probe);
    probing = false;
    detectLoading = false;
    if (result.ok) {
      detect = result.value;
      detectError = null;
      return;
    }
    detectError = result.error;
  }

  $effect(() => {
    if (detect === null && !detectLoading && detectError === null) void loadDetect(false);
  });

  // --- Step 2: config -----------------------------------------------------

  let scope = $state<'project' | 'home'>('project');
  let sourceId = $state('operator-gateway');
  let endpointPath = $state('/v1/models');
  let gatewayUrlEnv = $state('ROUTER_GATEWAY_URL');
  let gatewayHeadersEnv = $state('ROUTER_GATEWAY_HEADERS');
  let modelsBaseUrlEnv = $state('ROUTER_GATEWAY_URL');
  let modelsAuthEnv = $state('ROUTER_MODELS_AUTH');
  let modelsHeadersEnv = $state('');
  let correlationSecretEnv = $state('ROUTER_SECRET');
  let initBusy = $state(false);
  let initError = $state<ApiFailure | null>(null);
  let initMessage = $state('');

  async function submitInit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    initBusy = true;
    initError = null;
    initMessage = 'Writing the config file...';
    const body: ConfigInitRequest = {
      scope,
      gatewayUrlEnv: gatewayUrlEnv.trim(),
      gatewayHeadersEnv: parseNameList(gatewayHeadersEnv),
      modelsBaseUrlEnv: modelsBaseUrlEnv.trim(),
      ...(modelsAuthEnv.trim() !== '' ? { modelsAuthEnv: modelsAuthEnv.trim() } : {}),
      modelsHeadersEnv: parseNameList(modelsHeadersEnv),
      correlationSecretEnv: correlationSecretEnv.trim(),
      sourceId: sourceId.trim(),
      endpointPath: endpointPath.trim(),
    };
    const result = await initConfig(body);
    initBusy = false;
    if (!result.ok) {
      initError = result.error;
      initMessage = '';
      return;
    }
    initMessage = result.value.created
      ? `Config written to ${result.value.configPath}.`
      : `Config already existed at ${result.value.configPath}, nothing was overwritten.`;
    await store.refresh();
    await loadDetect(false);
  }

  // --- Step 3: sync -------------------------------------------------------

  let syncBusy = $state(false);
  let syncError = $state<ApiFailure | null>(null);
  let syncResult = $state<SyncPayload | null>(null);

  async function runSync(dryRun: boolean): Promise<void> {
    syncBusy = true;
    syncError = null;
    const result = await syncCatalog({ dryRun });
    syncBusy = false;
    if (!result.ok) {
      syncError = result.error;
      return;
    }
    syncResult = result.value;
    await store.refresh();
  }

  // --- Step 4: router -----------------------------------------------------

  let routerPort = $state('');
  let routerHost = $state('');
  let routerClaudeVersion = $state('');
  let routerBusy = $state(false);
  let routerError = $state<ApiFailure | null>(null);
  let routerMessage = $state('');

  async function runStart(): Promise<void> {
    routerBusy = true;
    routerError = null;
    routerMessage = 'Starting the router...';
    const port = toPositiveInt(routerPort);
    const result = await startRouter({
      ...(port !== undefined ? { port } : {}),
      ...(routerHost.trim() !== '' ? { host: routerHost.trim() } : {}),
      ...(routerClaudeVersion.trim() !== '' ? { claudeVersion: routerClaudeVersion.trim() } : {}),
    });
    routerBusy = false;
    if (!result.ok) {
      routerError = result.error;
      routerMessage = '';
      return;
    }
    routerMessage = result.value.running ? `Router running at ${result.value.url ?? 'unknown URL'}.` : 'Router did not start.';
    await store.refresh();
  }

  // --- Step 5: connect ----------------------------------------------------

  let bundleOutput = $state('./router-bundle');
  let bundleClaudeVersion = $state('');
  let installBusy = $state(false);
  let installError = $state<ApiFailure | null>(null);
  let installResult = $state<InstallResult | null>(null);

  async function runInstall(dryRun: boolean): Promise<void> {
    installBusy = true;
    installError = null;
    const result = await install({
      output: bundleOutput.trim(),
      ...(bundleClaudeVersion.trim() !== '' ? { claudeVersion: bundleClaudeVersion.trim() } : {}),
      dryRun,
    });
    installBusy = false;
    if (!result.ok) {
      installError = result.error;
      return;
    }
    installResult = result.value;
  }

  let launcherCommand = $derived(installResult === null ? '' : `${installResult.output.replace(/\/$/, '')}/claude-router`);
  let manualCommand = $derived(
    installResult === null ? '' : `claude --settings ${installResult.output.replace(/\/$/, '')}/settings.json`,
  );

  /** An export line for a probed gateway. The console shows it; the operator's shell holds it. */
  function exportLine(name: string, url: string): string {
    return `export ${name === '' ? 'ROUTER_GATEWAY_URL' : name}="${url}"`;
  }
</script>

<div class="stack">
  <Panel title="What this wizard does">
    <p class="intro">
      Five steps from a clean machine to a Claude Code session whose subagents route to the models you
      choose. Each step reports whether it is already done, so this page is safe to reopen at any point.
    </p>
  </Panel>

  <!-- Step 1 ------------------------------------------------------------- -->
  <Panel title="Step 1. Detect what is installed">
    {#snippet actions()}
      <button type="button" onclick={() => loadDetect(false)} disabled={detectLoading}>
        {detectLoading ? 'Detecting' : 'Re-run detection'}
      </button>
    {/snippet}

    {#if detectError !== null}
      <ErrorBox error={detectError} onreload={() => loadDetect(false)} />
    {:else if detect === null}
      <Loading label="Detecting clients, agent roots and environment" />
    {:else}
      <div class="stack">
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Binary</th>
                <th scope="col">Version</th>
                <th scope="col">Profile</th>
                <th scope="col">Agent roots</th>
              </tr>
            </thead>
            <tbody>
              {#each detect.clients as client (client.client)}
                <tr>
                  <td>{client.client}</td>
                  <td class="mono">{client.binary ?? 'not installed'}</td>
                  <td class="mono">{client.version ?? '-'}</td>
                  <td><Badge tone={client.profileStatus === 'supported' ? 'ok' : 'warn'} label={client.profileStatus} /></td>
                  <td>
                    {#if client.agentRoots.length === 0}
                      <span class="muted">none</span>
                    {:else}
                      {#each client.agentRoots as root (root.path)}
                        <div><span class="mono">{root.path}</span> <span class="muted">({root.agentCount})</span></div>
                      {/each}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <EnvTable env={detect.env} />

        <div class="row center">
          <button type="button" onclick={() => loadDetect(true)} disabled={probing}>
            {probing ? 'Probing' : 'Probe local gateways'}
          </button>
          <span class="muted">Loopback addresses only. The probe asks each port for its model list.</span>
        </div>

        {#if detect.gateways !== null}
          {#if detect.gateways.length === 0}
            <Empty label="No local gateway answered." hint="Start your gateway, then probe again, or point the config at a remote one." />
          {:else}
            <div class="table-scroll">
              <table>
                <caption class="muted">
                  A gateway URL is a value, so the console never stores it. Put it in the shell that starts the
                  router, under the variable name you choose in step 2.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Gateway</th>
                    <th scope="col">URL</th>
                    <th scope="col">Models</th>
                    <th scope="col">Shell line</th>
                  </tr>
                </thead>
                <tbody>
                  {#each detect.gateways as gateway (gateway.url)}
                    <tr>
                      <td>{gateway.label}</td>
                      <td class="mono">{gateway.url}</td>
                      <td>{gateway.modelCount}</td>
                      <td><CopyButton text={exportLine(gatewayUrlEnv, gateway.url)} label="Copy export line" /></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </Panel>

  <!-- Step 2 ------------------------------------------------------------- -->
  <Panel title="Step 2. Write the config">
    {#snippet actions()}
      {#if configDone}<Health tone="ok" label="already done" detail={status?.configPath} />{/if}
    {/snippet}

    {#if configDone}
      <p class="note">
        A valid config already exists at <span class="mono">{status?.configPath}</span>. Edit it on the Gateway
        view rather than writing a new one here.
      </p>
    {:else}
      <form class="stack" onsubmit={submitInit}>
        <p class="explain">
          The console stores environment variable <strong>names</strong> and never their values: the gateway URL,
          tokens and headers live in the shell that starts the router, and no endpoint here returns one.
        </p>

        <div class="grid">
          <label class="field">
            <span>Gateway URL variable</span>
            <input type="text" bind:value={gatewayUrlEnv} required />
          </label>
          <label class="field">
            <span>Gateway header variables (comma separated)</span>
            <input type="text" bind:value={gatewayHeadersEnv} />
          </label>
          <label class="field">
            <span>Models base URL variable</span>
            <input type="text" bind:value={modelsBaseUrlEnv} required />
          </label>
          <label class="field">
            <span>Models auth variable (optional)</span>
            <input type="text" bind:value={modelsAuthEnv} />
          </label>
          <label class="field">
            <span>Models header variables (comma separated)</span>
            <input type="text" bind:value={modelsHeadersEnv} />
          </label>
          <label class="field">
            <span>Correlation secret variable</span>
            <input type="text" bind:value={correlationSecretEnv} required />
          </label>
          <label class="field">
            <span>Source id</span>
            <input type="text" bind:value={sourceId} required />
          </label>
          <label class="field">
            <span>Models endpoint path</span>
            <input type="text" bind:value={endpointPath} required />
          </label>
          <label class="field">
            <span>Where to write it</span>
            <select bind:value={scope}>
              <option value="project">Project (next to the current directory)</option>
              <option value="home">Home (~/.subagent-router)</option>
            </select>
          </label>
        </div>

        <div class="row center">
          <button type="submit" class="primary" disabled={initBusy}>{initBusy ? 'Writing' : 'Write config'}</button>
          <span class="muted" aria-live="polite">{initMessage}</span>
        </div>
      </form>
      {#if initError !== null}
        <ErrorBox error={initError} onreload={() => store.refresh()} />
      {/if}
    {/if}
  </Panel>

  <!-- Step 3 ------------------------------------------------------------- -->
  <Panel title="Step 3. Sync the model catalog">
    {#snippet actions()}
      {#if snapshotDone}
        <Health tone={status?.snapshot.stale === true ? 'warn' : 'ok'} label={status?.snapshot.stale === true ? 'done, stale' : 'already done'} detail={`${status?.snapshot.modelCount ?? 0} models`} />
      {/if}
    {/snippet}

    <p class="note">
      This is the only step that reaches the network. It asks the configured model source for its catalog and
      writes <span class="mono">models.lock.json</span>.
    </p>
    <div class="row center">
      <button type="button" disabled={syncBusy || !configDone} onclick={() => runSync(true)}>Preview (dry run)</button>
      <ConfirmButton
        label="Sync catalog"
        question="This contacts the model source and overwrites models.lock.json."
        confirmLabel="Sync now"
        disabled={syncBusy || !configDone}
        onconfirm={() => runSync(false)}
      />
      {#if !configDone}<span class="muted">Write a config first.</span>{/if}
      {#if syncBusy}<span class="muted" aria-live="polite">Contacting the model source...</span>{/if}
    </div>

    {#if syncError !== null}
      <ErrorBox error={syncError} onreload={() => store.refresh()} />
    {/if}
    {#if syncResult !== null}
      <div class="sync-result" aria-live="polite">
        <p>
          {syncResult.dryRun ? 'Dry run, nothing was written.' : 'Snapshot written.'}
          Added {syncResult.added.length}, changed {syncResult.changed.length}, missing {syncResult.missing.length}.
        </p>
        <div class="grid">
          {#each [['Added', syncResult.added], ['Changed', syncResult.changed], ['Missing', syncResult.missing]] as [label, items] (label)}
            <div>
              <p class="sub">{label}</p>
              {#if items.length === 0}
                <p class="muted">none</p>
              {:else}
                <ul class="plain">
                  {#each items as item (item)}<li class="mono">{item}</li>{/each}
                </ul>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </Panel>

  <!-- Step 4 ------------------------------------------------------------- -->
  <Panel title="Step 4. Start the router">
    {#snippet actions()}
      {#if routerDone}<Health tone="ok" label="already done" detail={status?.router.url ?? ''} />{/if}
    {/snippet}

    <div class="row">
      <label class="field"><span>Port</span><input type="text" inputmode="numeric" bind:value={routerPort} placeholder="8787" size="6" /></label>
      <label class="field"><span>Host</span><input type="text" bind:value={routerHost} placeholder="127.0.0.1" size="12" /></label>
      <label class="field"><span>Claude version</span><input type="text" bind:value={routerClaudeVersion} placeholder="2.1.270" size="10" /></label>
      <button type="button" class="primary" disabled={routerBusy || routerDone || !snapshotDone} onclick={runStart}>
        {routerBusy ? 'Starting' : 'Start router'}
      </button>
      {#if !snapshotDone}<span class="muted">Sync the catalog first.</span>{/if}
    </div>
    <p class="action-status" aria-live="polite">{routerMessage}</p>
    {#if routerError !== null}
      <ErrorBox error={routerError} onreload={() => store.refresh()} />
    {/if}
  </Panel>

  <!-- Step 5 ------------------------------------------------------------- -->
  <Panel title="Step 5. Connect Claude Code">
    <p class="explain">
      This generates a bundle in a directory you name. Nothing in your own Claude Code configuration is edited:
      the bundle is used by passing it on the command line.
    </p>
    <div class="row">
      <label class="field"><span>Output directory</span><input type="text" bind:value={bundleOutput} required size="28" /></label>
      <label class="field"><span>Claude version</span><input type="text" bind:value={bundleClaudeVersion} placeholder="2.1.270" size="10" /></label>
      <button type="button" disabled={installBusy} onclick={() => runInstall(true)}>Preview (dry run)</button>
      <ConfirmButton
        label="Generate bundle"
        question="Files in the output directory with these names will be written."
        confirmLabel="Generate"
        disabled={installBusy}
        onconfirm={() => runInstall(false)}
      />
    </div>

    {#if installError !== null}
      <ErrorBox error={installError} onreload={() => store.refresh()} />
    {/if}
    {#if installResult !== null}
      <div class="stack result" aria-live="polite">
        <p>
          {installResult.dryRun ? 'Dry run: these files would be written.' : 'Bundle written.'}
          Router URL <span class="mono">{installResult.routerUrl}</span>.
        </p>
        <ul class="plain">
          {#each installResult.files as file (file)}<li class="mono">{file}</li>{/each}
        </ul>
        <div class="commands">
          <div class="command">
            <p class="sub">1. Start Claude Code through the launcher</p>
            <div class="row center tight">
              <code>{launcherCommand}</code>
              <CopyButton text={launcherCommand} />
            </div>
          </div>
          <div class="command">
            <p class="sub">2. Or, without the launcher</p>
            <div class="row center tight">
              <code>{manualCommand}</code>
              <CopyButton text={manualCommand} />
            </div>
          </div>
        </div>
        <p class="note">
          The launcher checks that the router answers, then runs Claude Code with the bundle's settings file.
          <span class="mono">--settings</span> applies to that invocation only.
        </p>
      </div>
    {/if}
  </Panel>
</div>

<style>
  .intro,
  .explain {
    margin: 0;
    font-size: var(--size-3);
    max-width: 76ch;
  }

  .explain {
    color: var(--muted);
  }

  .sub {
    margin: 0 0 var(--space-1) 0;
    font-size: var(--size-2);
    color: var(--muted);
    font-weight: 600;
  }

  .sync-result,
  .result {
    margin-top: var(--space-3);
    font-size: var(--size-3);
  }

  .sync-result p {
    margin: 0 0 var(--space-2) 0;
  }

  .action-status {
    margin: var(--space-2) 0 0 0;
    font-size: var(--size-3);
    color: var(--muted);
    min-height: 1.2em;
  }

  .commands {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  code {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    padding: 4px 8px;
    word-break: break-all;
  }

  caption {
    text-align: left;
    padding-bottom: var(--space-2);
  }
</style>
