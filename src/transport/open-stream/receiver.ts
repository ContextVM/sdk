import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import {
  OpenStreamRegistry,
  type OpenStreamRegistryOptions,
} from './registry.js';
import type { OpenStreamSession } from './session.js';
import type { OpenStreamProgress } from './types.js';

/**
 * Stateful receiver for inbound CEP-41 `notifications/progress` frames.
 */
export class OpenStreamReceiver {
  private readonly registry: OpenStreamRegistry;

  constructor(options: OpenStreamRegistryOptions) {
    this.registry = new OpenStreamRegistry(options);
  }

  public static isOpenStreamFrame(notification: JSONRPCNotification): boolean {
    return OpenStreamRegistry.isOpenStreamProgress(notification.params);
  }

  public async processFrame(
    notification: JSONRPCNotification,
  ): Promise<OpenStreamSession> {
    return this.registry.processFrame(
      notification.params as OpenStreamProgress,
    );
  }

  public getSession(progressToken: string): OpenStreamSession | undefined {
    return this.registry.getSession(progressToken);
  }

  public getOrCreateSession(progressToken: string): OpenStreamSession {
    return this.registry.getOrCreateSession(progressToken);
  }

  public clear(): void {
    this.registry.clear();
  }

  public get size(): number {
    return this.registry.size;
  }
}
