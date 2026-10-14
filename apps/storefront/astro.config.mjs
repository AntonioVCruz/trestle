import { fileURLToPath } from 'node:url';
import node from '@astrojs/node';
import { defineConfig, envField } from 'astro/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const building = process.argv.includes('build');

// Server-rendered on demand: every page reads the Store API through @trestle/sdk (ADR 0020).
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: {
    // Trust the Host header (and X-Forwarded-Host) whatever the domain. Without this, Astro
    // takes every request to be for localhost:<port>, so behind a port mapping, a proxy or a
    // real domain, its origin check rejects the storefront's own form posts with 403. The list
    // is fixed at build time, and one image serves any domain. Cross-site posts are still
    // refused (the browser sets Host itself), and the storefront never builds absolute URLs
    // from the host: its redirects and links are paths.
    allowedDomains: [{}],
  },
  env: {
    // Both are read at runtime, so one build serves any channel. The publishable key is not a
    // secret (ADR 0004); "secret" here only keeps Astro from inlining it at build time.
    schema: {
      TRESTLE_API_URL: envField.string({ context: 'server', access: 'secret', url: true, default: 'http://localhost:9000' }),
      TRESTLE_PUBLISHABLE_KEY: envField.string({ context: 'server', access: 'secret' }),
    },
    // Validating here would demand the key at build time (CI, image builds). `server.mjs` checks
    // it at start instead, and /health/ready checks that it works.
    validateSecrets: false,
  },
  vite: {
    // One .env at the repo root serves the server, the seed script and the storefront.
    envDir: repoRoot,
    resolve: {
      // Like the tests, run against the SDK's sources rather than its build output.
      alias: { '@trestle/sdk': fileURLToPath(new URL('../../packages/sdk/src/index.ts', import.meta.url)) },
    },
    // A build bundles its runtime dependencies into dist/, so the image needs no node_modules
    // (and none of Astro's build toolchain). Dev keeps Vite's usual handling.
    ssr: building ? { noExternal: true } : {},
  },
});
