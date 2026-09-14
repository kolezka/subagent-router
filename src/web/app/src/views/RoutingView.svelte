<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import Badge from '../lib/Badge.svelte';
  import Health from '../lib/Health.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Loading from '../lib/Loading.svelte';
  import Empty from '../lib/Empty.svelte';
  import {
    CLIENT_IDS,
    getAgents,
    getConfig,
    getModels,
    getRoutePreview,
    setDefaults,
    setRole,
    type ApiFailure,
    type RoutePreviewResult,
  } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import type { AgentsPayload, ClientId, ConfigPayload, ModelsPayload } from '../../../api-types';

  let client = $state<ClientId>('claude-code');

  let agents = $state<AgentsPayload | null>(null);
  let agentsError = $state<ApiFailure | null>(null);
  let agentsLoading = $state(false);

  let models = $state<ModelsPayload | null>(null);
  let modelsError = $state<ApiFailure | null>(null);

  let config = $state<ConfigPayload | null>(null);
  let configError = $state<ApiFailure | null>(null);

  let roleError = $state<ApiFailure | null>(null);
  let roleMessage = $state('');
  let rolePending = $state<string | null>(null);
  /** Picker value per agent, keyed by agent name. Empty string means "no override". */
  let rolePick = $state<Record<string, string>>({});

  let generation = $derived(config?.generation ?? store.generation);

  async function loadAgents(): Promise<void> {
    agentsLoading = true;
    const result = await getAgents(client);
    agentsLoading = false;
    if (!result.ok) {
      agentsError = result.error;
      agents = null;
      return;
    }
    agentsError = null;
    agents = result.value;
  }

  async function loadModels(): Promise<void> {
    const result = await getModels();
    if (!result.ok) {
      modelsError = result.error;
      return;
    }
    modelsError = null;
    models = result.value;
  }

  async function loadConfig(): Promise<void> {
    const result = await getConfig();
    if (!result.ok) {
      configError = result.error;
      return;
    }
    configError = null;
    config = result.value;
  }

  $effect(() => {
    // Re-reads the inventory whenever the client picker changes; `client` is the tracked read.
    const selected = client;
    void selected;
    void loadAgents();
  });

  $effect(() => {
    if (models === null && modelsError === null) void loadModels();
    if (config === null && configError === null) void loadConfig();
  });

  function overrideFor(agentName: string): string | null {
    return config?.config.roles[`${client}:${agentName}`]?.routeOverride ?? null;
  }

  async function applyRole(agentName: string, routeOverride: string | null): Promise<void> {
    if (generation === null || generation === undefined) {
      roleError = { code: 'no-generation', message: 'No config generation is loaded yet, so a write cannot be sent safely.' };
      return;
    }
    rolePending = agentName;
    roleError = null;
    roleMessage = routeOverride === null ? `Clearing the override for ${agentName}...` : `Routing ${agentName} to ${routeOverride}...`;
    const result = await setRole({ expectedGeneration: generation, client, agent: agentName, routeOverride });
    rolePending = null;
    if (!result.ok) {
      roleError = result.error;
      roleMessage = '';
      return;
    }
    config = { config: result.value.config, generation: result.value.generation };
    roleMessage = routeOverride === null ? `Override cleared for ${agentName}.` : `${agentName} now routes to ${routeOverride}.`;
    await store.refresh();
  }

  // --- Route preview ------------------------------------------------------

  let previewAgent = $state('');
  let previewModel = $state('');
  let previewParentModel = $state('');
  let preview = $state<RoutePreviewResult | null>(null);
  let previewError = $state<ApiFailure | null>(null);
  let previewBusy = $state(false);

  async function runPreview(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (previewAgent.trim() === '') return;
    previewBusy = true;
    previewError = null;
    const result = await getRoutePreview({
      client,
      agent: previewAgent.trim(),
      ...(previewModel.trim() !== '' ? { model: previewModel.trim() } : {}),
      ...(previewParentModel.trim() !== '' ? { parentModel: previewParentModel.trim() } : {}),
    });
    previewBusy = false;
    if (!result.ok) {
      previewError = result.error;
      preview = null;
      return;
    }
    preview = result.value;
  }

  // --- Defaults -----------------------------------------------------------

  let defaultChild = $state('');
  let unmarkedSubagent = $state<'error' | 'inherit'>('error');
  let acknowledged = $state(false);
  let defaultsBusy = $state(false);
  let defaultsError = $state<ApiFailure | null>(null);
  let defaultsMessage = $state('');
  let defaultsLoaded = $state(false);

  $effect(() => {
    const loaded = config;
    if (loaded === null || defaultsLoaded) return;
    defaultChild = loaded.config.defaults.child ?? '';
    unmarkedSubagent = loaded.config.defaults.unmarkedSubagent;
    acknowledged = loaded.config.defaults.unmarkedSubagentAcknowledged === true;
    defaultsLoaded = true;
  });

  let needsAcknowledgement = $derived(unmarkedSubagent === 'inherit' && !acknowledged);

  async function saveDefaults(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (generation === null || generation === undefined) {
      defaultsError = { code: 'no-generation', message: 'No config generation is loaded yet, so a write cannot be sent safely.' };
      return;
    }
    defaultsBusy = true;
    defaultsError = null;
    defaultsMessage = 'Saving...';
    const result = await setDefaults({
      expectedGeneration: generation,
      child: defaultChild.trim() === '' ? null : defaultChild.trim(),
      unmarkedSubagent,
      unmarkedSubagentAcknowledged: acknowledged,
    });
    defaultsBusy = false;
    if (!result.ok) {
      defaultsError = result.error;
      defaultsMessage = '';
      return;
    }
    config = { config: result.value.config, generation: result.value.generation };
    defaultsMessage = `Saved. Generation is now ${result.value.generation}.`;
    await store.refresh();
  }

  let modelOptions = $derived(models?.models.filter((model) => model.enabled) ?? []);
