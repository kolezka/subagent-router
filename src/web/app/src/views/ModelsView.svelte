<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import Badge from '../lib/Badge.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Loading from '../lib/Loading.svelte';
  import Empty from '../lib/Empty.svelte';
  import ConfirmButton from '../lib/ConfirmButton.svelte';
  import { getModels, setModelOverride, syncCatalog, type ApiFailure } from '../lib/api';
  import { store } from '../lib/store.svelte';
  import { formatTime } from '../lib/format';
  import type { ModelsPayload, ResolvedModel, SyncPayload } from '../../../api-types';

  let payload = $state<ModelsPayload | null>(null);
  let loadError = $state<ApiFailure | null>(null);
  let loading = $state(false);

  let filter = $state('');
  let disabledOnly = $state(false);

  let editing = $state<string | null>(null);
  let draftAlias = $state('');
  let draftDescription = $state('');
  let draftClientModel = $state('');
  let draftEnabled = $state(true);
  let saving = $state(false);
  let saveError = $state<ApiFailure | null>(null);
  let saveMessage = $state('');

  let syncing = $state(false);
  let syncError = $state<ApiFailure | null>(null);
  let syncResult = $state<SyncPayload | null>(null);

  async function load(): Promise<void> {
    loading = true;
    const result = await getModels();
    loading = false;
    if (!result.ok) {
      loadError = result.error;
      return;
    }
    loadError = null;
    payload = result.value;
  }

  $effect(() => {
    if (payload === null && !loading && loadError === null) void load();
  });

  let visible = $derived.by(() => {
    if (payload === null) return [];
    const needle = filter.trim().toLowerCase();
    return payload.models.filter((model) => {
      if (disabledOnly && model.enabled) return false;
      if (needle === '') return true;
      return `${model.id} ${model.alias} ${model.description ?? ''} ${model.clientModel ?? ''}`.toLowerCase().includes(needle);
    });
  });

  function startEdit(model: ResolvedModel): void {
    editing = model.id;
    draftAlias = model.alias;
    draftDescription = model.description ?? '';
    draftClientModel = model.clientModel ?? '';
    draftEnabled = model.enabled;
    saveError = null;
    saveMessage = '';
  }

  async function saveEdit(model: ResolvedModel): Promise<void> {
    const generation = payload?.generation ?? store.generation;
    if (generation === null || generation === undefined) {
      saveError = { code: 'no-generation', message: 'No config generation is loaded yet, so a write cannot be sent safely.' };
      return;
    }
    saving = true;
    saveError = null;
    saveMessage = 'Saving...';
    // null clears a field the operator emptied; the server leaves an undefined field untouched.
    const result = await setModelOverride({
      expectedGeneration: generation,
      reference: model.id,
      alias: draftAlias.trim() === '' ? null : draftAlias.trim(),
      description: draftDescription.trim() === '' ? null : draftDescription.trim(),
      clientModel: draftClientModel.trim() === '' ? null : draftClientModel.trim(),
      enabled: draftEnabled,
    });
    saving = false;
    if (!result.ok) {
      saveError = result.error;
      saveMessage = '';
      return;
    }
    editing = null;
    saveMessage = `Saved. Generation is now ${result.value.generation}.`;
    await load();
    await store.refresh();
  }

  async function runSync(dryRun: boolean): Promise<void> {
    syncing = true;
    syncError = null;
    const result = await syncCatalog({ dryRun });
    syncing = false;
    if (!result.ok) {
      syncError = result.error;
      return;
    }
    syncResult = result.value;
    if (!dryRun) {
      await load();
      await store.refresh();
    }
  }
</script>

