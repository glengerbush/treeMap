<script>
  import { onMount, onDestroy } from 'svelte';

  const TERMINAL_PHASES = ['done', 'noop', 'failed', 'rolled-back'];

  let state = $state({
    current: null,
    running: false,
    status: null,
    offlineBundles: [],
    error: null,
    triggered: false,
    triggeredAt: null,
    finishedPhase: null,
    checking: false,
    showHelp: false
  });

  let pollTimer = null;
  let fastPoll = false;

  async function refresh() {
    try {
      const res = await fetch('/api/update/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      state.current = data.current;
      state.running = data.running;
      state.status = data.status;
      state.offlineBundles = data.offlineBundles || [];
      state.error = null;

      const phase = data.status?.phase;
      // Only treat a terminal phase as ours if the status file has been
      // rewritten since we clicked. Otherwise we'd latch onto a previous
      // run's leftover status during the race between POST returning and
      // the spawned update.mjs calling writeStatus().
      const statusFresh =
        !!data.status?.updatedAt &&
        !!state.triggeredAt &&
        data.status.updatedAt > state.triggeredAt;
      if (state.triggered && !data.running && statusFresh && TERMINAL_PHASES.includes(phase)) {
        state.finishedPhase = phase;
        fastPoll = false;
      }
      if (data.running || (state.triggered && !state.finishedPhase)) {
        fastPoll = true;
      }
    } catch (e) {
      // Most likely a brief outage during the server restart — keep polling fast.
      state.error = e.message;
      if (state.triggered) fastPoll = true;
    } finally {
      schedule();
    }
  }

  function schedule() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, fastPoll ? 1500 : 30000);
  }

  async function triggerUpdate() {
    state.triggered = true;
    state.triggeredAt = new Date().toISOString();
    state.finishedPhase = null;
    fastPoll = true;
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
    } catch (e) {
      state.error = e.message;
    }
    refresh();
  }

  async function checkForUpdate() {
    state.checking = true;
    state.error = null;
    try {
      const res = await fetch('/api/update/check', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.current = data.current;
      state.running = data.running;
      state.status = data.status;
      state.offlineBundles = data.offlineBundles || [];
      if (data.checkError) state.error = data.checkError;
    } catch (e) {
      state.error = e.message;
    } finally {
      state.checking = false;
    }
  }

  function reload() {
    window.location.reload();
  }

  onMount(refresh);
  onDestroy(() => { if (pollTimer) clearTimeout(pollTimer); });

  let hasOfflineBundle = $derived(state.offlineBundles.length > 0);

  let label = $derived.by(() => {
    switch (state.finishedPhase) {
      case 'done': return `Updated to v${state.current?.version ?? ''}`;
      case 'noop': return 'Already up to date';
      case 'failed': return 'Update failed';
      case 'rolled-back': return 'Rolled back to previous version';
    }
    if (state.running || state.triggered) {
      const phase = state.status?.phase || 'starting';
      return `Updating: ${phase}`;
    }
    if (state.current?.version) return `v${state.current.version}`;
    return '';
  });

  let targetLabel = $derived.by(() => {
    const v = state.current?.targetVersion || state.current?.targetSha?.slice(0, 7);
    if (!v) return 'Apply update';
    return hasOfflineBundle ? `Update to v${v} (offline bundle)` : `Update to v${v}`;
  });

  let canUpdate = $derived(
    (hasOfflineBundle || !!state.current?.updateAvailable) &&
    !state.running && !state.triggered
  );

  let canCheck = $derived(
    !!state.current &&
    !canUpdate &&
    !state.running &&
    !state.triggered &&
    !state.finishedPhase
  );

  let canReload = $derived(state.finishedPhase === 'done');
  let canDismiss = $derived(
    state.finishedPhase === 'noop' ||
    state.finishedPhase === 'failed' ||
    state.finishedPhase === 'rolled-back'
  );

  function dismiss() {
    state.triggered = false;
    state.triggeredAt = null;
    state.finishedPhase = null;
    state.error = null;
  }
</script>

{#if state.current || state.error}
  <div class="update-badge" class:active={state.running || state.triggered}>
    <span class="label">{label}</span>
    {#if canReload}
      <button type="button" onclick={reload}>Reload</button>
    {:else if canDismiss}
      <button type="button" onclick={dismiss}>Dismiss</button>
    {:else if canUpdate}
      <button
        type="button"
        class="icon-btn"
        onclick={triggerUpdate}
        title={targetLabel}
        aria-label={targetLabel}
      >↑</button>
    {:else if canCheck}
      <button
        type="button"
        class="icon-btn"
        onclick={checkForUpdate}
        disabled={state.checking}
        title="Check for updates"
        aria-label="Check for updates"
      >↻</button>
    {/if}
    {#if !state.running && !state.triggered}
      <button
        type="button"
        class="help-toggle"
        aria-label="Offline update instructions"
        onclick={() => (state.showHelp = !state.showHelp)}
      >?</button>
    {/if}
    {#if state.error && !state.running}
      <span class="error" title={state.error}>!</span>
    {/if}
  </div>
  {#if state.showHelp}
    <div class="update-help">
      <strong>Offline update</strong>
      <p>If this server has no internet, copy a bundle from a connected machine that has the repo cloned:</p>
      <pre>git bundle create treemap-update.bundle origin/main</pre>
      <p>Then place the file at <code>&lt;deployment&gt;/data/incoming/treemap-update.bundle</code> and click <em>Update</em>.</p>
      <button type="button" onclick={() => (state.showHelp = false)}>Close</button>
    </div>
  {/if}
{/if}

<style>
  .update-badge {
    position: fixed;
    bottom: 0.5rem;
    right: 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.6rem;
    background: rgba(20, 20, 20, 0.75);
    color: #eee;
    font: 12px/1.2 system-ui, sans-serif;
    border-radius: 4px;
    z-index: 9999;
    backdrop-filter: blur(4px);
  }
  .update-badge.active {
    background: rgba(40, 80, 140, 0.85);
  }
  .update-badge button {
    background: #fff;
    color: #222;
    border: 0;
    border-radius: 3px;
    padding: 0.15rem 0.5rem;
    font: inherit;
    cursor: pointer;
  }
  .update-badge button:hover { background: #f0f0f0; }
  .update-badge button.icon-btn {
    font-weight: bold;
    padding: 0.15rem 0.45rem;
    line-height: 1;
  }
  .update-badge button.icon-btn:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .update-badge .error {
    color: #ffb4b4;
    font-weight: bold;
    cursor: help;
  }
  .update-badge .help-toggle {
    background: transparent;
    color: #ddd;
    border: 1px solid #888;
    border-radius: 50%;
    width: 1.4em;
    height: 1.4em;
    padding: 0;
    line-height: 1;
    cursor: pointer;
  }
  .update-help {
    position: fixed;
    bottom: 2.5rem;
    right: 0.5rem;
    max-width: 320px;
    background: #fff;
    color: #222;
    padding: 0.6rem 0.8rem;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    font: 12px/1.4 system-ui, sans-serif;
    z-index: 9999;
  }
  .update-help p { margin: 0.3rem 0; }
  .update-help pre {
    background: #f3f3f3;
    padding: 0.3rem 0.5rem;
    border-radius: 3px;
    font-size: 11px;
    overflow-x: auto;
  }
  .update-help code { background: #f3f3f3; padding: 0 0.2rem; border-radius: 2px; }
  .update-help button {
    margin-top: 0.4rem;
    background: #eee;
    border: 0;
    border-radius: 3px;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
  }
</style>
