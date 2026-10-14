import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the wireframe source, which is edited in Claude Design rather than by hand.
 *
 * Claude Design's runtime rewrites camel-case attribute names (`fooBar=` → `sc-camel-foo-bar=`)
 * so the HTML parser keeps their case. It applies that rewrite to the whole template, visible
 * text included, and only undoes it inside real attributes. So a note like "nextCursor = null"
 * renders as "sc-camel-next-cursor = null". The runtime is not ours to fix, so the source must
 * never contain the pattern in visible text.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, 'storefront-wireframes.dc.html'), 'utf8');

/** The runtime's own pattern (support.js, CAMEL_ATTR_RE). */
const CAMEL_ATTR_RE = /(\s)([a-z]+[A-Z][A-Za-z0-9]*)(\s*=)/g;

/** What the runtime renders: the inner HTML of <x-dc>. The logic script sits outside it. */
function template(): string {
  const open = source.search(/<x-dc(\s[^>]*)?>/);
  const close = source.lastIndexOf('</x-dc>');
  if (open < 0 || close < open) throw new Error('No <x-dc> template found');
  return source.slice(source.indexOf('>', open) + 1, close);
}

/** Visible text only: styles dropped, tags replaced by a separator so words don't run together. */
function visibleText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '\n');
}

describe('reference storefront wireframes', () => {
  it('has no visible text that the design runtime would mangle', () => {
    const text = visibleText(template());
    const hits = [...text.matchAll(CAMEL_ATTR_RE)].map((m) => text.slice(m.index, m.index + 60).trim());
    // Write "nextCursor is null" rather than "nextCursor = null".
    expect(hits).toEqual([]);
  });

  it('detects the pattern it guards against', () => {
    expect(visibleText('<span>nextCursor = null</span>').match(CAMEL_ATTR_RE)).not.toBeNull();
    expect(visibleText('<span hintSize="x">nextCursor is null</span>').match(CAMEL_ATTR_RE)).toBeNull();
  });

  it('has exactly one exported PNG per screen', () => {
    const screens = [...source.matchAll(/class="dv-opt" id="([^"]+)"/g)].map((m) => m[1]).sort();
    const pngs = readdirSync(join(dir, 'screens'))
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace(/\.png$/, ''))
      .sort();
    expect(screens.length).toBeGreaterThan(0);
    expect(pngs).toEqual(screens);
  });

  it('indexes every screen in the README', () => {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    const screens = [...source.matchAll(/class="dv-opt" id="([^"]+)"/g)].map((m) => m[1]);
    const missing = screens.filter((id) => !readme.includes(`(screens/${id}.png)`));
    expect(missing).toEqual([]);
  });
});
