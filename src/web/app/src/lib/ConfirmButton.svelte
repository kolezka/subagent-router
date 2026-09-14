<script lang="ts">
  // Two-step button for anything that writes outside the console: a sync, a restart, a bundle
  // written over existing files. The question names the consequence, not just "are you sure".
  interface Props {
    label: string;
    question: string;
    confirmLabel?: string;
    tone?: 'normal' | 'danger';
    disabled?: boolean;
    onconfirm: () => void;
  }

  let { label, question, confirmLabel = 'Yes, do it', tone = 'normal', disabled = false, onconfirm }: Props = $props();

  let asking = $state(false);
</script>

{#if asking}
  <span class="ask" role="group" aria-label={question}>
    <span class="question">{question}</span>
    <button
      type="button"
      class={tone === 'danger' ? 'danger' : 'primary'}
      onclick={() => {
        asking = false;
        onconfirm();
      }}>{confirmLabel}</button
    >
    <button type="button" onclick={() => (asking = false)}>Cancel</button>
  </span>
{:else}
  <button type="button" class={tone === 'danger' ? 'danger' : ''} {disabled} onclick={() => (asking = true)}>{label}</button>
{/if}

<style>
  .ask {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    border: 1px solid var(--amber);
    border-radius: var(--radius-1);
    padding: var(--space-1) var(--space-2);
  }

  .question {
    font-size: var(--size-2);
    color: var(--amber);
  }
</style>
