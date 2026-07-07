import { describe, expect, test } from 'bun:test';
import { ClientCapabilityNegotiator } from './capability-negotiator.js';

import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';

describe('ClientCapabilityNegotiator', () => {
  test('should not consume payment_interaction tag during measurement calls', () => {
    const negotiator = new ClientCapabilityNegotiator({
      encryptionMode: EncryptionMode.OPTIONAL,
      giftWrapMode: GiftWrapMode.EPHEMERAL,
      oversizedEnabled: false,
      openStreamEnabled: false,
      composeOutboundTags: ({ baseTags, discoveryTags, negotiationTags }) => [
        ...baseTags,
        ...discoveryTags,
        ...negotiationTags,
      ],
    });

    negotiator.setPaymentInteraction('explicit_gating');

    // Simulate measurement call (tags discarded)
    const measurementTags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(
      measurementTags.some(
        (t) => t[0] === 'payment_interaction' && t[1] === 'explicit_gating',
      ),
    ).toBe(true);

    // Simulate real send (tags actually used)
    const realTags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(
      realTags.some(
        (t) => t[0] === 'payment_interaction' && t[1] === 'explicit_gating',
      ),
    ).toBe(true);

    // Mark as sent (post-send)
    negotiator.markNegotiationTagsSent();

    // Should no longer appear
    const afterTags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(afterTags.some((t) => t[0] === 'payment_interaction')).toBe(false);
  });

  test('getRequestedPaymentInteraction reflects the negotiated mode', () => {
    const negotiator = new ClientCapabilityNegotiator({
      encryptionMode: EncryptionMode.OPTIONAL,
      giftWrapMode: GiftWrapMode.EPHEMERAL,
      oversizedEnabled: false,
      openStreamEnabled: false,
      composeOutboundTags: () => [],
    });

    // Defaults to undefined (transparent client).
    expect(negotiator.getRequestedPaymentInteraction()).toBeUndefined();

    negotiator.setPaymentInteraction('explicit_gating');
    expect(negotiator.getRequestedPaymentInteraction()).toBe('explicit_gating');
  });

  test('emits payment_interaction=transparent so a downgrade intent is distinguishable from no preference', () => {
    const negotiator = new ClientCapabilityNegotiator({
      encryptionMode: EncryptionMode.OPTIONAL,
      giftWrapMode: GiftWrapMode.EPHEMERAL,
      oversizedEnabled: false,
      openStreamEnabled: false,
      composeOutboundTags: ({ baseTags, discoveryTags, negotiationTags }) => [
        ...baseTags,
        ...discoveryTags,
        ...negotiationTags,
      ],
    });

    negotiator.setPaymentInteraction('transparent');
    const tags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(
      tags.some(
        (t) => t[0] === 'payment_interaction' && t[1] === 'transparent',
      ),
    ).toBe(true);
  });

  test('setPaymentInteraction to a different mode re-emits the tag (mid-session upsert)', () => {
    const negotiator = new ClientCapabilityNegotiator({
      encryptionMode: EncryptionMode.OPTIONAL,
      giftWrapMode: GiftWrapMode.EPHEMERAL,
      oversizedEnabled: false,
      openStreamEnabled: false,
      composeOutboundTags: ({ baseTags, discoveryTags, negotiationTags }) => [
        ...baseTags,
        ...discoveryTags,
        ...negotiationTags,
      ],
    });

    negotiator.setPaymentInteraction('explicit_gating');
    negotiator.markNegotiationTagsSent();

    // After the first send, the tag is no longer emitted.
    let tags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(tags.some((t) => t[0] === 'payment_interaction')).toBe(false);

    // Changing the mode resets the latch so the next request carries the tag.
    negotiator.setPaymentInteraction('transparent');
    tags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(
      tags.some(
        (t) => t[0] === 'payment_interaction' && t[1] === 'transparent',
      ),
    ).toBe(true);
  });
});
