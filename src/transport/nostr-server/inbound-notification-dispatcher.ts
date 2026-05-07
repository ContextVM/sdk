import {
  type JSONRPCMessage,
  type JSONRPCNotification,
  type JSONRPCRequest,
  isJSONRPCRequest,
  isJSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { type NostrEvent } from 'nostr-tools';
import { type Logger } from '../../core/utils/logger.js';
import {
  OpenStreamReceiver,
  OpenStreamWriter,
  buildOpenStreamAcceptFrame,
} from '../open-stream/index.js';
import { OversizedTransferReceiver } from '../oversized-transfer/index.js';
import { type CorrelationStore } from './correlation-store.js';
import { type ClientSession } from './session-store.js';
import { sendAcceptFrame } from './oversized-server-handler.js';
import { injectClientPubkey, injectRequestEventId } from '../../core/utils/utils.js';

export interface InboundNotificationDispatcherDeps {
  openStreamReceiver: OpenStreamReceiver;
  oversizedReceiver: OversizedTransferReceiver;
  openStreamWriters: Map<string, OpenStreamWriter>;
  correlationStore: CorrelationStore;
  sendNotification: (clientPubkey: string, notification: JSONRPCMessage) => Promise<void>;
  handleIncomingRequest: (
    event: NostrEvent,
    eventId: string,
    request: JSONRPCRequest,
    clientPubkey: string,
    wrapKind?: number,
  ) => void;
  handleIncomingNotification: (clientPubkey: string, notification: JSONRPCMessage) => void;
  cleanupDroppedRequest: (message: JSONRPCMessage) => void;
  shouldInjectRequestEventId: boolean;
  injectClientPubkey: boolean;
  logger: Logger;
  onerror?: (error: Error) => void;
}

export class InboundNotificationDispatcher {
  constructor(private deps: InboundNotificationDispatcherDeps) {}

  /**
   * Returns true if the notification was intercepted (CEP-22 or CEP-41).
   * Returns false if it should fall through to normal middleware dispatch.
   */
  public tryIntercept(
    inboundMessage: JSONRPCNotification,
    ctx: {
      event: NostrEvent;
      session: ClientSession;
      shouldSendAccept: boolean;
      wrapKind?: number;
    },
    dispatch: (msg: JSONRPCMessage) => Promise<boolean>,
  ): boolean {
    const { event, session, shouldSendAccept, wrapKind } = ctx;

    if (
      inboundMessage.method === 'notifications/progress' &&
      OpenStreamReceiver.isOpenStreamFrame(inboundMessage)
    ) {
      const frame = inboundMessage.params?.cvm as
        | { frameType?: string; reason?: string }
        | undefined;

      if (frame?.frameType === 'abort') {
        const progressToken = String(inboundMessage.params?.progressToken ?? '');
        const eventId = this.deps.correlationStore.getEventIdByProgressToken(progressToken);
        const writer = eventId ? this.deps.openStreamWriters.get(eventId) : undefined;

        if (writer) {
          void writer.abort(frame.reason).catch((err: unknown) => {
            this.deps.logger.error('Open stream abort propagation failed (server)', {
              error: err instanceof Error ? err.message : String(err),
              pubkey: event.pubkey,
              progressToken,
            });
            this.deps.onerror?.(err instanceof Error ? err : new Error(String(err)));
          });
        }

        return true;
      }

      if (frame?.frameType === 'ping') {
        const progressToken = String(inboundMessage.params?.progressToken ?? '');
        const nonce = 'nonce' in frame && typeof frame.nonce === 'string' ? frame.nonce : '';
        const eventId = this.deps.correlationStore.getEventIdByProgressToken(progressToken);
        const writer = eventId ? this.deps.openStreamWriters.get(eventId) : undefined;

        if (writer) {
          void writer.pong(nonce).catch((err: unknown) => {
            this.deps.logger.error('Open stream ping handling failed (server)', {
              error: err instanceof Error ? err.message : String(err),
              pubkey: event.pubkey,
              progressToken,
            });
            this.deps.onerror?.(err instanceof Error ? err : new Error(String(err)));
          });

          return true;
        }
      }

      this.deps.openStreamReceiver
        .processFrame(inboundMessage)
        .then(async () => {
          const frameType = frame?.frameType;

          if (frameType === 'start' && session.supportsOpenStream) {
            await this.deps.sendNotification(event.pubkey, {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: buildOpenStreamAcceptFrame({
                progressToken: String(inboundMessage.params?.progressToken ?? ''),
                progress: Number(inboundMessage.params?.progress ?? 0) + 1,
              }),
            });
          }
        })
        .catch((err: unknown) => {
          this.deps.logger.error('Open stream error (server)', {
            error: err instanceof Error ? err.message : String(err),
            pubkey: event.pubkey,
          });
          this.deps.onerror?.(err instanceof Error ? err : new Error(String(err)));
        });
      return true;
    }

    if (
      inboundMessage.method === 'notifications/progress' &&
      OversizedTransferReceiver.isOversizedFrame(inboundMessage)
    ) {
      this.deps.oversizedReceiver
        .processFrame(inboundMessage)
        .then(async (synthetic) => {
          if (synthetic === null) {
            if (
              (inboundMessage.params?.cvm as { frameType?: string } | undefined)?.frameType ===
                'start' &&
              shouldSendAccept
            ) {
              await sendAcceptFrame(
                {
                  clientPubkey: event.pubkey,
                  progressToken: String(inboundMessage.params?.progressToken ?? ''),
                },
                {
                  sendNotification: this.deps.sendNotification.bind(this.deps),
                },
              ).catch((err: unknown) => {
                this.deps.logger.error('Failed to send oversized accept', {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
            return;
          }

          if (isJSONRPCRequest(synthetic)) {
            this.deps.handleIncomingRequest(event, event.id, synthetic, event.pubkey, wrapKind);

            if (this.deps.shouldInjectRequestEventId) {
              injectRequestEventId(synthetic, event.id);
            }

            if (this.deps.injectClientPubkey) {
              injectClientPubkey(synthetic, event.pubkey);
            }
          } else if (isJSONRPCNotification(synthetic)) {
            this.deps.handleIncomingNotification(event.pubkey, synthetic);
          }

          void dispatch(synthetic)
            .then((forwarded) => {
              if (!forwarded) {
                this.deps.cleanupDroppedRequest(synthetic);
              }
            })
            .catch((err: unknown) => {
              this.deps.logger.error('Error dispatching reassembled oversized message', {
                error: err instanceof Error ? err.message : String(err),
                pubkey: event.pubkey,
              });
              this.deps.onerror?.(
                err instanceof Error ? err : new Error('oversized dispatch failed'),
              );
            });
        })
        .catch((err: unknown) => {
          this.deps.logger.error('Oversized transfer error (server)', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.deps.onerror?.(err instanceof Error ? err : new Error(String(err)));
        });
      return true;
    }

    return false;
  }
}
