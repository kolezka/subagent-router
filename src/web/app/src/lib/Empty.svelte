<script lang="ts">
  interface Props {
    label: string;
    hint?: string;
  }

  let { label, hint }: Props = $props();
</script>

<div class="empty">
  <p class="label">{label}</p>
  {#if hint !== undefined}<p class="hint">{hint}</p>{/if}
</div>

<style>
  .empty {
    padding: var(--space-3) 0;
  }

  .label {
    margin: 0;
    color: var(--muted);
    font-size: var(--size-3);
  }

  .hint {
    margin: var(--space-1) 0 0 0;
    color: var(--muted);
    font-size: var(--size-2);
  }
</style>
