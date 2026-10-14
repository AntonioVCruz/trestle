import { describe, expect, it } from 'vitest';
import { buildCategoryTree, categoryPath, deepestPath, flattenTree } from './categories.js';
import type { Category } from './types.js';

const cat = (id: string, parentId: string | null, position: number, name = id): Category => ({ id, parentId, handle: id, name, position });

const flat = [cat('tops', 'women', 0), cat('men', null, 1), cat('women', null, 0), cat('outerwear', 'women', 2), cat('bottoms', 'women', 1)];

describe('categories', () => {
  it('nests children under their parents, ordered by position', () => {
    const tree = buildCategoryTree(flat);
    expect(tree.map((c) => c.id)).toEqual(['women', 'men']);
    expect(tree[0]?.children.map((c) => c.id)).toEqual(['tops', 'bottoms', 'outerwear']);
    expect(tree[1]?.children).toEqual([]);
  });

  it('flattens depth first', () => {
    expect(flattenTree(buildCategoryTree(flat)).map((c) => c.id)).toEqual(['women', 'tops', 'bottoms', 'outerwear', 'men']);
  });

  it('walks up to the root for breadcrumbs', () => {
    const tree = buildCategoryTree(flat);
    expect(categoryPath(tree, 'bottoms').map((c) => c.id)).toEqual(['women', 'bottoms']);
    expect(categoryPath(tree, 'men').map((c) => c.id)).toEqual(['men']);
    expect(categoryPath(tree, 'missing')).toEqual([]);
  });

  it('gives a product the deepest of its categories as breadcrumb', () => {
    const tree = buildCategoryTree(flat);
    expect(deepestPath(tree, ['women', 'tops', 'men']).map((c) => c.id)).toEqual(['women', 'tops']);
    expect(deepestPath(tree, ['men', 'women']).map((c) => c.id)).toEqual(['men']);
    expect(deepestPath(tree, [])).toEqual([]);
  });
});
