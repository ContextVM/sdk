import type { CapTag, PricedCapability } from './types.js';

/**
 * Converts a priced capability configuration into CEP-8 `cap` tags.
 *
 * Supported capability identifiers:
 * - `tools/call` -> `tool:<tool_name>`
 * - `prompts/get` -> `prompt:<prompt_name>`
 * - `resources/read` -> `resource:<resource_uri>`
 *
 * Tag order is preserved based on `pricedCapabilities`.
 */
export function createCapTagsFromPricedCapabilities(
  pricedCapabilities: readonly PricedCapability[],
): CapTag[] {
  return pricedCapabilities.flatMap((cap): CapTag[] => {
    const capabilityIdentifier = toCep8CapabilityIdentifier(cap);
    if (!capabilityIdentifier) {
      return [];
    }

    return [['cap', capabilityIdentifier, String(cap.amount), cap.currencyUnit]];
  });
}

function toCep8CapabilityIdentifier(cap: PricedCapability): string | undefined {
  if (!cap.name) {
    return undefined;
  }

  switch (cap.method) {
    case 'tools/call':
      return `tool:${cap.name}`;
    case 'prompts/get':
      return `prompt:${cap.name}`;
    case 'resources/read':
      return `resource:${cap.name}`;
    default:
      return undefined;
  }
}
