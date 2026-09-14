<script lang="ts">
  import Panel from '../lib/Panel.svelte';
  import ErrorBox from '../lib/ErrorBox.svelte';
  import Empty from '../lib/Empty.svelte';
  import CopyButton from '../lib/CopyButton.svelte';
  import ConfirmButton from '../lib/ConfirmButton.svelte';
  import { install, type ApiFailure } from '../lib/api';
  import { toPositiveInt } from '../lib/format';
  import type { InstallRequest, InstallResult } from '../../../api-types';

  let output = $state('./router-bundle');
  let port = $state('');
  let host = $state('');
  let claudeVersion = $state('');
  let parentModel = $state('');
  let force = $state(false);

  let busy = $state(false);
  let error = $state<ApiFailure | null>(null);
  let result = $state<InstallResult | null>(null);
  let message = $state('');

  function buildRequest(dryRun: boolean): InstallRequest {
    const parsedPort = toPositiveInt(port);
    return {
      output: output.trim(),
      ...(parsedPort !== undefined ? { port: parsedPort } : {}),
      ...(host.trim() !== '' ? { host: host.trim() } : {}),
      ...(claudeVersion.trim() !== '' ? { claudeVersion: claudeVersion.trim() } : {}),
      ...(parentModel.trim() !== '' ? { parentModel: parentModel.trim() } : {}),
      force,
      dryRun,
    };
  }

  async function run(dryRun: boolean): Promise<void> {
    if (output.trim() === '') {
      error = { code: 'usage-missing-output', message: 'An output directory is required.' };
      return;
    }
    busy = true;
    error = null;
    message = dryRun ? 'Listing what would be written...' : 'Generating the bundle...';
    const response = await install(buildRequest(dryRun));
    busy = false;
    if (!response.ok) {
      error = response.error;
      message = '';
      return;
    }
    result = response.value;
    message = response.value.dryRun ? 'Dry run complete, nothing was written.' : 'Bundle written.';
  }

  let base = $derived(result === null ? '' : result.output.replace(/\/$/, ''));
  let launcherCommand = $derived(base === '' ? '' : `${base}/claude-router`);
  let manualCommand = $derived(base === '' ? '' : `claude --settings ${base}/settings.json`);
</script>

<div class="stack">
  <Panel title="Generate the Claude Code bundle">
    <p class="explain">
      Everything is written into the directory you name. Nothing in your own Claude Code configuration is edited:
      not <span class="mono">~/.claude/settings.json</span>, not a project settings file, not a plugin registry.
      The bundle is used by passing it to Claude Code on the command line.
    </p>

    <div class="grid">
      <label class="field"><span>Output directory</span><input type="text" bind:value={output} required /></label>
      <label class="field"><span>Router port</span><input type="text" inputmode="numeric" bind:value={port} placeholder="8787" /></label>
      <label class="field"><span>Router host</span><input type="text" bind:value={host} placeholder="127.0.0.1" /></label>
      <label class="field"><span>Claude version</span><input type="text" bind:value={claudeVersion} placeholder="2.1.270" /></label>
      <label class="field"><span>Parent model (optional)</span><input type="text" bind:value={parentModel} /></label>
    </div>

    <label class="check force">
      <input type="checkbox" bind:checked={force} />
      <span>Overwrite files that already exist in the output directory (force)</span>
    </label>

    <div class="row center">
      <button type="button" disabled={busy} onclick={() => run(true)}>Dry run</button>
      {#if force}
        <ConfirmButton
          label="Generate bundle"
          question="Force is on: existing files in {output} will be overwritten."
          confirmLabel="Overwrite and generate"
          tone="danger"
          disabled={busy}
          onconfirm={() => run(false)}
        />
      {:else}
        <ConfirmButton
          label="Generate bundle"
          question="This writes the bundle files into {output}."
          confirmLabel="Generate"
          disabled={busy}
          onconfirm={() => run(false)}
        />
      {/if}
      <span class="muted" aria-live="polite">{message}</span>
    </div>

    {#if error !== null}
      <ErrorBox error={error} />
    {/if}
  </Panel>

  <Panel title="Generated files">
    {#if result === null}
      <Empty label="Nothing generated in this session yet." hint="Run a dry run first to see exactly which files would be written." />
    {:else}
      <p class="summary">
        {result.dryRun ? 'Would be written' : 'Written'} to <span class="mono">{result.output}</span>. The bundle points
        Claude Code at <span class="mono">{result.routerUrl}</span>.
      </p>
      {#if result.files.length === 0}
        <Empty label="The bundle reported no files." />
      {:else}
        <ul class="plain">
          {#each result.files as file (file)}<li class="mono">{file}</li>{/each}
        </ul>
      {/if}
    {/if}
  </Panel>

  {#if result !== null && !result.dryRun}
    <Panel title="Next, in a terminal">
      <div class="commands">
        <div>
          <p class="sub">1. Start Claude Code through the launcher</p>
          <div class="row center tight">
            <code>{launcherCommand}</code>
            <CopyButton text={launcherCommand} />
          </div>
          <p class="note">The launcher checks that the router answers first, then runs Claude Code and passes your arguments through.</p>
        </div>
        <div>
          <p class="sub">2. Or, without the launcher</p>
          <div class="row center tight">
            <code>{manualCommand}</code>
            <CopyButton text={manualCommand} />
          </div>
          <p class="note"><span class="mono">--settings</span> applies to that one invocation and does not edit your stored configuration.</p>
        </div>
      </div>
    </Panel>
  {/if}
</div>

<style>
  .explain {
    margin: 0 0 var(--space-3) 0;
    color: var(--muted);
    font-size: var(--size-3);
    max-width: 80ch;
  }

  .force {
    margin: var(--space-3) 0;
  }

  .summary {
    margin: 0 0 var(--space-2) 0;
    font-size: var(--size-3);
  }

  .sub {
    margin: 0 0 var(--space-1) 0;
    font-size: var(--size-2);
    color: var(--muted);
    font-weight: 600;
  }

  .commands {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  code {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    padding: 4px 8px;
    word-break: break-all;
  }
</style>
