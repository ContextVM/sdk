import { InMemoryPaymentStateStore } from './in-memory-payment-state-store.js';

/**
 * In-memory authorization and replay storage. Use the atomic admit/transition
 * API; the former unfenced grant/clear methods are intentionally unavailable.
 */
export class AuthorizationStore extends InMemoryPaymentStateStore {}
