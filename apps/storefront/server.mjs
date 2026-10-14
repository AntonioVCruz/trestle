// Starts the built storefront (`npm run build` first). It refuses to start without a
// publishable key: without one every page would fail, yet the process would look healthy.
// Whether the key is valid, and the Store API reachable, is what /health/ready reports.
if (!process.env.TRESTLE_PUBLISHABLE_KEY?.trim()) {
  console.error(
    'TRESTLE_PUBLISHABLE_KEY is not set. The storefront needs a channel’s publishable key ' +
      '(ADR 0004); `npm run seed` creates a demo channel and prints one.',
  );
  process.exit(1);
}

await import('./dist/server/entry.mjs');
