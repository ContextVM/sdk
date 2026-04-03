import { describe, expect, test } from 'bun:test';
import {
  computeCommonSchemaHash,
  normalizeSchema,
} from './common-schema.js';

describe('normalizeSchema', () => {
  test('recursively removes title and description fields', () => {
    const schema = {
      title: 'Top Level',
      description: 'Top description',
      type: 'object',
      properties: {
        city: {
          type: 'string',
          title: 'City',
          description: 'City name',
        },
        nested: {
          type: 'object',
          description: 'Nested object',
          properties: {
            value: {
              type: 'number',
              title: 'Value',
            },
          },
        },
      },
      anyOf: [
        {
          type: 'string',
          description: 'Variant A',
        },
        {
          type: 'number',
          title: 'Variant B',
        },
      ],
    };

    expect(normalizeSchema(schema)).toEqual({
      type: 'object',
      properties: {
        city: {
          type: 'string',
        },
        nested: {
          type: 'object',
          properties: {
            value: {
              type: 'number',
            },
          },
        },
      },
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'number',
        },
      ],
    });
  });
});

describe('computeCommonSchemaHash', () => {
  test('produces the same hash when only documentation text changes', () => {
    const first = computeCommonSchemaHash({
      name: 'translate_text',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to translate',
          },
        },
        required: ['text'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          translated_text: {
            type: 'string',
            title: 'Translated text',
          },
        },
        required: ['translated_text'],
      },
    });

    const second = computeCommonSchemaHash({
      name: 'translate_text',
      inputSchema: {
        title: 'Translate input',
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'User content',
          },
        },
        required: ['text'],
      },
      outputSchema: {
        type: 'object',
        description: 'Translate output',
        properties: {
          translated_text: {
            type: 'string',
            title: 'Output',
          },
        },
        required: ['translated_text'],
      },
    });

    expect(first).toBe(second);
  });

  test('changes when schema structure changes', () => {
    const first = computeCommonSchemaHash({
      name: 'get_weather',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
      },
    });

    const second = computeCommonSchemaHash({
      name: 'get_weather',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          units: { type: 'string' },
        },
        required: ['location'],
      },
    });

    expect(first).not.toBe(second);
  });

  test('changes when outputSchema presence changes', () => {
    const withoutOutput = computeCommonSchemaHash({
      name: 'get_weather',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
      },
    });

    const withOutput = computeCommonSchemaHash({
      name: 'get_weather',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          temperature: { type: 'number' },
        },
        required: ['temperature'],
      },
    });

    expect(withoutOutput).not.toBe(withOutput);
  });

  test('changes when tool name changes', () => {
    const first = computeCommonSchemaHash({
      name: 'translate_text',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    });

    const second = computeCommonSchemaHash({
      name: 'translate_message',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    });

    expect(first).not.toBe(second);
  });
});
