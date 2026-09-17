import { describe, expect, test } from 'bun:test';
import type { InitializeResult } from '@contextvm/mcp-sdk/types.js';
import type { NostrEvent } from 'nostr-tools';
import { NOSTR_TAGS } from '../../core/constants.js';
import { ServerMetadataStore } from './server-metadata-store.js';

function createEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1,
    kind: 24133,
    tags: [],
    content: '{}',
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

function createInitializeResult(): InitializeResult {
  return {
    protocolVersion: '2026-09-15',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'Test server', version: '1.0.0' },
    instructions: 'Test instructions',
  };
}

function expectDefaultState(store: ServerMetadataStore): void {
  expect(store.getServerInitializeEvent()).toBeUndefined();
  expect(store.getServerInitializeResult()).toBeUndefined();
  expect(store.getServerToolsListEvent()).toBeUndefined();
  expect(store.getServerResourcesListEvent()).toBeUndefined();
  expect(store.getServerResourceTemplatesListEvent()).toBeUndefined();
  expect(store.getServerPromptsListEvent()).toBeUndefined();
  expect(store.getServerSupportsOversizedTransfer()).toBe(false);
  expect(store.getServerSupportsOpenStream()).toBe(false);
  expect(store.getEffectivePaymentInteraction()).toBeUndefined();
  expect(store.getServerInitializeName()).toBeUndefined();
  expect(store.getServerInitializeAbout()).toBeUndefined();
  expect(store.getServerInitializeWebsite()).toBeUndefined();
  expect(store.getServerInitializePicture()).toBeUndefined();
  expect(store.serverSupportsEncryption()).toBe(false);
  expect(store.serverSupportsEphemeralEncryption()).toBe(false);
}

