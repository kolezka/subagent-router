<script lang="ts">
  // A health light is a dot plus a word. The word is never optional: an operator with a colour
  // vision deficiency, or a screenshot in greyscale, still reads the state.
  export type Tone = 'ok' | 'warn' | 'bad' | 'idle';

  interface Props {
    tone: Tone;
    label: string;
    detail?: string;
  }

  let { tone, label, detail }: Props = $props();
</script>

<span class="health">
  <span class="dot {tone}" aria-hidden="true"></span>
  <span class="label {tone}">{label}</span>
  {#if detail !== undefined && detail !== ''}<span class="detail">{detail}</span>{/if}
</span>

<style>
  .health {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--size-3);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    flex-shrink: 0;
    align-self: center;
  }

  .dot.ok {
    background: var(--green);
  }
  .dot.warn {
    background: var(--amber);
  }
  .dot.bad {
    background: var(--red);
  }
  .dot.idle {
    background: var(--muted);
  }

  .label.ok {
    color: var(--green);
  }
  .label.warn {
    color: var(--amber);
  }
  .label.bad {
    color: var(--red);
  }
  .label.idle {
    color: var(--muted);
  }

  .detail {
    color: var(--muted);
    font-size: var(--size-2);
  }
</style>
