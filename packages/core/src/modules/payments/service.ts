import { sql, type Kysely, type Selectable, type UpdateObject } from 'kysely';
import type { CoreDatabase } from '../../kernel/db.js';
import { newId } from '../../kernel/id.js';
import { money, type Money } from '../../kernel/money.js';
import { recordEvent, type OutboxTables } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import { checkProvider, type PaymentProvider, type ProviderData, type ProviderOutcome } from './provider.js';
import type {
  CaptureMode,
  PaymentSessionStatus,
  PaymentSessionTable,
  PaymentsTables,
  PaymentTransactionKind,
  PaymentTransactionStatus,
  PaymentTransactionTable,
} from './tables.js';

/**
 * Payment providers, which channels offer them and how they capture, payment sessions, and the
 * ledger of every provider call (ADR 0017, ADR 0018, ADR 0019). Providers are registered in code
 * by the composition root; merchants choose per channel which ones shoppers see.
 */
export interface ProviderChannel {
  readonly channelId: string;
  readonly captureMode: CaptureMode;
}

export interface PaymentProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly supportsDeferredCapture: boolean;
  /** Moves no real money. */
  readonly testMode: boolean;
  readonly channels: readonly ProviderChannel[];
}

export interface SetProviderChannelInput {
  readonly channelId: string;
  /** Defaults to `immediate`. */
  readonly captureMode?: CaptureMode;
}

/** A provider as a shopper sees it. */
export interface PaymentMethod {
  readonly providerId: string;
  readonly name: string;
}

export interface PaymentSession {
  readonly id: string;
  readonly cartId: string;
  readonly channelId: string;
  readonly providerId: string;
  /** The provider's display name, or its id if it is no longer registered. */
  readonly providerName: string;
  readonly amount: Money;
  readonly status: PaymentSessionStatus;
  readonly captureMode: CaptureMode;
  readonly capturedAmount: Money;
  /** When the authorization lapses, if the provider said. */
  readonly authorizationExpiresAt: Date | null;
  readonly reference: string | null;
  readonly data: ProviderData;
  readonly clientData: ProviderData;
  readonly createdAt: Date;
}

