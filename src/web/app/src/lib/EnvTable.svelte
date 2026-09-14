<script lang="ts">
  import Health from './Health.svelte';
  import Empty from './Empty.svelte';
  import { purposeLabel } from './format';
  import type { EnvVarReport } from '../../../api-types';

  interface Props {
    env: readonly EnvVarReport[];
  }

  let { env }: Props = $props();

  let missing = $derived(env.filter((entry) => !entry.present).length);
</script>

{#if env.length === 0}
  <Empty label="No environment variables are referenced by the config yet." />
{:else}
  <div class="table-scroll">
    <table>
      <caption class="muted">
        Names and presence only. The console never reads a value, and never receives one:
        {missing === 0 ? 'all referenced variables are set' : `${missing} of ${env.length} are missing`} in the shell that
        started this console.
      </caption>
      <thead>
        <tr>
          <th scope="col">Variable</th>
          <th scope="col">Used for</th>
          <th scope="col">State</th>
        </tr>
      </thead>
      <tbody>
        {#each env as entry (entry.name + entry.purpose)}
          <tr>
            <td class="mono">{entry.name}</td>
            <td>{purposeLabel(entry.purpose)}</td>
            <td>
              <Health tone={entry.present ? 'ok' : 'bad'} label={entry.present ? 'set' : 'missing'} />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  caption {
    text-align: left;
    padding-bottom: var(--space-2);
  }
</style>
