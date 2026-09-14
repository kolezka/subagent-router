<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Loading from '../lib/Loading.svelte';
  import EnvTable from '../lib/EnvTable.svelte';
  import { getConfig, setSource, type ApiFailure } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import { joinNameList, parseNameList, toPositiveInt } from '../lib/format';
  import type { ConfigPayload, SourceRequest } from '../../../api-types';

  let config = $state<ConfigPayload | null>(null);
  let loadError = $state<ApiFailure | null>(null);
  let loading = $state(false);

  let saveError = $state<ApiFailure | null>(null);
  let saveMessage = $state('');
  let saving = $state(false);

  // Form fields, filled from the loaded config so an unedited field round-trips its own value.
  let sourceId = $state('');
  let endpointPath = $state('');
  let timeoutMs = $state('');
  let fetchLimit = $state('');
  let staleAfterSeconds = $state('');
  let gatewayUrlEnv = $state('');
  let gatewayHeadersEnv = $state('');
  let modelsBaseUrlEnv = $state('');
  let modelsAuthEnv = $state('');
  let modelsHeadersEnv = $state('');
  let correlationSecretEnv = $state('');
  let correlation = $state<'auto' | 'off'>('auto');

  function fillForm(payload: ConfigPayload): void {
    const { modelSource, gateway, harness } = payload.config;
    sourceId = modelSource.sourceId;
    endpointPath = modelSource.endpointPath;
    timeoutMs = String(modelSource.timeoutMs);
    fetchLimit = String(modelSource.fetchLimit);
    staleAfterSeconds = String(modelSource.staleAfterSeconds);
    gatewayUrlEnv = gateway.urlEnv;
    gatewayHeadersEnv = joinNameList(gateway.headersEnv);
    modelsBaseUrlEnv = modelSource.baseUrlEnv;
    modelsAuthEnv = modelSource.authEnv ?? '';
    modelsHeadersEnv = joinNameList(modelSource.headersEnv);
    correlationSecretEnv = harness.claudeCode.secretEnv;
    correlation = harness.claudeCode.correlation;
  }

  async function load(): Promise<void> {
    loading = true;
    const result = await getConfig();
    loading = false;
    if (!result.ok) {
      loadError = result.error;
      return;
    }
    loadError = null;
    config = result.value;
    fillForm(result.value);
  }

  $effect(() => {
    if (config === null && !loading && loadError === null) void load();
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const generation = config?.generation ?? store.generation;
    if (generation === null || generation === undefined) {
      saveError = { code: 'no-generation', message: 'No config generation is loaded yet, so a write cannot be sent safely.' };
      return;
    }
    saving = true;
    saveError = null;
    saveMessage = 'Saving...';

    const parsedTimeout = toPositiveInt(timeoutMs);
    const parsedFetchLimit = toPositiveInt(fetchLimit);
    const parsedStale = toPositiveInt(staleAfterSeconds);

    const body: SourceRequest = {
      expectedGeneration: generation,
      sourceId: sourceId.trim(),
      endpointPath: endpointPath.trim(),
      ...(parsedTimeout !== undefined ? { timeoutMs: parsedTimeout } : {}),
      ...(parsedFetchLimit !== undefined ? { fetchLimit: parsedFetchLimit } : {}),
      ...(parsedStale !== undefined ? { staleAfterSeconds: parsedStale } : {}),
      gatewayUrlEnv: gatewayUrlEnv.trim(),
      gatewayHeadersEnv: parseNameList(gatewayHeadersEnv),
      modelsBaseUrlEnv: modelsBaseUrlEnv.trim(),
      // null clears authEnv; an empty box means the operator removed it.
      modelsAuthEnv: modelsAuthEnv.trim() === '' ? null : modelsAuthEnv.trim(),
      modelsHeadersEnv: parseNameList(modelsHeadersEnv),
      correlationSecretEnv: correlationSecretEnv.trim(),
      correlation,
    };

    const result = await setSource(body);
    saving = false;
    if (!result.ok) {
      saveError = result.error;
      saveMessage = '';
      return;
    }
    config = { config: result.value.config, generation: result.value.generation };
    fillForm(config);
    saveMessage = `Saved. Generation is now ${result.value.generation}.`;
    await store.refresh();
  }
</script>

<div class="stack">
  {#if loadError !== null}
    <Panel title="Gateway">
      <ErrorBox error={loadError} onreload={() => load()} />
    </Panel>
  {:else if config === null}
    <Panel title="Gateway"><Loading label="Reading the config" /></Panel>
  {:else}
    <Panel title="Environment variables this config names">
      <EnvTable env={store.status?.env ?? []} />
    </Panel>

    <Panel title="Model source and gateway">
      <form class="stack" onsubmit={save}>
        <p class="explain">
          Every field below is a variable <strong>name</strong> or a plain setting. The URL, the token and the
          header values live in the shell that starts the router and never reach this page.
        </p>

        <fieldset>
          <legend>Model source</legend>
          <div class="grid">
            <label class="field"><span>Source id</span><input type="text" bind:value={sourceId} required /></label>
            <label class="field"><span>Endpoint path</span><input type="text" bind:value={endpointPath} required /></label>
            <label class="field"><span>Base URL variable</span><input type="text" bind:value={modelsBaseUrlEnv} required /></label>
            <label class="field"><span>Auth variable (empty clears it)</span><input type="text" bind:value={modelsAuthEnv} /></label>
            <label class="field"><span>Header variables (comma separated)</span><input type="text" bind:value={modelsHeadersEnv} /></label>
            <label class="field"><span>Timeout (ms)</span><input type="text" inputmode="numeric" bind:value={timeoutMs} /></label>
            <label class="field"><span>Fetch limit</span><input type="text" inputmode="numeric" bind:value={fetchLimit} /></label>
            <label class="field"><span>Stale after (seconds)</span><input type="text" inputmode="numeric" bind:value={staleAfterSeconds} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Gateway</legend>
          <div class="grid">
            <label class="field"><span>URL variable</span><input type="text" bind:value={gatewayUrlEnv} required /></label>
            <label class="field"><span>Header variables (comma separated)</span><input type="text" bind:value={gatewayHeadersEnv} /></label>
          </div>
          <p class="note">Gateway headers are the only headers forwarded upstream. Model source headers are used for discovery only.</p>
        </fieldset>

        <fieldset>
          <legend>Claude Code harness</legend>
          <div class="grid">
            <label class="field"><span>Correlation secret variable</span><input type="text" bind:value={correlationSecretEnv} required /></label>
            <label class="field">
              <span>Correlation</span>
              <select bind:value={correlation}>
                <option value="auto">auto</option>
                <option value="off">off</option>
              </select>
            </label>
          </div>
        </fieldset>

        <div class="row center">
          <button type="submit" class="primary" disabled={saving}>{saving ? 'Saving' : 'Save changes'}</button>
          <button type="button" disabled={saving} onclick={() => (config !== null ? fillForm(config) : undefined)}>Reset form</button>
          <span class="muted" aria-live="polite">{saveMessage}</span>
        </div>
        <p class="note">Writing sends generation <span class="mono">{config.generation}</span>, so an edit made elsewhere cannot be overwritten silently.</p>
      </form>

      {#if saveError !== null}
        <ErrorBox error={saveError} onreload={() => load()} />
      {/if}
    </Panel>
  {/if}
</div>

<style>
  fieldset {
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    padding: var(--space-3);
    margin: 0;
  }

  legend {
    font-size: var(--size-2);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 var(--space-1);
  }

  .explain {
    margin: 0;
    color: var(--muted);
    font-size: var(--size-3);
    max-width: 76ch;
  }
</style>
