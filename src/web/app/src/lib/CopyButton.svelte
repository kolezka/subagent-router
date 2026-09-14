<script lang="ts">
  interface Props {
    text: string;
    label?: string;
  }

  let { text, label = 'Copy' }: Props = $props();

  let state = $state<'idle' | 'copied' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(text);
      state = 'copied';
    } catch {
      // Clipboard access needs a secure context. 127.0.0.1 counts as one, but a console reached
      // over a plain-HTTP LAN address does not, so say so instead of claiming a copy happened.
      state = 'failed';
    }
    timer = setTimeout(() => {
      state = 'idle';
    }, 2000);
  }
</script>

<span class="wrap">
  <button type="button" onclick={copy}>{label}</button>
  <span class="status" aria-live="polite">
    {#if state === 'copied'}Copied{:else if state === 'failed'}Copy blocked, select the text{/if}
  </span>
</span>

<style>
  .wrap {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .status {
    color: var(--muted);
    font-size: var(--size-2);
  }
</style>
