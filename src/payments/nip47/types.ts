export type NwcEncryptionMode = 'nip44_v2';

export type NwcNotificationType =
  | 'payment_received'
  | 'payment_sent'
  | 'hold_invoice_accepted'
  | (string & {});

export type NwcNotificationPayload = {
  notification_type: NwcNotificationType;
  notification: unknown;
};

export interface NwcConnection {
  /** Wallet service pubkey (hex). */
  walletPubkey: string;
  /** Relay URLs for reaching the wallet service. */
  relays: readonly string[];
  /** Client secret key (hex, 32 bytes) used for signing and encryption. */
  clientSecretKeyHex: string;
}

export type NwcRequest<M extends string = string, P = unknown> = {
  method: M;
  params: P;
};

export type NwcError = {
  code: string;
  message: string;
};

export type NwcResponse<T extends string = string, R = unknown> = {
  result_type: T;
  error: NwcError | null;
  result: R | null;
};

export type NwcMakeInvoiceParams = {
  /** Invoice amount in msats. */
  amount: number;
  description?: string;
  expiry?: number;
};

export type NwcInvoiceState =
  | 'pending'
  | 'settled'
  | 'accepted'
  | 'expired'
  | 'failed';

export type NwcInvoiceResult = {
  type?: 'incoming' | 'outgoing';
  state?: NwcInvoiceState;
  invoice?: string;
  payment_hash?: string;
  preimage?: string;
  created_at?: number;
  expires_at?: number;
  settled_at?: number;
  amount?: number;
};

export type NwcLookupInvoiceParams = {
  payment_hash?: string;
  invoice?: string;
};

export type NwcPayInvoiceParams = {
  invoice: string;
  /** Optional amount override in msats (usually omitted for fixed-amount invoices). */
  amount?: number;
};

export type NwcPayInvoiceResult = {
  preimage?: string;
  fees_paid?: number;
};
