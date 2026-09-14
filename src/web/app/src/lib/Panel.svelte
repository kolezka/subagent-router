<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title?: string;
    actions?: Snippet;
    children: Snippet;
  }

  let { title, actions, children }: Props = $props();
</script>

<section class="panel">
  {#if title !== undefined || actions !== undefined}
    <div class="head">
      {#if title !== undefined}<h2>{title}</h2>{/if}
      <span class="spacer"></span>
      {#if actions !== undefined}{@render actions()}{/if}
    </div>
  {/if}
  {@render children()}
</section>

<style>
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-4);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }

  h2 {
    font-size: var(--size-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    font-weight: 600;
  }
</style>