describe('ServerMetadataStore', () => {
  test('starts with default', () => {
    expectDefaultState(new ServerMetadataStore());
  });

  test('stores, replaces and retrieves the initialize event', () => {
    const store = new ServerMetadataStore();
    const first = createEvent();
    const second = createEvent({ id: 'd'.repeat(64) });
    store.setServerInitializeEvent(first);
    expect(store.getServerInitializeEvent()).toBe(first);
    store.setServerInitializeEvent(second);
    expect(store.getServerInitializeEvent()).toBe(second);
  });

  test('parses a valid initialize result from the event envelope', () => {
    const store = new ServerMetadataStore();
    const result = createInitializeResult();
    store.setServerInitializeEvent(
      createEvent({
        content: JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      }),
    );

    expect(store.getServerInitializeResult()).toEqual(result);
  });

  test.each([
    ['malformed JSON', '{'],
    ['null content', 'null'],
    ['missing result', '{}'],
    ['null result', '{"result":null}'],
    ['missing required fields', '{"result":{}}'],
    [
      'wrong field type',
      JSON.stringify({
        result: { ...createInitializeResult(), protocolVersion: 1 },
      }),
    ],
    ['unwrapped result', JSON.stringify(createInitializeResult())],
  ])(
    'returns undefined for %s without retaining a previous result',
    (_name, content) => {
      const store = new ServerMetadataStore();
      store.setServerInitializeEvent(
        createEvent({
          content: JSON.stringify({ result: createInitializeResult() }),
        }),
      );
      expect(store.getServerInitializeResult()).toEqual(
        createInitializeResult(),
      );
      store.setServerInitializeEvent(createEvent({ content }));

      expect(store.getServerInitializeResult()).toBeUndefined();
    },
  );

  test('stores list envelopes independently and replaces only the selected list', () => {
    const store = new ServerMetadataStore();
    const tools = createEvent({ content: '{"result":{"tools":[]}}' });
    const resources = createEvent({ content: '{"result":{"resources":[]}}' });
    const templates = createEvent({
      content: '{"result":{"resourceTemplates":[]}}',
    });
    const prompts = createEvent({ content: '{"result":{"prompts":[]}}' });
    store.updateListEnvelopeState('tools', tools);
    store.updateListEnvelopeState('resources', resources);
    store.updateListEnvelopeState('templates', templates);
    store.updateListEnvelopeState('prompts', prompts);

    expect(store.getServerToolsListEvent()).toBe(tools);
    expect(store.getServerResourcesListEvent()).toBe(resources);
    expect(store.getServerResourceTemplatesListEvent()).toBe(templates);
    expect(store.getServerPromptsListEvent()).toBe(prompts);
    const replacement = createEvent({ id: 'd'.repeat(64) });
    store.updateListEnvelopeState('resources', replacement);

    expect(store.getServerResourcesListEvent()).toBe(replacement);
    expect(store.getServerToolsListEvent()).toBe(tools);
    expect(store.getServerResourceTemplatesListEvent()).toBe(templates);
    expect(store.getServerPromptsListEvent()).toBe(prompts);
  });

  test('oversized-transfer support stays enabled after false updates', () => {
    const store = new ServerMetadataStore();
    // store.setSupportsOversizedTransfer(false);
    expect(store.getServerSupportsOversizedTransfer()).toBe(false);
    store.setSupportsOversizedTransfer(true);
    expect(store.getServerSupportsOversizedTransfer()).toBe(true);
    expect(store.getServerSupportsOpenStream()).toBe(false);
    store.setSupportsOversizedTransfer(false);
    expect(store.getServerSupportsOversizedTransfer()).toBe(true);
  });

  test('open-stream support stays enabled after false updates', () => {
    const store = new ServerMetadataStore();
    // store.setSupportsOpenStream(false);
    expect(store.getServerSupportsOpenStream()).toBe(false);
    store.setSupportsOpenStream(true);
    expect(store.getServerSupportsOpenStream()).toBe(true);
    expect(store.getServerSupportsOversizedTransfer()).toBe(false);
    store.setSupportsOpenStream(false);
    expect(store.getServerSupportsOpenStream()).toBe(true);
  });

  test('stores and replaces the payment-interaction mode', () => {
    const store = new ServerMetadataStore();
    store.setEffectivePaymentInteraction('explicit_gating');
    expect(store.getEffectivePaymentInteraction()).toBe('explicit_gating');
    store.setEffectivePaymentInteraction('transparent');
    expect(store.getEffectivePaymentInteraction()).toBe('transparent');
  });

  test('reads descriptive tags from the initialize event and uses the first match', () => {
    const store = new ServerMetadataStore();
    store.setServerInitializeEvent(
      createEvent({
        tags: [
          [NOSTR_TAGS.NAME, 'Test server'],
          [NOSTR_TAGS.NAME, 'Latter server'],
          [NOSTR_TAGS.ABOUT, 'Test description'],
          [NOSTR_TAGS.WEBSITE, 'https://example.com'],
          [NOSTR_TAGS.WEBSITE, 'https://latterexample.com'],
          [NOSTR_TAGS.PICTURE, 'https://example.com/avatar.png'],
        ],
      }),
    );

    expect(store.getServerInitializeName()).toBe('Test server');
    expect(store.getServerInitializeAbout()).toBe('Test description');
    expect(store.getServerInitializeWebsite()).toBe('https://example.com');
    expect(store.getServerInitializePicture()).toBe(
      'https://example.com/avatar.png',
    );
    store.setServerInitializeEvent(createEvent());

    expect(store.getServerInitializeName()).toBeUndefined();
    expect(store.getServerInitializeAbout()).toBeUndefined();
    expect(store.getServerInitializeWebsite()).toBeUndefined();
    expect(store.getServerInitializePicture()).toBeUndefined();
  });

  test('encryption support requires one-element flag tags', () => {
    const store = new ServerMetadataStore();
    store.setServerInitializeEvent(
      createEvent({ tags: [[NOSTR_TAGS.SUPPORT_ENCRYPTION]] }),
    );
    expect(store.serverSupportsEncryption()).toBe(true);
    expect(store.serverSupportsEphemeralEncryption()).toBe(false);
    store.setServerInitializeEvent(
      createEvent({ tags: [[NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL]] }),
    );
    expect(store.serverSupportsEncryption()).toBe(false);
    expect(store.serverSupportsEphemeralEncryption()).toBe(true);
    store.setServerInitializeEvent(
      createEvent({
        tags: [
          [NOSTR_TAGS.SUPPORT_ENCRYPTION, 'true'],
          [NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL, 'true'],
        ],
      }),
    );
    expect(store.serverSupportsEncryption()).toBe(false);
    expect(store.serverSupportsEphemeralEncryption()).toBe(false);
  });

  test('clear restores all default values', () => {
    const store = new ServerMetadataStore();
    const initialize = createEvent({
      content: JSON.stringify({ result: createInitializeResult() }),
      tags: [
        [NOSTR_TAGS.NAME, 'Test server'],
        [NOSTR_TAGS.ABOUT, 'Test description'],
        [NOSTR_TAGS.WEBSITE, 'https://example.com'],
        [NOSTR_TAGS.PICTURE, 'https://example.com/avatar.png'],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL],
      ],
    });
    store.setServerInitializeEvent(initialize);
    const tools = createEvent();
    const resources = createEvent();
    const templates = createEvent();
    const prompts = createEvent();
    store.updateListEnvelopeState('tools', tools);
    store.updateListEnvelopeState('resources', resources);
    store.updateListEnvelopeState('templates', templates);
    store.updateListEnvelopeState('prompts', prompts);
    store.setSupportsOversizedTransfer(true);
    store.setSupportsOpenStream(true);
    store.setEffectivePaymentInteraction('explicit_gating');

    expect(store.getServerInitializeEvent()).toBe(initialize);
    expect(store.getServerInitializeResult()).toEqual(createInitializeResult());
    expect(store.getServerToolsListEvent()).toBe(tools);
    expect(store.getServerResourcesListEvent()).toBe(resources);
    expect(store.getServerResourceTemplatesListEvent()).toBe(templates);
    expect(store.getServerPromptsListEvent()).toBe(prompts);
    expect(store.getServerSupportsOversizedTransfer()).toBe(true);
    expect(store.getServerSupportsOpenStream()).toBe(true);
    expect(store.getEffectivePaymentInteraction()).toBe('explicit_gating');
    expect(store.serverSupportsEncryption()).toBe(true);
    expect(store.serverSupportsEphemeralEncryption()).toBe(true);

    store.clear();

    expectDefaultState(store);
  });

  test('clear is safe on an empty store', () => {
    const store = new ServerMetadataStore();
    store.clear();
    expectDefaultState(store);
  });
});
