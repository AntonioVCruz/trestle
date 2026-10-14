import type { Kysely, Selectable } from 'kysely';
import type { CoreDatabase } from '../../kernel/db.js';
import { isId, newId } from '../../kernel/id.js';
import { money, type CurrencyCode, type Money } from '../../kernel/money.js';
import { recordEvent, type OutboxTables } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import type { Adjustment } from '../../kernel/totals.js';
import type { OrderStatus } from './rules.js';
import type { OrderTables, SalesOrderLineTable, SalesOrderTable, StoredAddress } from './tables.js';

/**
 * Orders (ADR 0018): an immutable record of what was bought, at what price, shipped where and
 * paid how. Everything is copied from the cart when the order is placed, so later catalog,
 * price or shipping changes never rewrite history.
 */
export type OrderAddress = StoredAddress;

export interface OrderLine {
  readonly id: string;
  readonly variantId: string;
  readonly productId: string;
  readonly productHandle: string;
  readonly productTitle: string;
  readonly variantTitle: string;
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly originalUnitPrice: Money | null;
  readonly subtotal: Money;
  readonly total: Money;
}

export interface Order {
  readonly id: string;
  /** Human-readable and sequential, e.g. 1001. */
  readonly number: number;
  readonly cartId: string;
  readonly channelId: string;
  readonly status: OrderStatus;
  readonly currency: CurrencyCode;
  readonly email: string;
  readonly shippingAddress: OrderAddress;
  readonly billingAddress: OrderAddress;
  readonly shippingMethod: { readonly optionId: string; readonly name: string; readonly amount: Money };
  readonly lines: readonly OrderLine[];
  readonly subtotal: Money;
  /** Line targets refer to this order's line ids. */
  readonly adjustments: readonly Adjustment[];
  readonly adjustmentsTotal: Money;
  readonly total: Money;
  readonly payment: { readonly providerId: string; readonly sessionId: string };
  readonly placedAt: Date;
}

export interface PlaceOrderLine extends Omit<OrderLine, 'id'> {
  /** The cart line it came from, so line adjustments can be re-targeted. */
  readonly cartLineId: string;
}

export interface PlaceOrderInput {
  readonly cartId: string;
  readonly channelId: string;
  readonly currency: CurrencyCode;
  readonly email: string;
  readonly shippingAddress: OrderAddress;
  readonly billingAddress: OrderAddress;
  readonly shippingMethod: Order['shippingMethod'];
  readonly lines: readonly PlaceOrderLine[];
  readonly subtotal: Money;
  readonly adjustments: readonly Adjustment[];
  readonly adjustmentsTotal: Money;
  readonly total: Money;
  readonly payment: Order['payment'];
}

export interface ListOrdersQuery {
  readonly channelId?: string;
  readonly limit: number;
  readonly after?: string;
}

export type PlaceOrderError = DomainError<'invalid_input'>;

export interface OrderService {
  /**
   * Records an order for a cart. Idempotent per cart: placing a cart that already has an order
   * returns that order unchanged.
   */
  placeOrder(input: PlaceOrderInput): Promise<Result<Order, PlaceOrderError>>;
  getOrder(id: string): Promise<Order | undefined>;
  getOrderByCart(cartId: string): Promise<Order | undefined>;
  /** Newest first. */
  listOrders(query: ListOrdersQuery): Promise<Result<OrderPage, ListOrdersError>>;
}

export interface OrderPage {
  readonly items: Order[];
  readonly nextCursor: string | null;
}

/** `after` is not a cursor this service handed out. */
export type ListOrdersError = DomainError<'invalid_cursor'>;

export const ORDER_PLACED = 'order.placed';
export const MAX_ORDER_PAGE_SIZE = 100;

type Db = Kysely<OrderTables & OutboxTables>;

