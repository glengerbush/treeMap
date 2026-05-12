import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // LAN-only app reached via multiple host names/IPs; SvelteKit's
    // default CSRF guard rejects POSTs (e.g. photo uploads) when the
    // Origin header doesn't match the server's computed host.
    csrf: { checkOrigin: false }
  }
};

export default config;
