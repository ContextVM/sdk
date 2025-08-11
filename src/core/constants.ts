import { AnnouncementMethods } from './interfaces.js';

/**
 * CTXVM-specific event kinds.
 *
 * All CTXVM messages are ephemeral events.
 * @see https://github.com/nostr-protocol/nips/blob/master/01.md#kinds
 */
export const CTXVM_MESSAGES_KIND = 25910;

/**
 * Encrypted CTXVM messages using NIP-59 Gift Wrap.
 * @see https://github.com/nostr-protocol/nips/blob/master/59.md
 */
export const GIFT_WRAP_KIND = 1059;

/**
 * Addressable event for server announcements.
 */
export const SERVER_ANNOUNCEMENT_KIND = 11316;

/**
 * Addressable event for listing available tools.
 */
export const TOOLS_LIST_KIND = 11317;

/**
 * Addressable event for listing available resources.
 */
export const RESOURCES_LIST_KIND = 11318;

/**
 * Addressable event for listing available resources.
 */
export const RESOURCETEMPLATES_LIST_KIND = 11319;

/**
 * Addressable event for listing available prompts.
 */
export const PROMPTS_LIST_KIND = 11320;

/**
 * CTXVM-specific Nostr event tags.
 */
export const NOSTR_TAGS = {
  PUBKEY: 'p',
  /**
   * Event ID for correlating requests and responses.
   */
  EVENT_ID: 'e',
  /**
   * Capability tag for tools, resources, and prompts to provide pricing metadata.
   */
  CAPABILITY: 'cap',
  /**
   * Name tag for server announcements.
   */
  NAME: 'name',
  /**
   * Website tag for server announcements.
   */
  WEBSITE: 'website',
  /**
   * Picture tag for server announcements.
   */
  PICTURE: 'picture',
  /**
   * About tag for server announcements.
   */
  ABOUT: 'about',
  /**
   * Support encryption tag for server announcements.
   */
  SUPPORT_ENCRYPTION: 'support_encryption',
} as const;

export const announcementMethods: AnnouncementMethods = {
  tools: 'tools/list',
  resources: 'resources/list',
  resourceTemplates: 'resources/templates/list',
  prompts: 'prompts/list',
} as const;

/**
 * Maximum allowed message size in bytes (1MB)
 */
export const MAX_MESSAGE_SIZE = 1024 * 1024;
