import { defineStateMachine } from '../../kernel/state-machine.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';

/**
 * Only `published` products reach the Store API. Archiving is reversible through `draft`, so a
 * product is never published straight out of the archive by accident.
 */
export const productStatusMachine = defineStateMachine({
  name: 'product_status',
  initial: 'draft',
  transitions: {
    draft: ['published', 'archived'],
    published: ['draft', 'archived'],
    archived: ['draft'],
  },
});

export type ProductStatus = (typeof productStatusMachine.states)[number];

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_HANDLE_LENGTH = 100;

/** Handles are the stable, URL-safe names storefronts route by: `blue-t-shirt`. */
export function isHandle(value: string): boolean {
  return value.length <= MAX_HANDLE_LENGTH && HANDLE.test(value);
}

export interface ProductOption {
  readonly name: string;
  readonly values: readonly string[];
}

export interface VariantOptionValue {
  readonly name: string;
  readonly value: string;
}

export interface VariantInput {
  readonly sku?: string | null;
  readonly title?: string;
  /** One value for each of the product's options. */
  readonly options?: readonly VariantOptionValue[];
}

/** A variant that satisfies the product's options, with option values in option order. */
export interface PlannedVariant {
  readonly sku: string | null;
  readonly title: string;
  readonly options: readonly VariantOptionValue[];
}

export type InvalidInput = DomainError<'invalid_input'>;

export const DEFAULT_VARIANT_TITLE = 'Default';

/**
 * Validates a new product's options and variants (ADR 0007: every product has at least one
 * variant). A product without options and without variants gets one default variant.
 */
export function planVariants(
  options: readonly ProductOption[],
  variants: readonly VariantInput[],
): Result<PlannedVariant[], InvalidInput> {
  const checked = checkOptions(options);
  if (!checked.ok) return checked;

  if (variants.length === 0) {
    if (options.length > 0) return err('invalid_input', 'A product with options needs at least one variant');
    return ok([{ sku: null, title: DEFAULT_VARIANT_TITLE, options: [] }]);
  }

  const planned: PlannedVariant[] = [];
  for (const input of variants) {
    const variant = planVariant(options, planned, input);
    if (!variant.ok) return variant;
    const { sku } = variant.value;
    if (sku && planned.some((v) => v.sku === sku)) return err('invalid_input', `Duplicate SKU "${sku}"`);
    planned.push(variant.value);
  }
  return ok(planned);
}

/**
 * Validates one variant against the product's options and its existing variants: it must pick
 * exactly one known value per option, and no two variants may share a combination. SKUs are
 * unique across the catalog, which only the database can check.
 */
export function planVariant(
  options: readonly ProductOption[],
  existing: readonly Pick<PlannedVariant, 'options'>[],
  input: VariantInput,
): Result<PlannedVariant, InvalidInput> {
  const given = input.options ?? [];
  const picked: VariantOptionValue[] = [];
  for (const option of options) {
    const matches = given.filter((g) => g.name === option.name);
    if (matches.length !== 1) {
      return err('invalid_input', `Variant must have exactly one value for option "${option.name}"`);
    }
    const { value } = matches[0]!;
    if (!option.values.includes(value)) {
      return err('invalid_input', `"${value}" is not a value of option "${option.name}"`);
    }
    picked.push({ name: option.name, value });
  }
  const unknown = given.find((g) => !options.some((o) => o.name === g.name));
  if (unknown) return err('invalid_input', `Unknown option "${unknown.name}"`);

  const key = combinationKey(picked);
  if (existing.some((v) => combinationKey(v.options) === key)) {
    return err('invalid_input', options.length === 0
      ? 'A product without options can only have one variant'
      : `Another variant already has the options ${describe(picked)}`);
  }

  const sku = input.sku?.trim() || null;
  const title = input.title?.trim() || (picked.length > 0 ? picked.map((p) => p.value).join(' / ') : DEFAULT_VARIANT_TITLE);
  return ok({ sku, title, options: picked });
}

function checkOptions(options: readonly ProductOption[]): Result<void, InvalidInput> {
  const names = new Set<string>();
  for (const option of options) {
    const name = option.name.trim();
    if (!name || name !== option.name) return err('invalid_input', 'Option names must be non-empty and trimmed');
    if (names.has(name.toLowerCase())) return err('invalid_input', `Duplicate option "${name}"`);
    names.add(name.toLowerCase());

    if (option.values.length === 0) return err('invalid_input', `Option "${name}" needs at least one value`);
    const values = new Set<string>();
    for (const value of option.values) {
      if (!value.trim() || value.trim() !== value) {
        return err('invalid_input', `Values of option "${name}" must be non-empty and trimmed`);
      }
      if (values.has(value.toLowerCase())) return err('invalid_input', `Duplicate value "${value}" in option "${name}"`);
      values.add(value.toLowerCase());
    }
  }
  return ok(undefined);
}

function combinationKey(values: readonly VariantOptionValue[]): string {
  return JSON.stringify(values.map((v) => [v.name, v.value]));
}

function describe(values: readonly VariantOptionValue[]): string {
  return values.map((v) => `${v.name}=${v.value}`).join(', ');
}
