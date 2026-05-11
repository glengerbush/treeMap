<script>
  import { onMount, onDestroy } from 'svelte';

  let state = $state({
    current: null,
    running: false,
    status: null,
    error: null,
    triggered: false,
    finished: false
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
      state.error = null;

      const phase = data.status?.phase;
      const finished = phase === 'done' || phase === 'noop' || phase === 'failed';
      if (state.triggered && finished && !data.running) {
        state.finished = true;
        fastPoll = false;
      }
      if (data.running || (state.triggered && !state.finished)) {
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
    state.finished = false;
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

  function reload() {
    window.location.reload();
  }

  onMount(refresh);
  onDestroy(() => { if (pollTimer) clearTimeout(pollTimer); });

  let label = $derived.by(() => {
    if (state.finished) return 'Update installed';
    if (state.running || state.triggered) {
      const phase = state.status?.phase || 'starting';
      return `Updating: ${phase}`;
    }
    if (state.current?.updateAvailable) {
      const to = state.current.targetVersion || state.current.targetSha?.slice(0, 7) || 'new';
      return `Update to v${to}`;
    }
    if (state.current?.version) return `v${state.current.version}`;
    return '';
  });

  let canUpdate = $derived(
    !!state.current?.updateAvailable && !state.running && !state.triggered
  );
</script>

{#if state.current || state.error}
  <div class="update-badge" class:active={state.running || state.triggered}>
    <span class="label">{label}</span>
    {#if state.finished}
      <button type="button" onclick={reload}>Reload</button>
    {:else if canUpdate}
      <button type="button" onclick={triggerUpdate}>Update</button>
    {/if}
    {#if state.error && !state.running}
      <span class="error" title={state.error}>!</span>
    {/if}
  </div>
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
  .update-badge .error {
    color: #ffb4b4;
    font-weight: bold;
    cursor: help;
  }
</style>
