import {
  type JSONRPCMessage,
  isJSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { type Logger } from '../../core/utils/logger.js';
import { type CorrelationStore } from './correlation-store.js';
import { type SessionStore } from './session-store.js';

export interface OutboundNotificationBroadcasterDeps {
  correlationStore: CorrelationStore;
  sessionStore: SessionStore;
  sendNotification: (
    clientPubkey: string,
    notification: JSONRPCMessage,
    correlatedEventId?: string,
  ) => Promise<void>;
  enqueueTask: (task: () => Promise<void>) => void;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/**
 * Routes server outbound notifications to a specific client or broadcasts to all.
 */
export class OutboundNotificationBroadcaster {
  constructor(private deps: OutboundNotificationBroadcasterDeps) {}

  /**
   * Broadcasts a notification or routes it based on correlation metadata.
   */
  public async broadcast(notification: JSONRPCMessage): Promise<void> {
    try {
      // Special handling for progress notifications
      // TODO: Add handling for `notifications/resources/updated`, as they need to be associated with an id
      if (
        isJSONRPCNotification(notification) &&
        notification.method === 'notifications/progress' &&
        notification.params?.progressToken
      ) {
        const token = String(notification.params.progressToken);

        // Use O(1) lookup for progress token routing
        const nostrEventId =
          this.deps.correlationStore.getEventIdByProgressToken(token);

        if (nostrEventId) {
          const route = this.deps.correlationStore.getEventRoute(nostrEventId);
          if (route) {
            await this.deps.sendNotification(
              route.clientPubkey,
              notification,
              nostrEventId,
            );
            return;
          }
        }

        const error = new Error(`No client found for progress token: ${token}`);
        this.deps.logger.error('Progress token not found', { token });
        this.deps.onerror?.(error);
        return;
      }

      // Use TaskQueue for outbound notification broadcasting to prevent event loop blocking
      for (const [
        clientPubkey,
        session,
      ] of this.deps.sessionStore.getAllSessions()) {
        if (session.isInitialized) {
          this.deps.enqueueTask(async () => {
            try {
              await this.deps.sendNotification(clientPubkey, notification);
            } catch (error) {
              this.deps.logger.error('Error sending notification', {
                error: error instanceof Error ? error.message : String(error),
                clientPubkey,
                method: isJSONRPCNotification(notification)
                  ? notification.method
                  : 'unknown',
              });
            }
          });
        }
      }
    } catch (error) {
      this.deps.logger.error('Error in notification broadcaster', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.deps.onerror?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
