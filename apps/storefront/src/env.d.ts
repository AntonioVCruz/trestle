declare namespace App {
  interface Locals {
    readonly channel: import('./lib/types.js').Channel;
    readonly categories: readonly import('./lib/categories.js').CategoryNode[];
    /** The shopper's cart, if they have one that is not an order yet. */
    readonly cart: import('./lib/types.js').Cart | null;
    /** The currency prices are shown in: the cart's once it holds anything (wireframe 2b). */
    readonly currency: string;
    /** For formatting; localized content is not in the Store API yet. */
    readonly locale: string;
  }
}
