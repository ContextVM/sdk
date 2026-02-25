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
 * Ephemeral variant of NIP-59 Gift Wrap.
 *
 * Same structure and semantics as kind 1059, but in NIP-01's ephemeral range.
 */
export const EPHEMERAL_GIFT_WRAP_KIND = 21059;

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

  /**
   * Support ephemeral gift wrap kind (21059) for encrypted messages.
   */
  SUPPORT_ENCRYPTION_EPHEMERAL: 'support_encryption_ephemeral',
} as const;

export const DEFAULT_LRU_SIZE = 5000;

/**
 * Default timeout for network/relay operations (30 seconds).
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export const announcementMethods: AnnouncementMethods = {
  tools: 'tools/list',
  resources: 'resources/list',
  resourceTemplates: 'resources/templates/list',
  prompts: 'prompts/list',
} as const;

export const INITIALIZE_METHOD = 'initialize';
export const NOTIFICATIONS_INITIALIZED_METHOD = 'notifications/initialized';
