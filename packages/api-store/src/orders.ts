import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { CheckoutService, CompleteCartError, OrderService } from '@trestle/core';
import { errorBody, ErrorSchema, toStoreOrder } from './schemas.js';

export interface OrderRoutesOptions {
  readonly checkout: Pick<CheckoutService, 'completeCart'>;
  readonly orders: Pick<OrderService, 'getOrder'>;
  /** Carts are checked against the request channel before completing. */
  readonly cartChannel: (cartId: string) => Promise<string | undefined>;
}

/**
 * 409: the cart is not in a state that allows completion (or another attempt is running).
 * 402: the payment was declined. 502: the payment provider failed.
 */
const COMPLETE_STATUS: Record<CompleteCartError['code'], 400 | 402 | 404 | 409 | 502> = {
  invalid_input: 400,
  cart_not_found: 404,
  completion_in_progress: 409,
  cart_placed: 409,
  payment_required: 409,
  cart_changed: 409,
  cart_not_ready: 409,
  variant_not_available: 409,
  variant_not_priced: 409,
  shipping_option_unavailable: 409,
  payment_session_not_found: 409,
  payment_session_unusable: 409,
  payment_amount_mismatch: 409,
  payment_requires_action: 409,
  payment_declined: 402,
  payment_provider_failed: 502,
};

const StoreOrder = Type.Ref('StoreOrder');

export const orderRoutes: FastifyPluginAsyncTypebox<OrderRoutesOptions> = async (app, { checkout, orders, cartChannel }) => {
  app.post(
    '/carts/:id/complete',
    {
      schema: {
        operationId: 'completeCart',
        summary: 'Place the order: re-checks prices, authorizes the payment, creates the order',
        description:
          'Safe to retry. The cart, not the key, makes this idempotent: once the cart is placed, any call returns ' +
          'its order with 200 (201 the first time). While an attempt is still running, calls get 409 ' +
          'completion_in_progress; keep retrying with backoff, or poll GET /carts/{id} until checkoutState is ' +
          'placed and orderId is set. Stop retrying on any other error. On payment_requires_action, ' +
          'error.details.clientData says what the shopper must do. Where the channel captures payments ' +
          'immediately, the payment is captured once the order exists; a failed capture does not fail this call.',
        tags: ['checkout'],
        params: Type.Object({ id: Type.String() }),
        headers: Type.Object({
          'idempotency-key': Type.String({
            minLength: 1,
            maxLength: 255,
            description: 'One key per "place order" action; reuse it when retrying that action',
          }),
        }),
        response: {
          200: StoreOrder,
          201: StoreOrder,
          400: ErrorSchema,
          401: ErrorSchema,
          402: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if ((await cartChannel(id)) !== request.channel!.id) {
        return reply.code(404).send(errorBody('cart_not_found', `Cart "${id}" not found`));
      }
      const result = await checkout.completeCart(id, request.headers['idempotency-key']);
      if (!result.ok) {
        const { code, message, details } = result.error;
        return reply.code(COMPLETE_STATUS[code]).send(errorBody(code, message, details));
      }
      const order = (await orders.getOrder(result.value.orderId))!;
      return reply.code(result.value.replayed ? 200 : 201).send(toStoreOrder(order));
    },
  );

  app.get(
    '/orders/:id',
    {
      schema: {
        operationId: 'getOrder',
        tags: ['orders'],
        params: Type.Object({ id: Type.String() }),
        response: { 200: StoreOrder, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const order = await orders.getOrder(request.params.id);
      // Like carts, an order exists only in the channel it was placed in.
      if (!order || order.channelId !== request.channel!.id) {
        return reply.code(404).send(errorBody('order_not_found', `Order "${request.params.id}" not found`));
      }
      return toStoreOrder(order);
    },
  );
};