/** One provider call, as recorded in the append-only ledger. */
export interface PaymentTransaction {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: PaymentTransactionKind;
  readonly status: PaymentTransactionStatus;
  readonly amount: Money;
  readonly reference: string | null;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface AuthorizeInput {
  readonly sessionId: string;
  /** Must equal the amount the session was prepared for. */
  readonly amount: Money;
  readonly idempotencyKey: string;
}

export interface CaptureInput {
  readonly sessionId: string;
  /** Defaults to everything not captured yet. */
  readonly amount?: Money;
  /** Repeating a capture that succeeded with the same key returns the session unchanged. */
  readonly idempotencyKey: string;
}

export interface StartSessionInput {
  readonly cartId: string;
  readonly channelId: string;
  readonly providerId: string;
  readonly amount: Money;
  readonly email: string | null;
  readonly data: ProviderData;
}

export interface PaymentsDependencies {
  readonly providers: readonly PaymentProvider[];
}

export type StartSessionError = DomainError<'invalid_input' | 'payment_method_unavailable' | 'payment_initiation_failed'>;
export type SetProviderChannelsError = DomainError<'invalid_input' | 'payment_provider_not_found' | 'deferred_capture_unsupported'>;
export type AuthorizeError = DomainError<
  | 'payment_session_not_found'
  | 'payment_session_unusable'
  | 'payment_amount_mismatch'
  | 'payment_declined'
  | 'payment_requires_action'
  | 'payment_provider_failed'
>;
export type CancelAuthorizationError = DomainError<'payment_session_not_found' | 'payment_provider_failed'>;
export type CaptureError = DomainError<
  | 'invalid_input'
  | 'payment_session_not_found'
  | 'payment_not_capturable'
  | 'payment_capture_in_progress'
  | 'payment_declined'
  | 'payment_provider_failed'
>;

export interface PaymentsService {
  /** Every registered provider, with the channels that offer it. */
  listProviders(): Promise<PaymentProviderInfo[]>;
  /** Replaces the channels that offer a provider, and how each captures. Callers check the channels exist. */
  setProviderChannels(
    providerId: string,
    channels: readonly SetProviderChannelInput[],
  ): Promise<Result<PaymentProviderInfo, SetProviderChannelsError>>;
  /** Providers some channel still enables but this deployment no longer registers; they are not offered. */
  unregisteredProviders(): Promise<{ readonly providerId: string; readonly channelIds: readonly string[] }[]>;
  /** Registered providers the channel offers. */
  availableMethods(channelId: string): Promise<PaymentMethod[]>;
  /** Prepares a payment with the provider for a cart total. */
  startSession(input: StartSessionInput): Promise<Result<PaymentSession, StartSessionError>>;
  getSession(id: string): Promise<PaymentSession | undefined>;
  /**
   * Reserves the session's amount with its provider. Repeating it for an authorized session is
   * a no-op, so retries are safe. A `payment_requires_action` error carries the provider's
   * client data in `details.clientData`.
   */
  authorizeSession(input: AuthorizeInput): Promise<Result<PaymentSession, AuthorizeError>>;
  /** Releases an authorization; a session that is not authorized is left as it is. */
  cancelAuthorization(sessionId: string, idempotencyKey: string): Promise<Result<PaymentSession, CancelAuthorizationError>>;
  /**
   * Captures some or all of an authorization. One capture runs at a time per session; another
   * gets `payment_capture_in_progress`. A failure leaves the session as it was and records
   * `payment.capture_failed`.
   */
  captureSession(input: CaptureInput): Promise<Result<PaymentSession, CaptureError>>;
  /**
   * Sessions to be captured immediately that are still only authorized: their capture crashed,
   * or the provider failed. Excludes declined captures and those that failed too often.
   * `lastChangedBefore` spaces out the attempts.
   */
  sessionsAwaitingCapture(lastChangedBefore: Date, limit?: number): Promise<PaymentSession[]>;
  /**
   * Records `payment.authorization_expiring` once for each session with an uncaptured amount
   * whose authorization lapses before the given time. Returns how many it recorded.
   */
  warnExpiringAuthorizations(expiringBefore: Date): Promise<number>;
  /** The ledger of one session, oldest first. */
  listTransactions(sessionId: string): Promise<PaymentTransaction[]>;
}

export const PAYMENT_SESSION_CREATED = 'payment_session.created';
export const PAYMENT_AUTHORIZED = 'payment.authorized';
export const PAYMENT_CANCELED = 'payment.canceled';
/** An authorization could not be released: money stays reserved until someone acts. */
export const PAYMENT_CANCEL_FAILED = 'payment.cancel_failed';
export const PAYMENT_CAPTURED = 'payment.captured';
/** A capture failed: the money is still only authorized. */
export const PAYMENT_CAPTURE_FAILED = 'payment.capture_failed';
export const PAYMENT_AUTHORIZATION_EXPIRING = 'payment.authorization_expiring';

/** Provider data travels to and from storefronts; keep it small. */
export const MAX_PROVIDER_DATA_BYTES = 4096;
/** Automatic captures stop after this many provider errors; someone must look. */
export const MAX_AUTOMATIC_CAPTURE_ATTEMPTS = 5;
/** A capture claim older than this was abandoned (the process died while calling the provider). */
const CAPTURE_CLAIM_TIMEOUT = '5 minutes';

const CAPTURABLE: readonly PaymentSessionStatus[] = ['authorized', 'partially_captured'];

type Db = Kysely<PaymentsTables & OutboxTables>;
type ProviderResult = ProviderOutcome | { status: 'error'; reason: string };

export function createPaymentsService(database: CoreDatabase, deps: PaymentsDependencies): PaymentsService {
  const db: Db = database.withTables<PaymentsTables & OutboxTables>();
  const providers = new Map<string, PaymentProvider>();
  for (const provider of deps.providers) {
    checkProvider(provider);
    if (providers.has(provider.id)) throw new Error(`Payment provider "${provider.id}" is registered twice`);
    providers.set(provider.id, provider);
  }

  const channelsByProvider = async () => {
    const rows = await db.selectFrom('payment_provider_channel').selectAll().orderBy('channel_id').execute();
    const map = new Map<string, ProviderChannel[]>();
    for (const row of rows) {
      map.set(row.provider_id, [...(map.get(row.provider_id) ?? []), { channelId: row.channel_id, captureMode: row.capture_mode }]);
    }
    return map;
  };

  const toInfo = (provider: PaymentProvider, channels: readonly ProviderChannel[]): PaymentProviderInfo => ({
    id: provider.id,
    name: provider.name,
    supportsDeferredCapture: provider.supportsDeferredCapture ?? false,
    testMode: provider.testMode ?? false,
    channels,
  });

  const getSession = async (conn: Db, id: string) => {
    const row = await conn.selectFrom('payment_session').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toSession(row, providers.get(row.provider_id)?.name ?? row.provider_id);
  };

  /** Calls the provider outside any transaction; a thrown error becomes an `error` outcome. */
  async function callProvider(call: () => Promise<ProviderOutcome>): Promise<ProviderResult> {
    try {
      return await call();
    } catch (error) {
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Appends a ledger entry and applies the session changes it implies, in one transaction. */
  async function record(
    entry: { session: PaymentSession; kind: PaymentTransactionKind; outcome: ProviderResult; idempotencyKey: string; amount?: Money },
    sessionChanges: UpdateObject<PaymentsTables, 'payment_session'> | null,
    event?: { topic: string; payload: unknown },
  ) {
    const { session, kind, outcome, idempotencyKey } = entry;
    const amount = entry.amount ?? session.amount;
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('payment_transaction')
        .values({
          id: newId('ptx'),
          session_id: session.id,
          kind,
          status: outcome.status,
          currency: amount.currency,
          amount: amount.amount,
          reference: outcome.status === 'succeeded' ? outcome.reference : null,
          reason: outcome.status === 'failed' || outcome.status === 'error' ? outcome.reason : null,
          idempotency_key: idempotencyKey,
        })
        .execute();
      if (sessionChanges) {
        await trx
          .updateTable('payment_session')
          .set({ ...sessionChanges, updated_at: sql<Date>`now()` })
          .where('id', '=', session.id)
          .execute();
      }
      if (event) await recordEvent(trx, event.topic, event.payload);
    });
  }

  const releaseCaptureClaim = (sessionId: string) =>
    db.updateTable('payment_session').set({ capture_started_at: null }).where('id', '=', sessionId).execute();

  return {
    async listProviders() {
      const channels = await channelsByProvider();
      return [...providers.values()].map((p) => toInfo(p, channels.get(p.id) ?? []));
    },

    async setProviderChannels(providerId, channels) {
      const provider = providers.get(providerId);
      if (!provider) return err('payment_provider_not_found', `Payment provider "${providerId}" is not registered`);
      const rows = channels
        .map(({ channelId, captureMode = 'immediate' }) => ({ provider_id: providerId, channel_id: channelId, capture_mode: captureMode }))
        .sort((a, b) => a.channel_id.localeCompare(b.channel_id));
      if (new Set(rows.map((r) => r.channel_id)).size !== rows.length) {
        return err('invalid_input', 'Each channel may appear only once');
      }
      if (!provider.supportsDeferredCapture && rows.some((r) => r.capture_mode === 'manual')) {
        return err('deferred_capture_unsupported', `${provider.name} can only capture immediately`);
      }
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('payment_provider_channel').where('provider_id', '=', providerId).execute();
        if (rows.length > 0) await trx.insertInto('payment_provider_channel').values(rows).execute();
      });
      return ok(toInfo(provider, rows.map((r) => ({ channelId: r.channel_id, captureMode: r.capture_mode }))));
    },

