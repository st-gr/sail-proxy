/**
 * The person's choice of order, kept in the browser. Storage can be missing or refuse (private
 * window, blocked site data): then the page opens newest last and remembers nothing.
 */
import type { Order } from './liveLog';

export const ORDER_KEY = 'sail-proxy.logs.order';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readOrder(storage: StorageLike | null | undefined): Order {
  try {
    return storage?.getItem(ORDER_KEY) === 'newestFirst' ? 'newestFirst' : 'newestLast';
  } catch (error) {
    return 'newestLast';
  }
}

export function writeOrder(storage: StorageLike | null | undefined, order: Order): void {
  try {
    storage?.setItem(ORDER_KEY, order);
  } catch (error) {
    // Nothing to do: the page works without it.
  }
}