export function createOrderService(database: CoreDatabase): OrderService {
  const db: Db = database.withTables<OrderTables & OutboxTables>();

  const load = async (conn: Db, rows: readonly Selectable<SalesOrderTable>[]) => {
    if (rows.length === 0) return [];
    const lines = await conn
      .selectFrom('sales_order_line')
      .selectAll()
      .where(
        'order_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('position')
      .execute();
    return rows.map((row) => toOrder(row, lines.filter((l) => l.order_id === row.id)));
  };

  const findBy = async (conn: Db, column: 'id' | 'cart_id', value: string) => {
    const row = await conn.selectFrom('sales_order').selectAll().where(column, '=', value).executeTakeFirst();
    return row && (await load(conn, [row]))[0];
  };

  return {
    async placeOrder(input) {
      if (input.lines.length === 0) return err('invalid_input', 'An order needs at least one line');
      const amounts = [input.subtotal, input.adjustmentsTotal, input.total, input.shippingMethod.amount, ...input.lines.map((l) => l.total)];
      if (amounts.some((m) => m.currency !== input.currency)) return err('invalid_input', 'Every amount must be in the order currency');

      const order = await db.transaction().execute(async (trx) => {
        const id = newId('ord');
        const lineIds = new Map(input.lines.map((l) => [l.cartLineId, newId('oline')]));
        const adjustments = input.adjustments.map((a) => ({
          ...a,
          amount: a.amount.amount,
          target: a.target.type === 'line' ? { type: 'line' as const, lineId: lineIds.get(a.target.lineId) ?? a.target.lineId } : a.target,
        }));

        const inserted = await trx
          .insertInto('sales_order')
          .values({
            id,
            cart_id: input.cartId,
            channel_id: input.channelId,
            currency: input.currency,
            email: input.email,
            shipping_address: JSON.stringify(input.shippingAddress),
            billing_address: JSON.stringify(input.billingAddress),
            shipping_method: JSON.stringify({ ...input.shippingMethod, amount: input.shippingMethod.amount.amount }),
            subtotal: input.subtotal.amount,
            adjustments: JSON.stringify(adjustments),
            adjustments_total: input.adjustmentsTotal.amount,
            total: input.total.amount,
            payment_provider_id: input.payment.providerId,
            payment_session_id: input.payment.sessionId,
          })
          .onConflict((oc) => oc.column('cart_id').doNothing())
          .returning(['id', 'number'])
          .executeTakeFirst();

        if (inserted) {
          await trx
            .insertInto('sales_order_line')
            .values(
              input.lines.map((line, position) => ({
                id: lineIds.get(line.cartLineId)!,
                order_id: id,
                position,
                variant_id: line.variantId,
                product_id: line.productId,
                product_handle: line.productHandle,
                product_title: line.productTitle,
                variant_title: line.variantTitle,
                sku: line.sku,
                quantity: line.quantity,
                unit_price: line.unitPrice.amount,
                original_unit_price: line.originalUnitPrice?.amount ?? null,
                subtotal: line.subtotal.amount,
                total: line.total.amount,
              })),
            )
            .execute();
          await recordEvent(trx, ORDER_PLACED, {
            id,
            number: Number(inserted.number),
            cartId: input.cartId,
            channelId: input.channelId,
            total: input.total.amount,
            currency: input.currency,
          });
        }
        return (await findBy(trx, 'cart_id', input.cartId))!;
      });
      return ok(order);
    },

    getOrder: (id) => findBy(db, 'id', id),

    getOrderByCart: (cartId) => findBy(db, 'cart_id', cartId),

    async listOrders({ channelId, limit, after }) {
      // The cursor is the last order's id; anything else would silently restart the listing.
      if (after !== undefined && !isId(after, 'ord')) return err('invalid_cursor', 'Pass back the nextCursor of a previous page as after');
      const size = Math.min(Math.max(Math.trunc(limit), 1), MAX_ORDER_PAGE_SIZE);
      const rows = await db
        .selectFrom('sales_order')
        .selectAll()
        .$if(channelId !== undefined, (q) => q.where('channel_id', '=', channelId!))
        .$if(after !== undefined, (q) => q.where('id', '<', after!))
        .orderBy('id', 'desc')
        .limit(size + 1)
        .execute();
      const page = rows.slice(0, size);
      return ok({ items: await load(db, page), nextCursor: rows.length > size ? page.at(-1)!.id : null });
    },
  };
}

function toOrder(row: Selectable<SalesOrderTable>, lines: readonly Selectable<SalesOrderLineTable>[]): Order {
  const amount = (value: string | number) => money(Number(value), row.currency);
  return {
    id: row.id,
    number: Number(row.number),
    cartId: row.cart_id,
    channelId: row.channel_id,
    status: row.status,
    currency: row.currency,
    email: row.email,
    shippingAddress: row.shipping_address,
    billingAddress: row.billing_address,
    shippingMethod: { ...row.shipping_method, amount: amount(row.shipping_method.amount) },
    lines: lines.map((l) => ({
      id: l.id,
      variantId: l.variant_id,
      productId: l.product_id,
      productHandle: l.product_handle,
      productTitle: l.product_title,
      variantTitle: l.variant_title,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: amount(l.unit_price),
      originalUnitPrice: l.original_unit_price === null ? null : amount(l.original_unit_price),
      subtotal: amount(l.subtotal),
      total: amount(l.total),
    })),
    subtotal: amount(row.subtotal),
    adjustments: row.adjustments.map((a) => ({ ...a, amount: amount(a.amount) })),
    adjustmentsTotal: amount(row.adjustments_total),
    total: amount(row.total),
    payment: { providerId: row.payment_provider_id, sessionId: row.payment_session_id },
    placedAt: row.placed_at,
  };
}
