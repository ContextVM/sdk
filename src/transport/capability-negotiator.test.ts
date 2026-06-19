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
      measurementTags.some(t => t[0] === 'payment_interaction' && t[1] === 'explicit_gating')
    ).toBe(true);

    // Simulate real send (tags actually used)
    const realTags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(
      realTags.some(t => t[0] === 'payment_interaction' && t[1] === 'explicit_gating')
    ).toBe(true);

    // Mark as sent (post-send)
    negotiator.markNegotiationTagsSent();

    // Should no longer appear
    const afterTags = negotiator.buildOutboundTags({
      baseTags: [['p', 'server-pubkey']],
      includeDiscovery: true,
    });
    expect(
      afterTags.some(t => t[0] === 'payment_interaction')
    ).toBe(false);
  });
});
