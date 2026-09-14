<script lang="ts">
  import { onMount } from 'svelte';
  import { router, VIEWS, VIEW_LABELS, hrefFor } from './lib/router.svelte';
  import { store } from './lib/store.svelte';
  import Health from './lib/Health.svelte';
  import StatusView from './views/StatusView.svelte';
  import SetupView from './views/SetupView.svelte';
  import GatewayView from './views/GatewayView.svelte';
  import ModelsView from './views/ModelsView.svelte';
  import RoutingView from './views/RoutingView.svelte';
  import InstallView from './views/InstallView.svelte';
  import LogsView from './views/LogsView.svelte';
  import DiagnosticsView from './views/DiagnosticsView.svelte';

  onMount(() => {
    const stop = router.start();
    void store.refresh();
    return stop;
  });

  let status = $derived(store.status);
  let configTone = $derived(
    status === null ? 'idle' : status.configHealth === 'ok' ? 'ok' : status.configHealth === 'missing' ? 'warn' : 'bad',
  );
  let routerTone = $derived(status === null ? 'idle' : status.router.running ? (status.router.stale ? 'warn' : 'ok') : 'idle');
</script>

<a class="skip" href="#main">Skip to content</a>

<header>
  <h1>subagent-router</h1>
  <div class="meta">
    {#if status !== null}
      <span>v{status.version}</span>
      <span class="mono" title={status.configPath}>{status.configPath}</span>
      <span>generation {status.generation ?? 'none'}</span>
    {:else if store.error !== null}
      <span class="bad-text">status unavailable: {store.error.code}</span>
    {:else}
      <span>loading status...</span>
    {/if}
  </div>
  <span class="spacer"></span>
  <div class="lights">
    <Health tone={configTone as 'ok' | 'warn' | 'bad' | 'idle'} label="config {status?.configHealth ?? 'unknown'}" />
    <Health
      tone={routerTone as 'ok' | 'warn' | 'bad' | 'idle'}
      label="router {status === null ? 'unknown' : status.router.running ? 'running' : 'stopped'}"
    />
  </div>
  <button type="button" onclick={() => store.refresh()} disabled={store.loading}>
    {store.loading ? 'Refreshing' : 'Refresh'}
  </button>
</header>

<nav aria-label="Console sections">
  {#each VIEWS as view (view)}
    <a href={hrefFor(view)} class:active={router.current === view} aria-current={router.current === view ? 'page' : undefined}>
      {VIEW_LABELS[view]}
    </a>
  {/each}
</nav>

<main id="main">
  {#if router.current === 'status'}
    <StatusView />
  {:else if router.current === 'setup'}
    <SetupView />
  {:else if router.current === 'gateway'}
    <GatewayView />
  {:else if router.current === 'models'}
    <ModelsView />
  {:else if router.current === 'routing'}
    <RoutingView />
  {:else if router.current === 'install'}
    <InstallView />
  {:else if router.current === 'logs'}
    <LogsView />
  {:else if router.current === 'diagnostics'}
    <DiagnosticsView />
  {/if}
</main>

<style>
  .skip {
    position: absolute;
    left: -9999px;
    top: 0;
    background: var(--panel);
    color: var(--text);
    padding: var(--space-2) var(--space-3);
    z-index: 10;
  }

  .skip:focus {
    left: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }

  h1 {
    font-size: var(--size-5);
    letter-spacing: 0.01em;
  }

  .meta {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    color: var(--muted);
    font-size: var(--size-2);
    align-items: baseline;
  }

  .lights {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  nav {
    display: flex;
    gap: 2px;
    padding: 0 var(--space-4);
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  nav a {
    padding: 9px 14px;
    color: var(--muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    font-size: var(--size-3);
    white-space: nowrap;
  }

  nav a:hover {
    color: var(--text);
  }

  nav a.active {
    color: var(--text-strong);
    border-bottom-color: var(--accent);
  }

  main {
    padding: var(--space-4);
    max-width: 1280px;
    margin: 0 auto;
  }
</style>
