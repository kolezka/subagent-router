<script lang="ts">
  interface Props {
    tone?: 'ok' | 'warn' | 'bad' | 'idle' | 'info';
    label: string;
  }

  let { tone = 'idle', label }: Props = $props();
</script>

<span class="badge {tone}">{label}</span>

<style>
  .badge {
    display: inline-block;
    padding: 0 7px;
    border-radius: var(--radius-pill);
    font-size: var(--size-1);
    line-height: 17px;
    border: 1px solid var(--border);
    color: var(--muted);
    white-space: nowrap;
  }

  .badge.ok {
    color: var(--green);
    border-color: var(--green);
  }
  .badge.warn {
    color: var(--amber);
    border-color: var(--amber);
  }
  .badge.bad {
    color: var(--red);
    border-color: var(--red);
  }
  .badge.info {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
