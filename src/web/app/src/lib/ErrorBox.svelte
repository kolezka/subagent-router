<script lang="ts">
  import { GENERATION_CONFLICT, type ApiFailure } from './api';

  interface Props {
    error: ApiFailure;
    /** Given for anything that can be retried after a reload; required in practice for conflicts. */
    onreload?: () => void;
  }

  let { error, onreload }: Props = $props();

  let isConflict = $derived(error.code === GENERATION_CONFLICT);
</script>

<div class="error-box" class:conflict={isConflict} role="alert">
  <div class="line">
    <code class="code">{error.code}</code>
    <span class="message">{error.message}</span>
  </div>
  {#if isConflict}
    <p class="explain">
      The config file changed since this page read it, so the write was refused. Nothing was saved and
      nothing was retried. Reload to see the current config, then make the change again.
    </p>
  {/if}
  {#if onreload !== undefined}
    <div>
      <button type="button" onclick={onreload}>{isConflict ? 'Reload config' : 'Try again'}</button>
    </div>
  {/if}
</div>

<style>
  .error-box {
    border: 1px solid var(--red);
    border-radius: var(--radius-1);
    padding: var(--space-2) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--size-3);
  }

  .error-box.conflict {
    border-color: var(--amber);
  }

  .line {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .code {
    color: var(--red);
    font-weight: 600;
    flex-shrink: 0;
  }

  .conflict .code {
    color: var(--amber);
  }

  .message {
    color: var(--text);
    word-break: break-word;
  }

  .explain {
    margin: 0;
    color: var(--muted);
    font-size: var(--size-2);
  }
</style>
