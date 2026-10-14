import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against workspace sources, not build output.
    alias: {
      '@trestle/core': src('core'),
      '@trestle/api-store': src('api-store'),
      '@trestle/api-admin': src('api-admin'),
      '@trestle/sdk': src('sdk'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/storefront/wireframes/*.test.ts'],
  },
});
