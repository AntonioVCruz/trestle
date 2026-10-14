import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import type { CaptureError, Order, OrderService, PaymentSession, PaymentsService, PaymentTransaction } from '@trestle/core';
import { DEFAULT_PAGE_SIZE, errorBody, ErrorSchema } from './schemas.js';

export interface OrderRoutesOptions {
  readonly orders: Pick<OrderService, 'getOrder' | 'listOrders'>;
  readonly payments: Pick<PaymentsService, 'getSession' | 'listTransactions' | 'captureSession'>;
}

const Amount = Type.Integer({ description: 'Minor units, in the order currency' });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const AddressSchema = Type.Object({
  firstName: Type.String(),
  lastName: Type.String(),
  company: NullableString,
  line1: Type.String(),
  line2: NullableString,
  city: Type.String(),
  postalCode: Type.String(),
  region: NullableString,
  country: Type.String(),
  phone: NullableString,
});

export const OrderSchema = Type.Object(
  {
    id: Type.String(),
    number: Type.Integer(),
    cartId: Type.String(),
    channelId: Type.String(),
    status: Type.Enum(['placed', 'completed', 'canceled']),
    currency: Type.String(),
    email: Type.String(),
    shippingAddress: AddressSchema,
    billingAddress: AddressSchema,
    shippingMethod: Type.Object({ optionId: Type.String(), name: Type.String(), amount: Amount }),
    lines: Type.Array(
      Type.Object({
        id: Type.String(),
        variantId: Type.String(),
        productId: Type.String(),
        productHandle: Type.String(),
        productTitle: Type.String(),
        variantTitle: Type.String(),
        sku: NullableString,
        quantity: Type.Integer(),
        unitPrice: Amount,
        originalUnitPrice: Type.Union([Amount, Type.Null()]),
        subtotal: Amount,
        total: Amount,
      }),
    ),
    subtotal: Amount,
    adjustments: Type.Array(
      Type.Object({
        kind: Type.String(),
        label: Type.String(),
        amount: Type.Integer(),
        lineId: NullableString,
        included: Type.Boolean(),
        source: Type.String({ description: 'The adjuster that produced it' }),
      }),
    ),
    adjustmentsTotal: Type.Integer(),
    total: Amount,
    payment: Type.Object({ providerId: Type.String(), sessionId: Type.String() }),
    placedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Order' },
);
type OrderDto = Static<typeof OrderSchema>;

export const OrderPageSchema = Type.Object(
  { data: Type.Array(Type.Ref('Order')), nextCursor: NullableString },
  { $id: 'OrderPage' },
);

export const OrderPaymentSchema = Type.Object(
  {
    sessionId: Type.String(),
    providerId: Type.String(),
    providerName: Type.String(),
    status: Type.Enum(['pending', 'requires_action', 'authorized', 'partially_captured', 'captured', 'canceled', 'failed']),
    captureMode: Type.Enum(['immediate', 'manual']),
    currency: Type.String(),
    amount: Amount,
    capturedAmount: Amount,
    authorizationExpiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], {
      description: 'When the provider releases the uncaptured amount, if it said',
    }),
    transactions: Type.Array(
      Type.Object({
        id: Type.String(),
        kind: Type.Enum(['authorize', 'capture', 'cancel', 'refund']),
        status: Type.Enum(['succeeded', 'failed', 'requires_action', 'error'], {
          description: 'error: the provider itself failed, as opposed to declining',
        }),
        amount: Amount,
        reference: NullableString,
        reason: NullableString,
        createdAt: Type.String({ format: 'date-time' }),
      }),
      { description: 'Every call to the provider, oldest first' },
    ),
  },
  { $id: 'OrderPayment' },
);
type OrderPaymentDto = Static<typeof OrderPaymentSchema>;

export const CaptureOrderPaymentSchema = Type.Object(
  {
    amount: Type.Optional(
      Type.Integer({ minimum: 1, description: 'Minor units; defaults to everything not captured yet. Less is a partial capture' }),
    ),
  },
  { $id: 'CaptureOrderPayment', additionalProperties: false },
);

export const orderSchemas = [OrderSchema, OrderPageSchema, OrderPaymentSchema, CaptureOrderPaymentSchema];

/** 402: the provider declined the capture. 502: the provider failed; retrying is safe. */
const CAPTURE_STATUS: Record<CaptureError['code'], 400 | 402 | 404 | 409 | 502> = {
  invalid_input: 400,
  payment_session_not_found: 404,
  payment_not_capturable: 409,
  payment_capture_in_progress: 409,
  payment_declined: 402,
  payment_provider_failed: 502,
};

function toOrderPaymentDto(session: PaymentSession, transactions: readonly PaymentTransaction[]): OrderPaymentDto {
  return {
    sessionId: session.id,
    providerId: session.providerId,
    providerName: session.providerName,
    status: session.status,
    captureMode: session.captureMode,
    currency: session.amount.currency,
    amount: session.amount.amount,
    capturedAmount: session.capturedAmount.amount,
    authorizationExpiresAt: session.authorizationExpiresAt?.toISOString() ?? null,
    transactions: transactions.map((tx) => ({
      id: tx.id,
      kind: tx.kind,
      status: tx.status,
      amount: tx.amount.amount,
      reference: tx.reference,
      reason: tx.reason,
      createdAt: tx.createdAt.toISOString(),
    })),
  };
}

