/**
 * Expected business failures are values, not exceptions (ADR 0003): services return a Result
 * and the API layer maps error codes to HTTP statuses. Exceptions are reserved for bugs and
 * infrastructure failures.
 */
export interface DomainError<Code extends string = string> {
  readonly code: Code;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Result<T, E extends DomainError = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<const Code extends string>(
  code: Code,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): { readonly ok: false; readonly error: DomainError<Code> } {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}
