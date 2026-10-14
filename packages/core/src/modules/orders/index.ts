import { defineModule } from '../../kernel/module.js';
import { migrations } from './migrations.js';
import { createOrderService } from './service.js';

export const ordersModule = defineModule({
  name: 'orders',
  migrations,
  createService: createOrderService,
});

export { orderStateMachine, type OrderStatus } from './rules.js';
export {
  MAX_ORDER_PAGE_SIZE,
  ORDER_PLACED,
  type ListOrdersError,
  type ListOrdersQuery,
  type OrderPage,
  type Order,
  type OrderAddress,
  type OrderLine,
  type OrderService,
  type PlaceOrderError,
  type PlaceOrderInput,
  type PlaceOrderLine,
} from './service.js';
