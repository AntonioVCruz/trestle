import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationSources } from './core.js';
import { validateMigrations } from './kernel/module.js';

/** Enforces the module rules from ADR 0002 on every test run. */

const srcDir = dirname(fileURLToPath(import.meta.url));
const modulesDir = join(srcDir, 'modules');
const kernelDir = join(srcDir, 'kernel');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

function relativeImports(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  const specifiers = [...code.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]!);
  return specifiers.map((s) => resolve(dirname(file), s));
}

function moduleOf(path: string): string | undefined {
  const rel = relative(modulesDir, path);
  return rel.startsWith('..') ? undefined : rel.split(sep)[0];
}

describe('architecture', () => {
  it('modules only import other modules through their public index', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(modulesDir)) {
      const own = moduleOf(file);
      for (const target of relativeImports(file)) {
        const other = moduleOf(target);
        if (other && other !== own && target !== join(modulesDir, other, 'index.js')) {
          violations.push(`${relative(srcDir, file)} -> ${relative(srcDir, target)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the kernel never depends on modules', () => {
    const violations = sourceFiles(kernelDir)
      .filter((f) => !f.endsWith('.test.ts'))
      .flatMap((file) => relativeImports(file).filter((t) => moduleOf(t)).map((t) => `${file} -> ${t}`));
    expect(violations).toEqual([]);
  });

  it('every migration source has ordered, well-formed ids and unique names', () => {
    for (const source of migrationSources) validateMigrations(source);
    const names = migrationSources.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
