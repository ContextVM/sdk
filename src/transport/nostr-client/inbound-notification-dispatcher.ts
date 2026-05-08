import {
  type JSONRPCMessage,
  type JSONRPCResponse,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { type Logger } from '../../core/utils/logger.js';
import { OpenStreamReceiver } from '../open-stream/index.js';
import { OversizedTransferReceiver } from '../oversized-transfer/index.js';

/**
 * Dependencies for the ClientInboundNotificationDispatcher.
 */
export interface ClientInboundNotificationDispatcherDeps {
  openStreamReceiver: OpenStreamReceiver;
  oversizedReceiver: OversizedTransferReceiver;
  handleResponse: (correlatedEventId: string, synthetic: JSONRPCResponse) => void;
  handleNotification: (eventId: string, correlatedEventId: string | undefined, synthetic: JSONRPCMessage) => void;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/**
 * Intercepts incoming transport-level notifications (CEP-22, CEP-41) for the client.
 */
export class ClientInboundNotificationDispatcher {
  constructor(private deps: ClientInboundNotificationDispatcherDeps) {}

  /**
   * Returns true if the notification was intercepted (CEP-22 or CEP-41).
   * Returns false if it should fall through to normal processing.
   */
  public tryIntercept(
    mcpMessage: JSONRPCMessage,
    eventId: string,
    correlatedEventId: string | undefined,
  ): boolean {
    if (
      isJSONRPCNotification(mcpMessage) &&
      mcpMessage.method === 'notifications/progress' &&
      OpenStreamReceiver.isOpenStreamFrame(mcpMessage)
    ) {
      this.deps.openStreamReceiver
        .processFrame(mcpMessage)
        .catch((err: unknown) => {
          this.deps.logger.error('Open stream error (client)', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.deps.onerror?.(err instanceof Error ? err : new Error(String(err)));
        });
      return true;
    }

    if (
      isJSONRPCNotification(mcpMessage) &&
      mcpMessage.method === 'notifications/progress' &&
      OversizedTransferReceiver.isOversizedFrame(mcpMessage)
    ) {
      this.deps.oversizedReceiver
        .processFrame(mcpMessage)
        .then((synthetic) => {
          if (synthetic !== null) {
            if (
              isJSONRPCResultResponse(synthetic) ||
              isJSONRPCErrorResponse(synthetic)
            ) {
              if (correlatedEventId) {
                this.deps.handleResponse(correlatedEventId, synthetic);
              } else {
                this.deps.logger.warn(
                  'Oversized response completed without correlation `e` tag',
                  {
                    eventId,
                  },
                );
              }
              return;
            }

            this.deps.handleNotification(eventId, correlatedEventId, synthetic);
          }
        })
        .catch((err: unknown) => {
          this.deps.logger.error('Oversized transfer error (client)', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.deps.onerror?.(err instanceof Error ? err : new Error(String(err)));
        });
      return true;
    }

    return false;
  }
}
