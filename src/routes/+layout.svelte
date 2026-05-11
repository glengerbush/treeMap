<script>
  import '../app.css';
  import UpdateBadge from '$lib/UpdateBadge.svelte';

  let { children } = $props();
</script>

{@render children()}
<UpdateBadge />
