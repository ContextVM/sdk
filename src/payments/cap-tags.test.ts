import { describe, expect, test } from 'bun:test';
import { createCapTagsFromPricedCapabilities } from './cap-tags.js';

describe('createCapTagsFromPricedCapabilities()', () => {
  test('builds CEP-8 cap tags for tools, prompts, and resources', () => {
    const tags = createCapTagsFromPricedCapabilities([
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'sats',
      },
      {
        method: 'prompts/get',
        name: 'welcome',
        amount: 2,
        currencyUnit: 'sats',
      },
      {
        method: 'resources/read',
        name: 'greeting://alice',
        amount: 3,
        currencyUnit: 'sats',
      },
    ]);

    expect(tags).toEqual([
      ['cap', 'tool:add', '1', 'sats'],
      ['cap', 'prompt:welcome', '2', 'sats'],
      ['cap', 'resource:greeting://alice', '3', 'sats'],
    ]);
  });

  test('uses range price format when maxAmount is provided', () => {
    const tags = createCapTagsFromPricedCapabilities([
      {
        method: 'tools/call',
        name: 'add',
        amount: 100,
        maxAmount: 1000,
        currencyUnit: 'sats',
      },
    ]);

    expect(tags).toEqual([['cap', 'tool:add', '100-1000', 'sats']]);
  });

  test('skips unsupported methods and unnamed capabilities', () => {
    const tags = createCapTagsFromPricedCapabilities([
      {
        method: 'tools/call',
        amount: 1,
        currencyUnit: 'sats',
      },
      {
        method: 'resources/list',
        name: 'ignored',
        amount: 1,
        currencyUnit: 'sats',
      },
    ]);

    expect(tags).toEqual([]);
  });
});
