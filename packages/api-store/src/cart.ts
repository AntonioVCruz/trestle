import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import type {
  AddLineError,
  Cart,
  CartService,
  ListShippingOptionsError,
  SelectPaymentMethodError,
  SelectShippingOptionError,
  SetAddressesError,
} from '@trestle/core';
import {
  AddCartLineSchema,
  CreateCartSchema,
  errorBody,
  ErrorSchema,
  SelectPaymentMethodSchema,
  SelectShippingMethodSchema,
  SetCartAddressesSchema,
  toStoreCart,
  toStoreShippingQuote,
  UpdateCartLineSchema,
} from './schemas.js';

export interface CartRoutesOptions {
  readonly carts: CartService;
}

type CartErrorCode =
  | AddLineError['code']
  | SetAddressesError['code']
  | ListShippingOptionsError['code']
  | SelectShippingOptionError['code']
  | SelectPaymentMethodError['code'];

/**
 * One status per cart error code. Commands share codes, and a code a command cannot produce is
 * never used. 409 means the request is valid but the cart is not at a step that allows it (or
 * changed underneath it); 502 means the payment provider failed.
 */
const STATUS: Record<CartErrorCode, 400 | 404 | 409 | 502> = {
  invalid_input: 400,
  cart_full: 400,
  variant_not_available: 400,
  variant_not_priced: 400,
  shipping_option_unavailable: 400,
  payment_method_unavailable: 400,
  cart_not_found: 404,
  line_not_found: 404,
  cart_empty: 409,
  cart_locked: 409,
  address_required: 409,
  shipping_required: 409,
  cart_changed: 409,
  payment_initiation_failed: 502,
};

const LIST_SHIPPING_STATUS: Record<ListShippingOptionsError['code'], 404 | 409> = {
  cart_not_found: 404,
  address_required: 409,
};

// Responses refer to shared schemas by id; see the note in api-admin's catalog.ts.
const StoreCart = Type.Ref('StoreCart');
const cartCommandResponses = { 200: StoreCart, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 502: ErrorSchema };
const CartParams = Type.Object({ id: Type.String() });
const LineParams = Type.Object({ id: Type.String(), lineId: Type.String() });

const cartNotFound = (id: string) => errorBody('cart_not_found', `Cart "${id}" not found`);

/**
 * Cart commands (ADR 0003). A cart belongs to the channel it was created in; from any other
 * channel it does not exist.
 */