</script>

<div class="stack">
  <Panel title="Client">
    <div class="row center">
      <label class="field">
        <span>Inspect routing for</span>
        <select bind:value={client}>
          {#each CLIENT_IDS as id (id)}<option value={id}>{id}</option>{/each}
        </select>
      </label>
      <button type="button" onclick={() => loadAgents()} disabled={agentsLoading}>Reload inventory</button>
      {#if agents !== null}
        <Badge label="inventory: {agents.completeness}" />
      {/if}
    </div>
    {#if agents !== null && agents.diagnostics.length > 0}
      <ul class="plain warnings">
        {#each agents.diagnostics as diagnostic (diagnostic)}<li>{diagnostic}</li>{/each}
      </ul>
    {/if}
  </Panel>

  <Panel title="Agents and role overrides">
    {#if modelsError !== null}
      <ErrorBox error={modelsError} onreload={() => loadModels()} />
    {/if}
    {#if configError !== null}
      <ErrorBox error={configError} onreload={() => loadConfig()} />
    {/if}
    {#if roleError !== null}
      <ErrorBox error={roleError} onreload={() => loadConfig()} />
    {/if}
    <p class="action-status" aria-live="polite">{roleMessage}</p>

    {#if agentsError !== null}
      <ErrorBox error={agentsError} onreload={() => loadAgents()} />
    {:else if agents === null}
      <Loading label="Reading the agent inventory" />
    {:else if agents.agents.length === 0}
      <Empty label="No agents found for this client." hint="Agent files live under the client's agent roots, which the Status view lists." />
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Scope</th>
              <th scope="col">Declared model</th>
              <th scope="col">Availability</th>
              <th scope="col">Role override</th>
              <th scope="col">Assign</th>
            </tr>
          </thead>
          <tbody>
            {#each agents.agents as agent (agent.name + agent.scope)}
              {@const current = overrideFor(agent.name)}
              <tr>
                <td>
                  {agent.name}
                  {#if agent.shadowed}<Badge tone="warn" label="shadowed" />{/if}
                  {#if agent.hidden}<Badge label="hidden" />{/if}
                </td>
                <td>{agent.scope}</td>
                <td class="mono">{agent.declaredModel}</td>
                <td>
                  <Health tone={agent.availability === 'available' ? 'ok' : 'warn'} label={agent.availability} />
                </td>
                <td class="mono">{current ?? '-'}</td>
                <td class="assign">
                  <label class="sr" for="pick-{agent.name}">Model for {agent.name}</label>
                  <select id="pick-{agent.name}" bind:value={rolePick[agent.name]} disabled={modelOptions.length === 0}>
                    <option value="">Choose a model</option>
                    {#each modelOptions as model (model.id)}
                      <option value={model.id}>{model.alias} ({model.id})</option>
                    {/each}
                  </select>
                  <button
                    type="button"
                    disabled={rolePending === agent.name || (rolePick[agent.name] ?? '') === ''}
                    onclick={() => applyRole(agent.name, rolePick[agent.name] ?? '')}>Assign</button
                  >
                  <button type="button" disabled={rolePending === agent.name || current === null} onclick={() => applyRole(agent.name, null)}>
                    Clear
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if modelOptions.length === 0}
        <p class="note">No enabled model is available to assign. Sync the catalog, or enable a model on the Models view.</p>
      {/if}
    {/if}
  </Panel>

  <Panel title="Route preview">
    <form class="row" onsubmit={runPreview}>
      <label class="field"><span>Agent</span><input type="text" bind:value={previewAgent} required size="20" /></label>
      <label class="field"><span>Marker model (optional)</span><input type="text" bind:value={previewModel} size="18" /></label>
      <label class="field"><span>Parent model (optional)</span><input type="text" bind:value={previewParentModel} size="18" /></label>
      <button type="submit" class="primary" disabled={previewBusy}>{previewBusy ? 'Simulating' : 'Simulate'}</button>
    </form>

    {#if previewError !== null}
      <ErrorBox error={previewError} />
    {:else if preview !== null}
      <div class="preview" aria-live="polite">
        <div class="kv"><span class="k">Agent</span><span class="v">{preview.agent.name} <span class="muted">({preview.agent.scope}, declared {preview.agent.declaredModel})</span></span></div>
        <div class="kv">
          <span class="k">Decision</span>
          <span class="v"><Health tone={preview.decision.kind === 'error' ? 'bad' : 'ok'} label={preview.decision.kind} /></span>
        </div>
        {#if preview.decision.kind === 'route'}
          <div class="kv"><span class="k">Upstream model</span><span class="v mono">{preview.decision.upstreamModel}</span></div>
          {#if preview.decision.clientModel !== undefined}
            <div class="kv"><span class="k">Client model</span><span class="v mono">{preview.decision.clientModel}</span></div>
          {/if}
          <div class="kv"><span class="k">Source</span><span class="v"><Badge tone="info" label={preview.decision.source} /></span></div>
        {:else if preview.decision.kind === 'error'}
          <div class="kv"><span class="k">Error code</span><span class="v bad-text mono">{preview.decision.code}</span></div>
        {:else}
          <div class="kv"><span class="k">Reason</span><span class="v">{preview.decision.reason}</span></div>
        {/if}
        <div class="kv"><span class="k">Ignored markers</span><span class="v">{preview.decision.ignoredMarkers}</span></div>
        <div class="kv"><span class="k">Generation</span><span class="v mono">{preview.generation}</span></div>

        <p class="note">
          Simulation, not a measurement of a real run. It assumes the child is authenticated
          ({String(preview.assumptions.authenticatedChild)}), that the delegation is fresh
          ({String(preview.assumptions.freshDelegation)}), and it proves nothing about the client's runtime
          capability ({String(preview.assumptions.runtimeCapabilityNotProven)}). No network call is made and no
          capability profile is consulted.
        </p>
      </div>
    {:else}
      <Empty label="No simulation yet." hint="Pick an agent and simulate to see which model a child would get." />
    {/if}
  </Panel>

  <Panel title="Defaults">
    <form class="stack" onsubmit={saveDefaults}>
      <div class="grid">
        <label class="field">
          <span>Default child model (empty means none)</span>
          <input type="text" bind:value={defaultChild} list="default-child-options" />
        </label>
        <label class="field">
          <span>Unmarked subagent</span>
          <select bind:value={unmarkedSubagent}>
            <option value="error">error: refuse a child with no marker</option>
            <option value="inherit">inherit: let it keep the parent's model</option>
          </select>
        </label>
      </div>
      <datalist id="default-child-options">
        {#each modelOptions as model (model.id)}<option value={model.id}>{model.alias}</option>{/each}
      </datalist>

      {#if unmarkedSubagent === 'inherit'}
        <label class="check">
          <input type="checkbox" bind:checked={acknowledged} />
          <span>
            I understand that <strong>inherit</strong> lets an unmarked subagent run on the parent's model, so a child
            that was meant to be routed silently runs on whatever the parent uses. The config refuses this setting
            without this acknowledgement.
          </span>
        </label>
      {/if}

      <div class="row center">
        <button type="submit" class="primary" disabled={defaultsBusy || needsAcknowledgement}>
          {defaultsBusy ? 'Saving' : 'Save defaults'}
        </button>
        {#if needsAcknowledgement}<span class="warn-text">Tick the acknowledgement to save inherit.</span>{/if}
        <span class="muted" aria-live="polite">{defaultsMessage}</span>
      </div>
    </form>
    {#if defaultsError !== null}
      <ErrorBox error={defaultsError} onreload={() => loadConfig()} />
    {/if}
  </Panel>
</div>

<style>
  .assign {
    white-space: nowrap;
  }

  .assign button {
    margin-left: var(--space-1);
  }

  .action-status {
    margin: 0 0 var(--space-2) 0;
    font-size: var(--size-2);
    color: var(--muted);
    min-height: 1.1em;
  }

  .preview {
    margin-top: var(--space-3);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
