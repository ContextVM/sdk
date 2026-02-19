import type { NostrEvent, UnsignedEvent } from 'nostr-tools';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from './logger.js';

const logger = createLogger('serializers');

/**
 * Serializes an MCP message into a Nostr event object.
 *
 * @param mcpMessage The MCP message (request or response) to serialize.
 * @param pubkey The public key of the sender.
 * @param kind The kind of Nostr event to create.
 * @param tags An array of tags to include in the event.
 * @returns A Nostr event object (without `id` and `sig`).
 */
export function mcpToNostrEvent(
  mcpMessage: JSONRPCMessage,
  pubkey: string,
  kind: number,
  tags: string[][] = [],
): UnsignedEvent {
  return {
    pubkey,
    kind,
    tags,
    content: JSON.stringify(mcpMessage),
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Deserializes a Nostr event into an MCP message.
 *
 * @param event The Nostr event to deserialize.
 * @returns An MCP request or response object, or null if the event content is not valid JSON
 */
export function nostrEventToMcpMessage(
  event: NostrEvent,
): JSONRPCMessage | null {
  try {
    const content = JSON.parse(event.content);
    return content;
  } catch (error) {
    logger.error(
      `Invalid JSON in Nostr event content: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return null;
  }
}

/**
 * Extracts a specific tag from a Nostr event.
 *
 * @param event The Nostr event.
 * @param tagName The name of the tag to extract (e.g., 'e', 'p', 'd').
 * @returns The value of the tag, or undefined if not found.
 */
export function getNostrEventTag(
  tags: NostrEvent['tags'],
  tagName: string,
): string | undefined {
  const tag = tags.find((t) => t[0] === tagName);
  return tag ? tag[1] : undefined;
}