export const cartRoutes: FastifyPluginAsyncTypebox<CartRoutesOptions> = async (app, { carts }) => {
  const inChannel = (cart: Cart | undefined, request: FastifyRequest) =>
    cart && cart.channelId === request.channel!.id ? cart : undefined;

  /** The cart, if it exists in the request's channel; lines are changed only after this check. */
  const findCart = async (id: string, request: FastifyRequest) => inChannel(await carts.getCart(id), request);

  app.post(
    '/carts',
    {
      schema: {
        operationId: 'createCart',
        tags: ['cart'],
        body: CreateCartSchema,
        response: { 201: StoreCart, 400: ErrorSchema, 401: ErrorSchema },
      },
      // The body is optional: a bare POST creates a cart in the channel's default currency.
      preValidation: async (request) => {
        request.body ??= {};
      },
    },
    async (request, reply) => {
      const channel = request.channel!;
      const currency = request.body.currency ?? channel.defaultCurrency;
      if (!channel.currencies.includes(currency)) {
        return reply.code(400).send(errorBody('unsupported_currency', `This channel does not sell in ${currency}`));
      }
      const result = await carts.createCart({ channelId: channel.id, currency });
      if (!result.ok) return reply.code(400).send(errorBody(result.error.code, result.error.message));
      return reply.code(201).send(toStoreCart(result.value));
    },
  );

  app.get(
    '/carts/:id',
    {
      schema: {
        operationId: 'getCart',
        tags: ['cart'],
        params: CartParams,
        response: { 200: StoreCart, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const cart = await findCart(request.params.id, request);
      if (!cart) return reply.code(404).send(cartNotFound(request.params.id));
      return toStoreCart(cart);
    },
  );

  app.post(
    '/carts/:id/lines',
    {
      schema: {
        operationId: 'addCartLine',
        summary: 'Add a variant, or raise its quantity if it is already in the cart',
        tags: ['cart'],
        params: CartParams,
        body: AddCartLineSchema,
        response: cartCommandResponses,
      },
    },
    async (request, reply) => {
      if (!(await findCart(request.params.id, request))) return reply.code(404).send(cartNotFound(request.params.id));
      const result = await carts.addLine(request.params.id, request.body);
      if (!result.ok) return reply.code(STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toStoreCart(result.value);
    },
  );

  app.patch(
    '/carts/:id/lines/:lineId',
    {
      schema: {
        operationId: 'updateCartLine',
        summary: "Set a line's quantity",
        tags: ['cart'],
        params: LineParams,
        body: UpdateCartLineSchema,
        response: cartCommandResponses,
      },
    },
    async (request, reply) => {
      const { id, lineId } = request.params;
      if (!(await findCart(id, request))) return reply.code(404).send(cartNotFound(id));
      const result = await carts.updateLineQuantity(id, lineId, request.body.quantity);
      if (!result.ok) return reply.code(STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toStoreCart(result.value);
    },
  );

  app.delete(
    '/carts/:id/lines/:lineId',
    {
      schema: {
        operationId: 'removeCartLine',
        tags: ['cart'],
        params: LineParams,
        response: cartCommandResponses,
      },
    },
    async (request, reply) => {
      const { id, lineId } = request.params;
      if (!(await findCart(id, request))) return reply.code(404).send(cartNotFound(id));
      const result = await carts.removeLine(id, lineId);
      if (!result.ok) return reply.code(STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toStoreCart(result.value);
    },
  );

  app.post(
    '/carts/:id/addresses',
    {
      schema: {
        operationId: 'setCartAddresses',
        summary: 'Checkout step: contact email and addresses',
        description: 'Changing the shipping address drops a chosen shipping method.',
        tags: ['checkout'],
        params: CartParams,
        body: SetCartAddressesSchema,
        response: cartCommandResponses,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await findCart(id, request))) return reply.code(404).send(cartNotFound(id));
      const result = await carts.setAddresses(id, request.body);
      if (!result.ok) return reply.code(STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toStoreCart(result.value);
    },
  );

  app.get(
    '/carts/:id/shipping-options',
    {
      schema: {
        operationId: 'listCartShippingOptions',
        summary: 'Shipping options for the cart’s address and currency, cheapest first',
        tags: ['checkout'],
        params: CartParams,
        response: { 200: Type.Ref('StoreShippingQuoteList'), 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await findCart(id, request))) return reply.code(404).send(cartNotFound(id));
      const result = await carts.listShippingOptions(id);
      if (!result.ok) return reply.code(LIST_SHIPPING_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return { data: result.value.map(toStoreShippingQuote) };
    },
  );

  app.post(
    '/carts/:id/shipping-method',
    {
      schema: {
        operationId: 'selectCartShippingMethod',
        summary: 'Checkout step: choose one of the cart’s shipping options',
        tags: ['checkout'],
        params: CartParams,
        body: SelectShippingMethodSchema,
        response: cartCommandResponses,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await findCart(id, request))) return reply.code(404).send(cartNotFound(id));
      const result = await carts.selectShippingOption(id, request.body.optionId);
      if (!result.ok) return reply.code(STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toStoreCart(result.value);
    },
  );

  app.get(
    '/carts/:id/payment-methods',
    {
      schema: {
        operationId: 'listCartPaymentMethods',
        summary: 'Payment methods offered in the cart’s channel',
        tags: ['checkout'],
        params: CartParams,
        response: { 200: Type.Ref('StorePaymentMethodList'), 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await findCart(id, request))) return reply.code(404).send(cartNotFound(id));
      const result = await carts.listPaymentMethods(id);
      if (!result.ok) return reply.code(404).send(errorBody(result.error.code, result.error.message));
      return { data: result.value };
    },
  );

  app.post(
    '/carts/:id/payment-method',
    {
      schema: {
        operationId: 'selectCartPaymentMethod',
        summary: 'Checkout step: choose a payment method; prepares a payment for the cart total',
        description:
          'Returns the provider’s client data for the payment form. If the cart changes while the payment is ' +
          'prepared, the step fails with cart_changed and can be repeated.',
        tags: ['checkout'],
        params: CartParams,
        body: SelectPaymentMethodSchema,
        response: cartCommandResponses,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await findCart(id, request))) return reply.code(404).send(cartNotFound(id));
      const result = await carts.selectPaymentMethod(id, request.body);
      if (!result.ok) return reply.code(STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toStoreCart(result.value);
    },
  );
};


