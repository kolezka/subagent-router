<script lang="ts">
  interface Props {
    label?: string;
  }

  let { label = 'Loading' }: Props = $props();
</script>

<p class="loading" aria-live="polite">{label}...</p>

<style>
  .loading {
    color: var(--muted);
    font-size: var(--size-3);
    margin: 0;
    padding: var(--space-2) 0;
  }
</style>