function toOrderDto(order: Order): OrderDto {
  return {
    id: order.id,
    number: order.number,
    cartId: order.cartId,
    channelId: order.channelId,
    status: order.status,
    currency: order.currency,
    email: order.email,
    shippingAddress: { ...order.shippingAddress },
    billingAddress: { ...order.billingAddress },
    shippingMethod: { ...order.shippingMethod, amount: order.shippingMethod.amount.amount },
    lines: order.lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      productId: l.productId,
      productHandle: l.productHandle,
      productTitle: l.productTitle,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: l.unitPrice.amount,
      originalUnitPrice: l.originalUnitPrice?.amount ?? null,
      subtotal: l.subtotal.amount,
      total: l.total.amount,
    })),
    subtotal: order.subtotal.amount,
    adjustments: order.adjustments.map((a) => ({
      kind: a.kind,
      label: a.label,
      amount: a.amount.amount,
      lineId: a.target.type === 'line' ? a.target.lineId : null,
      included: a.neutral ?? false,
      source: a.source,
    })),
    adjustmentsTotal: order.adjustmentsTotal.amount,
    total: order.total.amount,
    payment: { ...order.payment },
    placedAt: order.placedAt.toISOString(),
  };
}

export const orderRoutes: FastifyPluginAsyncTypebox<OrderRoutesOptions> = async (app, { orders, payments }) => {
  const orderPayment = async (sessionId: string) => {
    const session = await payments.getSession(sessionId);
    return session && toOrderPaymentDto(session, await payments.listTransactions(sessionId));
  };

  app.get(
    '/orders',
    {
      schema: {
        operationId: 'listOrders',
        summary: 'Orders, newest first',
        tags: ['orders'],
        querystring: Type.Object({
          channelId: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: DEFAULT_PAGE_SIZE })),
          after: Type.Optional(Type.String({ description: '`nextCursor` from the previous page; anything else is rejected with 400 `invalid_cursor`' })),
        }),
        response: { 200: Type.Ref('OrderPage'), 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { limit = DEFAULT_PAGE_SIZE, ...filter } = request.query;
      const result = await orders.listOrders({ ...filter, limit });
      if (!result.ok) return reply.code(400).send(errorBody(result.error.code, result.error.message));
      return { data: result.value.items.map(toOrderDto), nextCursor: result.value.nextCursor };
    },
  );

  app.get(
    '/orders/:id',
    {
      schema: {
        operationId: 'getOrder',
        tags: ['orders'],
        params: Type.Object({ id: Type.String() }),
        response: { 200: Type.Ref('Order'), 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const order = await orders.getOrder(request.params.id);
      if (!order) return reply.code(404).send(errorBody('order_not_found', `Order "${request.params.id}" not found`));
      return toOrderDto(order);
    },
  );

  app.get(
    '/orders/:id/payment',
    {
      schema: {
        operationId: 'getOrderPayment',
        summary: 'The order’s payment and its ledger',
        tags: ['orders'],
        params: Type.Object({ id: Type.String() }),
        response: { 200: Type.Ref('OrderPayment'), 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const order = await orders.getOrder(request.params.id);
      const payment = order && (await orderPayment(order.payment.sessionId));
      if (!payment) return reply.code(404).send(errorBody('order_not_found', `Order "${request.params.id}" not found`));
      return payment;
    },
  );

  app.post(
    '/orders/:id/payment/capture',
    {
      schema: {
        operationId: 'captureOrderPayment',
        summary: 'Capture the order’s authorized payment, in full or in part',
        description:
          'For channels that capture manually, or when an immediate capture failed. Retrying with the same ' +
          'Idempotency-Key after a success returns the payment without capturing again. 409 ' +
          'payment_capture_in_progress: another capture is running. 402: the provider declined; 502: the ' +
          'provider failed, and retrying is safe. Send {} to capture everything not captured yet.',
        tags: ['orders'],
        params: Type.Object({ id: Type.String() }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 1, maxLength: 200, description: 'One key per capture; reuse it when retrying' }),
        }),
        body: CaptureOrderPaymentSchema,
        response: {
          200: Type.Ref('OrderPayment'),
          400: ErrorSchema,
          401: ErrorSchema,
          402: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          502: ErrorSchema,
        },
      },
      // An empty POST captures everything; Fastify would otherwise reject the missing body.
      preValidation: async (request) => {
        request.body ??= {};
      },
    },
    async (request, reply) => {
      const order = await orders.getOrder(request.params.id);
      if (!order) return reply.code(404).send(errorBody('order_not_found', `Order "${request.params.id}" not found`));
      const { sessionId } = order.payment;
      const { amount } = request.body;
      const result = await payments.captureSession({
        sessionId,
        ...(amount !== undefined && { amount: { amount, currency: order.currency } }),
        idempotencyKey: `${sessionId}:capture:${request.headers['idempotency-key']}`,
      });
      if (!result.ok) return reply.code(CAPTURE_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return (await orderPayment(sessionId))!;
    },
  );
};