    async unregisteredProviders() {
      const channels = await channelsByProvider();
      return [...channels]
        .filter(([providerId]) => !providers.has(providerId))
        .map(([providerId, list]) => ({ providerId, channelIds: list.map((c) => c.channelId) }));
    },

    async availableMethods(channelId) {
      const rows = await db
        .selectFrom('payment_provider_channel')
        .select('provider_id')
        .where('channel_id', '=', channelId)
        .orderBy('provider_id')
        .execute();
      // A provider enabled once but no longer registered is simply not offered.
      return rows.flatMap(({ provider_id }) => {
        const provider = providers.get(provider_id);
        return provider ? [{ providerId: provider.id, name: provider.name }] : [];
      });
    },

    async startSession(input) {
      const provider = providers.get(input.providerId);
      const enabled =
        provider &&
        (await db
          .selectFrom('payment_provider_channel')
          .select('capture_mode')
          .where('provider_id', '=', input.providerId)
          .where('channel_id', '=', input.channelId)
          .executeTakeFirst());
      if (!provider || !enabled) {
        return err('payment_method_unavailable', `Payment method "${input.providerId}" is not offered in this channel`);
      }
      if (JSON.stringify(input.data).length > MAX_PROVIDER_DATA_BYTES) {
        return err('invalid_input', `Payment data must be at most ${MAX_PROVIDER_DATA_BYTES} bytes`);
      }

      const id = newId('pays');
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('payment_session')
          .values({
            id,
            cart_id: input.cartId,
            channel_id: input.channelId,
            provider_id: provider.id,
            currency: input.amount.currency,
            amount: input.amount.amount,
            reference: null,
            data: JSON.stringify(input.data),
            client_data: '{}',
            capture_mode: enabled.capture_mode,
            authorization_expires_at: null,
            expiry_warned_at: null,
            capture_started_at: null,
          })
          .execute();
        await recordEvent(trx, PAYMENT_SESSION_CREATED, { id, cartId: input.cartId, providerId: provider.id });
      });

      // The provider is called outside any transaction: no database locks are held during I/O.
      try {
        const result = await provider.initiate({
          sessionId: id,
          amount: { amount: input.amount.amount, currency: input.amount.currency },
          email: input.email,
          data: input.data,
          idempotencyKey: `${id}:initiate`,
        });
        await db
          .updateTable('payment_session')
          .set({ reference: result.reference, client_data: JSON.stringify(result.clientData), updated_at: sql<Date>`now()` })
          .where('id', '=', id)
          .execute();
      } catch (error) {
        await db.updateTable('payment_session').set({ status: 'failed', updated_at: sql<Date>`now()` }).where('id', '=', id).execute();
        const reason = error instanceof Error ? error.message : String(error);
        return err('payment_initiation_failed', `${provider.name} could not prepare the payment: ${reason}`);
      }
      return ok((await getSession(db, id))!);
    },

    getSession: (id) => getSession(db, id),

    async authorizeSession({ sessionId, amount, idempotencyKey }) {
      const session = await getSession(db, sessionId);
      if (!session) return err('payment_session_not_found', `Payment session "${sessionId}" not found`);
      if (session.status === 'authorized' || session.status === 'partially_captured' || session.status === 'captured') {
        return ok(session);
      }
      if (session.status === 'failed' || session.status === 'canceled') {
        return err('payment_session_unusable', `Payment session "${sessionId}" is ${session.status}; choose a payment method again`);
      }
      if (session.amount.amount !== amount.amount || session.amount.currency !== amount.currency) {
        return err('payment_amount_mismatch', 'The payment was prepared for a different amount');
      }
      const provider = providers.get(session.providerId);
      if (!provider) return err('payment_provider_failed', `Payment provider "${session.providerId}" is not registered`);

      const outcome = await callProvider(() =>
        provider.authorize({
          sessionId,
          reference: session.reference,
          amount: { amount: amount.amount, currency: amount.currency },
          data: session.data,
          idempotencyKey,
        }),
      );
      const entry = { session, kind: 'authorize' as const, outcome, idempotencyKey };
      switch (outcome.status) {
        case 'succeeded':
          await record(
            entry,
            { status: 'authorized', reference: outcome.reference, authorization_expires_at: parseExpiry(outcome.expiresAt) },
            { topic: PAYMENT_AUTHORIZED, payload: { sessionId, cartId: session.cartId, amount: amount.amount, currency: amount.currency } },
          );
          return ok((await getSession(db, sessionId))!);
        case 'failed':
          await record(entry, { status: 'failed' });
          return err('payment_declined', `The payment was declined: ${outcome.reason}`);
        case 'requires_action':
          await record(entry, { status: 'requires_action', client_data: JSON.stringify(outcome.clientData) });
          return err('payment_requires_action', 'The shopper must complete an action before paying', {
            clientData: outcome.clientData,
          });
        case 'error':
          // The provider may or may not have reserved money; the session stays usable for a retry
          // with the same idempotency key.
          await record(entry, null);
          return err('payment_provider_failed', `${provider.name} failed to authorize the payment: ${outcome.reason}`);
      }
    },

    async cancelAuthorization(sessionId, idempotencyKey) {
      const session = await getSession(db, sessionId);
      if (!session) return err('payment_session_not_found', `Payment session "${sessionId}" not found`);
      if (session.status !== 'authorized') return ok(session);
      const provider = providers.get(session.providerId);
      const outcome = provider
        ? await callProvider(() =>
            provider.cancel({
              sessionId,
              reference: session.reference,
              amount: { amount: session.amount.amount, currency: session.amount.currency },
              data: session.data,
              idempotencyKey,
            }),
          )
        : { status: 'error' as const, reason: `Payment provider "${session.providerId}" is not registered` };

      const entry = { session, kind: 'cancel' as const, outcome, idempotencyKey };
      if (outcome.status === 'succeeded') {
        await record(entry, { status: 'canceled' }, { topic: PAYMENT_CANCELED, payload: { sessionId, cartId: session.cartId } });
        return ok((await getSession(db, sessionId))!);
      }
      const reason = outcome.status === 'requires_action' ? 'the provider asked for an action' : outcome.reason;
      await record(entry, null, { topic: PAYMENT_CANCEL_FAILED, payload: { sessionId, cartId: session.cartId, reason } });
      return err('payment_provider_failed', `Could not release the authorization: ${reason}`);
    },

    async captureSession({ sessionId, amount: requested, idempotencyKey }) {
      const found = await getSession(db, sessionId);
      if (!found) return err('payment_session_not_found', `Payment session "${sessionId}" not found`);
      const replayed = await db
        .selectFrom('payment_transaction')
        .select('id')
        .where('session_id', '=', sessionId)
        .where('kind', '=', 'capture')
        .where('status', '=', 'succeeded')
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (replayed) return ok(found);

      // Claim the session, so that two captures cannot both take the same uncaptured amount.
      const claimed = await db
        .updateTable('payment_session')
        .set({ capture_started_at: sql<Date>`now()` })
        .where('id', '=', sessionId)
        .where('status', 'in', CAPTURABLE)
        .where((eb) =>
          eb.or([
            eb('capture_started_at', 'is', null),
            eb('capture_started_at', '<', sql<Date>`now() - ${CAPTURE_CLAIM_TIMEOUT}::interval`),
          ]),
        )
        .returningAll()
        .executeTakeFirst();
      if (!claimed) {
        const current = (await getSession(db, sessionId))!;
        return CAPTURABLE.includes(current.status)
          ? err('payment_capture_in_progress', 'Another capture of this payment is in progress')
          : err('payment_not_capturable', `The payment is ${current.status}; only authorized payments can be captured`, {
              status: current.status,
            });
      }
      const session = toSession(claimed, found.providerName);

      const remaining = session.amount.amount - session.capturedAmount.amount;
      const amount = requested ?? money(remaining, session.amount.currency);
      if (amount.currency !== session.amount.currency || amount.amount <= 0 || amount.amount > remaining) {
        await releaseCaptureClaim(sessionId);
        return err('invalid_input', `The amount must be between 1 and ${remaining} ${session.amount.currency}`);
      }
      const provider = providers.get(session.providerId);
      const outcome = provider
        ? await callProvider(() =>
            provider.capture({
              sessionId,
              reference: session.reference,
              amount: { amount: amount.amount, currency: amount.currency },
              data: session.data,
              idempotencyKey,
            }),
          )
        : { status: 'error' as const, reason: `Payment provider "${session.providerId}" is not registered` };

      const entry = { session, kind: 'capture' as const, outcome, idempotencyKey, amount };
      if (outcome.status === 'succeeded') {
        await record(
          entry,
          {
            captured_amount: sql<number>`captured_amount + ${amount.amount}`,
            status: sql<PaymentSessionStatus>`case when captured_amount + ${amount.amount} >= amount then 'captured' else 'partially_captured' end`,
            capture_started_at: null,
          },
          { topic: PAYMENT_CAPTURED, payload: { sessionId, cartId: session.cartId, amount: amount.amount, currency: amount.currency } },
        );
        return ok((await getSession(db, sessionId))!);
      }
      const reason = outcome.status === 'requires_action' ? 'the provider asked for an action' : outcome.reason;
      await record(entry, { capture_started_at: null }, {
        topic: PAYMENT_CAPTURE_FAILED,
        payload: { sessionId, cartId: session.cartId, amount: amount.amount, currency: amount.currency, reason },
      });
      return outcome.status === 'error'
        ? err('payment_provider_failed', `Could not capture the payment: ${reason}`)
        : err('payment_declined', `The capture was declined: ${reason}`);
    },

    async sessionsAwaitingCapture(lastChangedBefore, limit = 100) {
      const rows = await db
        .selectFrom('payment_session as s')
        .selectAll('s')
        .where('s.status', '=', 'authorized')
        .where('s.capture_mode', '=', 'immediate')
        .where('s.updated_at', '<', lastChangedBefore)
        .where('s.capture_started_at', 'is', null)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('payment_transaction as t')
                .select('t.id')
                .whereRef('t.session_id', '=', 's.id')
                .where('t.kind', '=', 'capture')
                .where('t.status', 'in', ['failed', 'requires_action']),
            ),
          ),
        )
        .where((eb) =>
          eb(
            eb
              .selectFrom('payment_transaction as t')
              .select((e) => e.fn.countAll<number>().as('n'))
              .whereRef('t.session_id', '=', 's.id')
              .where('t.kind', '=', 'capture')
              .where('t.status', '=', 'error'),
            '<',
            MAX_AUTOMATIC_CAPTURE_ATTEMPTS,
          ),
        )
        // Newest first: sessions that never get captured (no order was placed) age out of the batch.
        .orderBy('s.updated_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => toSession(row, providers.get(row.provider_id)?.name ?? row.provider_id));
    },

    async warnExpiringAuthorizations(expiringBefore) {
      return db.transaction().execute(async (trx) => {
        const rows = await trx
          .updateTable('payment_session')
          .set({ expiry_warned_at: sql<Date>`now()` })
          .where('status', 'in', CAPTURABLE)
          .where('expiry_warned_at', 'is', null)
          .where('authorization_expires_at', '<', expiringBefore)
          .returning(['id', 'cart_id', 'authorization_expires_at', 'amount', 'captured_amount', 'currency'])
          .execute();
        for (const row of rows) {
          await recordEvent(trx, PAYMENT_AUTHORIZATION_EXPIRING, {
            sessionId: row.id,
            cartId: row.cart_id,
            expiresAt: row.authorization_expires_at!.toISOString(),
            uncapturedAmount: Number(row.amount) - Number(row.captured_amount),
            currency: row.currency,
          });
        }
        return rows.length;
      });
    },

    async listTransactions(sessionId) {
      const rows = await db
        .selectFrom('payment_transaction')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(toTransaction);
    },
  };
}

/** A provider's expiry, if it gave a valid one. */
function parseExpiry(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toTransaction(row: Selectable<PaymentTransactionTable>): PaymentTransaction {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    amount: money(Number(row.amount), row.currency),
    reference: row.reference,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function toSession(row: Selectable<PaymentSessionTable>, providerName: string): PaymentSession {
  return {
    id: row.id,
    cartId: row.cart_id,
    channelId: row.channel_id,
    providerId: row.provider_id,
    providerName,
    amount: money(Number(row.amount), row.currency),
    status: row.status,
    captureMode: row.capture_mode,
    capturedAmount: money(Number(row.captured_amount), row.currency),
    authorizationExpiresAt: row.authorization_expires_at,
    reference: row.reference,
    data: row.data,
    clientData: row.client_data,
    createdAt: row.created_at,
  };
}