<div class="stack">
  <Panel title="Model catalog">
    {#snippet actions()}
      <button type="button" disabled={syncing} onclick={() => runSync(true)}>Preview sync</button>
      <ConfirmButton
        label="Sync catalog"
        question="This contacts the model source and overwrites models.lock.json."
        confirmLabel="Sync now"
        disabled={syncing}
        onconfirm={() => runSync(false)}
      />
    {/snippet}

    {#if loadError !== null}
      <ErrorBox error={loadError} onreload={() => load()} />
    {:else if payload === null}
      <Loading label="Reading the catalog" />
    {:else}
      <div class="row center controls">
        <label class="field">
          <span>Filter</span>
          <input type="search" bind:value={filter} placeholder="id, alias, description or client model" size="34" />
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={disabledOnly} />
          Show disabled only
        </label>
        <span class="spacer"></span>
        <span class="muted">
          {visible.length} of {payload.models.length} shown, fetched {formatTime(payload.fetchedAt)}
        </span>
      </div>

      <p class="action-status" aria-live="polite">{saveMessage}</p>
      {#if saveError !== null}
        <ErrorBox error={saveError} onreload={() => load()} />
      {/if}

      {#if payload.models.length === 0}
        <Empty label="The catalog is empty." hint="Run a sync to fetch the model list from the configured source." />
      {:else if visible.length === 0}
        <Empty label="No model matches the current filter." />
      {:else}
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Id</th>
                <th scope="col">Alias</th>
                <th scope="col">Status</th>
                <th scope="col">Enabled</th>
                <th scope="col">Description</th>
                <th scope="col">Client model</th>
                <th scope="col"><span class="sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each visible as model (model.id)}
                <tr>
                  <td class="mono">{model.id}</td>
                  {#if editing === model.id}
                    <td><input type="text" bind:value={draftAlias} size="14" aria-label="Alias for {model.id}" /></td>
                    <td><Badge tone={model.status === 'available' ? 'ok' : 'bad'} label={model.status} /></td>
                    <td>
                      <label class="check">
                        <input type="checkbox" bind:checked={draftEnabled} aria-label="Enabled for {model.id}" />
                        {draftEnabled ? 'yes' : 'no'}
                      </label>
                    </td>
                    <td><input type="text" bind:value={draftDescription} size="26" aria-label="Description for {model.id}" /></td>
                    <td><input type="text" bind:value={draftClientModel} size="14" aria-label="Client model for {model.id}" /></td>
                    <td class="actions">
                      <button type="button" class="primary" disabled={saving} onclick={() => saveEdit(model)}>Save</button>
                      <button type="button" disabled={saving} onclick={() => (editing = null)}>Cancel</button>
                    </td>
                  {:else}
                    <td>{model.alias}</td>
                    <td><Badge tone={model.status === 'available' ? 'ok' : 'bad'} label={model.status} /></td>
                    <td><Badge tone={model.enabled ? 'ok' : 'idle'} label={model.enabled ? 'yes' : 'no'} /></td>
                    <td>{model.description ?? ''}</td>
                    <td class="mono">{model.clientModel ?? ''}</td>
                    <td class="actions">
                      <button type="button" onclick={() => startEdit(model)}>Edit</button>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </Panel>

  {#if syncError !== null || syncResult !== null}
    <Panel title="Last sync">
      {#if syncError !== null}
        <ErrorBox error={syncError} onreload={() => load()} />
      {:else if syncResult !== null}
        <p aria-live="polite">
          {syncResult.dryRun ? 'Dry run, nothing was written.' : 'Snapshot written.'}
          Fetched {formatTime(syncResult.fetchedAt)}.
        </p>
        <div class="grid">
          {#each [['Added', syncResult.added], ['Changed', syncResult.changed], ['Missing', syncResult.missing]] as [label, items] (label)}
            <div>
              <p class="sub">{label} ({items.length})</p>
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
      {/if}
    </Panel>
  {/if}
</div>

<style>
  .controls {
    margin-bottom: var(--space-3);
  }

  .actions {
    white-space: nowrap;
  }

  .actions button + button {
    margin-left: var(--space-1);
  }

  .action-status {
    margin: 0 0 var(--space-2) 0;
    font-size: var(--size-2);
    color: var(--muted);
    min-height: 1.1em;
  }

  .sub {
    margin: 0 0 var(--space-1) 0;
    font-size: var(--size-2);
    color: var(--muted);
    font-weight: 600;
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
