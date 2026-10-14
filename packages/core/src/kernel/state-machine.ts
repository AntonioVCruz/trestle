/**
 * Explicit, declarative state machines for checkout, order, payment and fulfillment (ADR 0005).
 * The definition is data, so it can be documented, rendered in the admin and extended.
 */
export interface StateMachineDefinition<S extends string> {
  readonly name: string;
  readonly initial: NoInfer<S>;
  /** Every state must appear as a key; an empty list marks a final state. */
  readonly transitions: { readonly [K in S]: readonly NoInfer<S>[] };
}

export interface StateMachine<S extends string> extends StateMachineDefinition<S> {
  readonly states: readonly S[];
  can(from: S, to: S): boolean;
  /** Throws InvalidTransitionError if the transition is not allowed. */
  assert(from: S, to: S): void;
  next(from: S): readonly S[];
  isFinal(state: S): boolean;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${machine}: cannot transition from "${from}" to "${to}"`);
    this.name = 'InvalidTransitionError';
  }
}

export function defineStateMachine<const S extends string>(
  definition: StateMachineDefinition<S>,
): StateMachine<S> {
  const transitions: Readonly<Record<string, readonly string[]>> = definition.transitions;
  const states = Object.keys(transitions) as S[];

  if (!(definition.initial in transitions)) {
    throw new Error(`${definition.name}: initial state "${definition.initial}" is not defined`);
  }
  for (const [from, targets] of Object.entries(transitions)) {
    for (const to of targets) {
      if (!(to in transitions)) {
        throw new Error(`${definition.name}: transition "${from}" -> "${to}" targets an undefined state`);
      }
    }
  }

  const next = (from: S): readonly S[] => definition.transitions[from];
  const can = (from: S, to: S): boolean => next(from).includes(to);

  return Object.freeze({
    ...definition,
    states,
    can,
    next,
    isFinal: (state: S) => next(state).length === 0,
    assert(from: S, to: S) {
      if (!can(from, to)) throw new InvalidTransitionError(definition.name, from, to);
    },
  });
}
