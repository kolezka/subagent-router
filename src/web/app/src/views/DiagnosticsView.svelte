<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import Health from '../lib/Health.svelte';
  import Badge from '../lib/Badge.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Loading from '../lib/Loading.svelte';
  import Empty from '../lib/Empty.svelte';
  import Findings from '../lib/Findings.svelte';
  import CopyButton from '../lib/CopyButton.svelte';
  import { getConfig, getConfigCheck, getDoctor, type ApiFailure, type ConfigCheckPayload, type DoctorPayload } from '../lib/api';
  import type { ConfigPayload } from '../../../api-types';

  let doctor = $state<DoctorPayload | null>(null);
  let doctorError = $state<ApiFailure | null>(null);

  let check = $state<ConfigCheckPayload | null>(null);
  let checkError = $state<ApiFailure | null>(null);

  let config = $state<ConfigPayload | null>(null);
  let configError = $state<ApiFailure | null>(null);

  let loading = $state(false);

  async function loadAll(): Promise<void> {
    loading = true;
    const [doctorResult, checkResult, configResult] = await Promise.all([getDoctor(), getConfigCheck(), getConfig()]);
    loading = false;

    if (doctorResult.ok) {
      doctor = doctorResult.value;
      doctorError = null;
    } else doctorError = doctorResult.error;

    if (checkResult.ok) {
      check = checkResult.value;
      checkError = null;
    } else checkError = checkResult.error;

    if (configResult.ok) {
      config = configResult.value;
      configError = null;
    } else configError = configResult.error;
  }

  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    void loadAll();
  });

  let configJson = $derived(config === null ? '' : JSON.stringify(config.config, null, 2));
</script>

<div class="stack">
  <Panel title="Doctor">
    {#snippet actions()}
      <button type="button" onclick={loadAll} disabled={loading}>{loading ? 'Refreshing' : 'Refresh all'}</button>
    {/snippet}

    {#if doctorError !== null}
      <ErrorBox error={doctorError} onreload={loadAll} />
    {:else if doctor === null}
      <Loading label="Running offline diagnostics" />
    {:else}
      <div class="kv">
        <span class="k">Network</span>
        <span class="v"><Badge label={doctor.network ? 'used' : 'not used, offline report'} /></span>
      </div>
      <div class="kv">
        <span class="k">Config</span>
        <span class="v">
          {#if doctor.config.ok}
            <Health tone="ok" label="ok" detail="generation {doctor.config.generation}" />
          {:else}
            <Health tone="bad" label="problem" detail={doctor.config.error} />
          {/if}
        </span>
      </div>
      <div class="kv">
        <span class="k">Snapshot</span>
        <span class="v"><Health tone={doctor.snapshotStale ? 'warn' : 'ok'} label={doctor.snapshotStale ? 'stale' : 'fresh'} /></span>
      </div>
      <div class="kv">
        <span class="k">Transport</span>
        <span class="v">
          {doctor.transport.adapterId}
          <span class="muted">runtime {doctor.transport.runtimeVersion}</span>
          <Badge tone={doctor.transport.status === 'passed' ? 'ok' : 'warn'} label={doctor.transport.status} />
        </span>
      </div>

      <div class="table-scroll clients">
        <table>
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Version</th>
              <th scope="col">Capability status</th>
              <th scope="col">Diagnostics</th>
            </tr>
          </thead>
          <tbody>
            {#each doctor.clients as client (client.client)}
              <tr>
                <td>{client.client}</td>
                <td class="mono">{client.version}</td>
                <td>
                  <Health
                    tone={client.status === 'supported' ? 'ok' : client.status === 'unsupported' ? 'bad' : 'warn'}
                    label={client.status}
                  />
                </td>
                <td>
                  {#if client.diagnostics === undefined || client.diagnostics.length === 0}
                    <span class="muted">none</span>
                  {:else}
                    <ul class="plain">
                      {#each client.diagnostics as diagnostic (diagnostic)}<li>{diagnostic}</li>{/each}
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

  <Panel title="Config check">
    {#if checkError !== null}
      <ErrorBox error={checkError} onreload={loadAll} />
    {:else if check === null}
      <Loading label="Checking the config" />
    {:else}
      <Findings problems={check.problems} warnings={check.warnings} emptyLabel="config check found no problems." />
      <p class="note">Checked at generation <span class="mono">{check.generation}</span>.</p>
    {/if}
  </Panel>

  <Panel title="Raw config">
    {#snippet actions()}
      {#if configJson !== ''}<CopyButton text={configJson} label="Copy JSON" />{/if}
    {/snippet}

    {#if configError !== null}
      <ErrorBox error={configError} onreload={loadAll} />
    {:else if config === null}
      <Loading label="Reading the config" />
    {:else if configJson === ''}
      <Empty label="The config is empty." />
    {:else}
      <p class="note">
        Read only. This file holds environment variable names, never their values, so nothing below is a
        credential.
      </p>
      <pre>{configJson}</pre>
    {/if}
  </Panel>
</div>

<style>
  .clients {
    margin-top: var(--space-3);
  }
</style>
