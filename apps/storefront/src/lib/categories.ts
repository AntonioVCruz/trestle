import type { Category } from './types.js';

/**
 * The Store API returns categories as a flat list with `parentId` (ADR 0013); navigation,
 * breadcrumbs and child chips are all derived from it here, without extra calls.
 */
export interface CategoryNode extends Category {
  readonly children: readonly CategoryNode[];
}

export function buildCategoryTree(categories: readonly Category[]): CategoryNode[] {
  const byPosition = [...categories].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const childrenOf = (parentId: string | null): CategoryNode[] =>
    byPosition.filter((c) => c.parentId === parentId).map((c) => ({ ...c, children: childrenOf(c.id) }));
  return childrenOf(null);
}

/** Every node in the tree, depth first. */
export function flattenTree(nodes: readonly CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

/** The category and its ancestors, root first. */
export function categoryPath(nodes: readonly CategoryNode[], id: string): CategoryNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const below = categoryPath(node.children, id);
    if (below.length > 0) return [node, ...below];
  }
  return [];
}

/**
 * A product's breadcrumb: the longest path among its categories, so a tee in both Women and
 * Women › Tops reads Home › Women › Tops. Ties go to the category listed first.
 */
export function deepestPath(nodes: readonly CategoryNode[], ids: readonly string[]): CategoryNode[] {
  return ids.map((id) => categoryPath(nodes, id)).reduce<CategoryNode[]>((best, path) => (path.length > best.length ? path : best), []);
}
