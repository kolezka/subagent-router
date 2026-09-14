<script lang="ts">
  interface Props {
    problems: readonly string[];
    warnings: readonly string[];
    emptyLabel?: string;
  }

  let { problems, warnings, emptyLabel = 'No problems found.' }: Props = $props();
</script>

<div class="findings">
  {#if problems.length === 0 && warnings.length === 0}
    <p class="ok-text">{emptyLabel}</p>
  {/if}
  {#if problems.length > 0}
    <div>
      <p class="heading bad-text">Problems ({problems.length})</p>
      <ul class="plain problems">
        {#each problems as problem (problem)}
          <li>{problem}</li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if warnings.length > 0}
    <div>
      <p class="heading warn-text">Warnings ({warnings.length})</p>
      <ul class="plain warnings">
        {#each warnings as warning (warning)}
          <li>{warning}</li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .findings {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--size-3);
  }

  .findings p {
    margin: 0 0 var(--space-1) 0;
  }

  .heading {
    font-size: var(--size-2);
    font-weight: 600;
  }
</style>
