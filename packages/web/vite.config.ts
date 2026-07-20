import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

/* DEV_API_PROXY points `vite dev` at a running API (e.g. the audit stack)
   so frontend work gets hot reload without rebuilding the server image.
   Unset, dev behaves exactly as before; builds are unaffected either way. */
const proxyTarget = process.env.DEV_API_PROXY;

export default defineConfig({
  plugins: [sveltekit()],
  server: proxyTarget
    ? { proxy: { "/api": { target: proxyTarget, changeOrigin: true } } }
    : undefined,
});
