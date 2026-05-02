import { describe, expect, test } from 'bun:test';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { computeCommonSchemaHash } from '../core/utils/common-schema.js';
import { COMMON_SCHEMA_META_NAMESPACE } from '../core/constants.js';
import {
  createCommonSchemaAnnouncementTagsProducer,
  createCommonSchemaToolsResultTransformer,
} from './server-transport-common-schemas.js';

describe('createCommonSchemaToolsResultTransformer', () => {
  test('injects schema hashes into opted-in tools and preserves existing metadata', () => {
    const result: ListToolsResult = {
      tools: [
        {
          name: 'translate_text',
          title: 'Translate Text',
          description: 'Translate text between languages',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Input text' },
              targetLanguage: { type: 'string', title: 'Target language' },
            },
            required: ['text', 'targetLanguage'],
          },
          _meta: {
            existing: true,
            [COMMON_SCHEMA_META_NAMESPACE]: {
              note: 'preserved',
            },
          },
        },
        {
          name: 'bespoke_tool',
          title: 'Bespoke Tool',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
          },
        },
      ],
    };

    const transform = createCommonSchemaToolsResultTransformer({
      tools: [{ name: 'translate_text' }],
    });

    const transformed = transform(result);
    const translateTool = transformed.tools.find(
      (tool) => tool.name === 'translate_text',
    );
    const bespokeTool = transformed.tools.find(
      (tool) => tool.name === 'bespoke_tool',
    );

    expect(transformed).not.toBe(result);
    expect(translateTool?._meta).toMatchObject({
      existing: true,
      [COMMON_SCHEMA_META_NAMESPACE]: {
        note: 'preserved',
        schemaHash: computeCommonSchemaHash({
          name: 'translate_text',
          inputSchema: result.tools[0]!.inputSchema,
        }),
      },
    });
    expect(bespokeTool).toBe(result.tools[1]);
    expect(bespokeTool?._meta?.[COMMON_SCHEMA_META_NAMESPACE]).toBeUndefined();
  });



  test('returns the original result when opted-in tools already carry the matching schema hash', () => {
    const schemaHash = computeCommonSchemaHash({
      name: 'translate_text',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    });

    const tool = {
      name: 'translate_text',
      title: 'Translate Text',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      _meta: {
        [COMMON_SCHEMA_META_NAMESPACE]: {
          schemaHash,
          note: 'already present',
        },
      },
    } satisfies ListToolsResult['tools'][number];

    const result: ListToolsResult = {
      tools: [tool],
    };

    const transform = createCommonSchemaToolsResultTransformer({
      tools: [{ name: 'translate_text' }],
    });

    expect(transform(result)).toBe(result);
  });

  test('returns the original result when no configured tools match', () => {
    const result: ListToolsResult = {
      tools: [
        {
          name: 'weather_lookup',
          title: 'Weather Lookup',
          inputSchema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      ],
    };

    const transform = createCommonSchemaToolsResultTransformer({
      tools: [{ name: 'translate_text' }],
    });

    expect(transform(result)).toBe(result);
  });
});

describe('createCommonSchemaAnnouncementTagsProducer', () => {
  test('creates NIP-73 i/k tags for opted-in common-schema tools only', () => {
    const result: ListToolsResult = {
      tools: [
        {
          name: 'translate_text',
          title: 'Translate Text',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              targetLanguage: { type: 'string' },
            },
            required: ['text', 'targetLanguage'],
          },
        },
        {
          name: 'bespoke_tool',
          title: 'Bespoke Tool',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
      ],
    };

    const produceTags = createCommonSchemaAnnouncementTagsProducer({
      tools: [{ name: 'translate_text' }],
    });

    expect(produceTags(result)).toEqual([
      [
        'i',
        computeCommonSchemaHash({
          name: 'translate_text',
          inputSchema: result.tools[0]!.inputSchema,
        }),
        'translate_text',
      ],
      ['k', COMMON_SCHEMA_META_NAMESPACE],
    ]);
  });



  test('reuses existing schemaHash metadata when producing announcement tags', () => {
    const result: ListToolsResult = {
      tools: [
        {
          name: 'translate_text',
          title: 'Translate Text',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
          _meta: {
            [COMMON_SCHEMA_META_NAMESPACE]: {
              schemaHash: 'precomputed-hash',
            },
          },
        },
      ],
    };

    const produceTags = createCommonSchemaAnnouncementTagsProducer({
      tools: [{ name: 'translate_text' }],
    });

    expect(produceTags(result)).toEqual([
      ['i', 'precomputed-hash', 'translate_text'],
      ['k', COMMON_SCHEMA_META_NAMESPACE],
    ]);
  });

  test('returns no tags when no common-schema tools are present', () => {
    const result: ListToolsResult = {
      tools: [
        {
          name: 'bespoke_tool',
          title: 'Bespoke Tool',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
          },
        },
      ],
    };

    const produceTags = createCommonSchemaAnnouncementTagsProducer({
      tools: [{ name: 'translate_text' }],
    });

    expect(produceTags(result)).toEqual([]);
  });
});
