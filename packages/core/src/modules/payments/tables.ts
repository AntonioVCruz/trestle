import type { ColumnType, Generated } from 'kysely';
import type { ProviderData } from './provider.js';

/** `channel_id` is owned by the channel module: a plain id (ADR 0002). */
export interface PaymentProviderChannelTable {
  provider_id: string;
  channel_id: string;
  capture_mode: Generated<CaptureMode>;
}

/** When an authorized payment is captured (ADR 0019). */
export type CaptureMode = 'immediate' | 'manual';

export type PaymentSessionStatus =
  | 'pending'
  | 'requires_action'
  | 'authorized'
  | 'partially_captured'
  | 'captured'
  | 'canceled'
  | 'failed';

export type PaymentTransactionKind = 'authorize' | 'capture' | 'cancel' | 'refund';
/** `error` means the provider itself failed (threw), as opposed to declining. */
export type PaymentTransactionStatus = 'succeeded' | 'failed' | 'requires_action' | 'error';

export interface PaymentTransactionTable {
  id: string;
  session_id: string;
  kind: PaymentTransactionKind;
  status: PaymentTransactionStatus;
  currency: string;
  amount: ColumnType<string, number, number>;
  reference: string | null;
  reason: string | null;
  idempotency_key: string;
  created_at: Generated<Date>;
}

/** `cart_id` and `channel_id` belong to other modules: plain ids. */
export interface PaymentSessionTable {
  id: string;
  cart_id: string;
  channel_id: string;
  provider_id: string;
  currency: string;
  /** bigint: node-postgres returns it as a string. */
  amount: ColumnType<string, number, number>;
  status: Generated<PaymentSessionStatus>;
  reference: string | null;
  data: ColumnType<ProviderData, string, string>;
  client_data: ColumnType<ProviderData, string, string>;
  /** Copied from the channel's setting when the session is created. */
  capture_mode: CaptureMode;
  captured_amount: ColumnType<string, number | undefined, number>;
  authorization_expires_at: Date | null;
  expiry_warned_at: Date | null;
  /** Set while a capture is calling the provider, so only one runs at a time. */
  capture_started_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PaymentsTables = {
  payment_provider_channel: PaymentProviderChannelTable;
  payment_session: PaymentSessionTable;
  payment_transaction: PaymentTransactionTable;
};
