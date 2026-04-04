import { describe, expect, test } from 'bun:test';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { computeCommonSchemaHash } from '../core/utils/common-schema.js';
import {
  COMMON_SCHEMA_META_NAMESPACE,
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
