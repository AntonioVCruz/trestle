import type { Product, Variant } from './types.js';

/**
 * Option selection on the product page (wireframe 1l). Pure, so the server renders the first
 * state and the browser runs the same rules on every change.
 */

/** The value picked for each option, by option name. Options not picked yet are absent. */
export type Picks = Readonly<Record<string, string>>;

type ProductOptions = Pick<Product, 'options' | 'variants'>;

/** The query parameter a picked value travels in when the page works without JavaScript. */
export const optionParam = (name: string) => `o:${name}`;

export function variantPicks(variant: Variant): Picks {
  return Object.fromEntries(variant.options.map((o) => [o.name, o.value]));
}

function matches(variant: Variant, picks: Picks): boolean {
  return Object.entries(picks).every(([name, value]) => variant.options.some((o) => o.name === name && o.value === value));
}

function without(picks: Picks, name: string): Picks {
  const { [name]: _, ...rest } = picks;
  return rest;
}

/** The variant the picks resolve to, once every option has a value. */
export function resolveVariant(product: ProductOptions, picks: Picks): Variant | undefined {
  if (product.options.some((o) => picks[o.name] === undefined)) return undefined;
  return product.variants.find((v) => matches(v, picks));
}

/**
 * The picks a page opens with: the shared `?variant=` if there is one, then values picked
 * without JavaScript, then the first variant. Rule 1 says the first variant in stock; stock is
 * not in the Store API yet.
 */
export function initialPicks(product: ProductOptions, search: URLSearchParams): Picks {
  const shared = product.variants.find((v) => v.id === search.get('variant'));
  if (shared) return variantPicks(shared);
  const picked = Object.fromEntries(
    product.options.flatMap((o) => {
      const value = search.get(optionParam(o.name));
      return value !== null && o.values.includes(value) ? [[o.name, value]] : [];
    }),
  );
  if (Object.keys(picked).length > 0) return picked;
  const first = product.variants[0];
  return first ? variantPicks(first) : {};
}

export type ValueState = 'selected' | 'available' | 'unavailable';

/** Whether a value is picked, or would combine with the other picks into a real variant. */
export function valueState(product: ProductOptions, picks: Picks, option: string, value: string): ValueState {
  if (picks[option] === value) return 'selected';
  const candidate = { ...without(picks, option), [option]: value };
  return product.variants.some((v) => matches(v, candidate)) ? 'available' : 'unavailable';
}

export interface PurchaseState {
  /** The variant to add, once the picks resolve to one that has a price. */
  readonly variantId: string | null;
  /** What the Add to cart button says: the action, or what is missing (1h, rule 2). */
  readonly label: string;
}

export function purchaseState(product: ProductOptions, picks: Picks, currency: string): PurchaseState {
  const missing = product.options.find((o) => picks[o.name] === undefined);
  if (missing) return { variantId: null, label: `Select a ${missing.name.toLowerCase()}` };
  const variant = resolveVariant(product, picks);
  if (!variant) return { variantId: null, label: 'Unavailable' };
  if (!variant.price) return { variantId: null, label: `Not available in ${currency}` };
  return { variantId: variant.id, label: 'Add to cart' };
}

/**
 * Picks a value. Rule 2: other picks are never swapped for different values; one that no longer
 * combines with the new value is cleared, so the shopper chooses it again.
 */
export function pick(product: ProductOptions, picks: Picks, option: string, value: string): Picks {
  let next: Picks = { ...picks, [option]: value };
  for (const other of product.options) {
    const otherValue = next[other.name];
    if (other.name === option || otherValue === undefined) continue;
    const combined = { [option]: value, [other.name]: otherValue };
    if (!product.variants.some((v) => matches(v, combined))) next = without(next, other.name);
  }
  // With three or more options, every pair can exist while the whole combination does not.
  if (!product.variants.some((v) => matches(v, next))) next = { [option]: value };
  return next;
}
