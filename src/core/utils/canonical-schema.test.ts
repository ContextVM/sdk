import { describe, test, expect } from 'bun:test';
import {
  canonicalizeToolInputSchema,
  enrichToolsWithSchemaHash,
  computeSchemaHash,
} from './canonical-schema.js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

describe('canonical-schema', () => {
  describe('canonicalizeToolInputSchema', () => {
    test('produces deterministic output regardless of key order', () => {
      const tool1: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            b: { type: 'number' },
            a: { type: 'string' },
          },
          required: ['a', 'b'],
        },
      };

      const tool2: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'string' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      };

      // Different property order in source should produce same canonical output
      expect(canonicalizeToolInputSchema(tool1)).toBe(
        canonicalizeToolInputSchema(tool2),
      );
    });

    test('canonicalizes nested objects correctly', () => {
      const tool: Tool = {
        name: 'nested-tool',
        description: 'Tool with nested schema',
        inputSchema: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                age: { type: 'number' },
              },
            },
          },
        },
      };

      const canonical = canonicalizeToolInputSchema(tool);
      expect(canonical).toContain(
        '"user":{"properties":{"age":{"type":"number"},"name":{"type":"string"}}',
      );
    });
  });

  describe('computeSchemaHash', () => {
    test('produces consistent 64-character hex hash', async () => {
      const schema = {
        type: 'object',
        properties: {
          a: { type: 'string' },
        },
      };

      const hash1 = await computeSchemaHash(JSON.stringify(schema));
      const hash2 = await computeSchemaHash(JSON.stringify(schema));

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]+$/);
    });

    test('different schemas produce different hashes', async () => {
      const schema1 = { type: 'object', properties: { a: { type: 'string' } } };
      const schema2 = { type: 'object', properties: { a: { type: 'number' } } };

      const hash1 = await computeSchemaHash(JSON.stringify(schema1));
      const hash2 = await computeSchemaHash(JSON.stringify(schema2));

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('enrichToolsWithSchemaHash', () => {
    test('adds schemaHash metadata to each tool', async () => {
      const result = {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
              required: ['a', 'b'],
            },
          },
          {
            name: 'subtract',
            description: 'Subtract two numbers',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
              required: ['a', 'b'],
            },
          },
        ],
      };

      const enriched = await enrichToolsWithSchemaHash(result);

      expect(enriched.tools).toHaveLength(2);

      // Verify schemaHash exists and is valid
      for (const tool of enriched.tools) {
        expect(tool._meta).toBeDefined();
        expect(tool._meta!['io.contextvm/common-schema']).toBeDefined();
        expect(
          typeof tool._meta!['io.contextvm/common-schema'].schemaHash,
        ).toBe('string');
        expect(
          tool._meta!['io.contextvm/common-schema'].schemaHash,
        ).toHaveLength(64);
      }
    });

    test('produces consistent hashes across multiple calls', async () => {
      const result = {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
            },
          },
        ],
      };

      const enriched1 = await enrichToolsWithSchemaHash(result);
      const enriched2 = await enrichToolsWithSchemaHash(result);

      expect(
        enriched1.tools[0]._meta!['io.contextvm/common-schema'].schemaHash,
      ).toBe(
        enriched2.tools[0]._meta!['io.contextvm/common-schema'].schemaHash,
      );
    });

    test('tools with same inputSchema have same schemaHash', async () => {
      const sameSchema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      };

      const result = {
        tools: [
          {
            name: 'search-provider-a',
            description: 'Search using Provider A',
            inputSchema: sameSchema,
          },
          {
            name: 'search-provider-b',
            description: 'Search using Provider B',
            inputSchema: sameSchema,
          },
        ],
      };

      const enriched = await enrichToolsWithSchemaHash(result);

      // Same inputSchema = same schemaHash (interoperability!)
      expect(
        enriched.tools[0]._meta!['io.contextvm/common-schema'].schemaHash,
      ).toBe(
        enriched.tools[1]._meta!['io.contextvm/common-schema'].schemaHash,
      );
    });

    test('preserves existing _meta fields', async () => {
      const result = {
        tools: [
          {
            name: 'tool',
            description: 'A tool',
            inputSchema: { type: 'object', properties: {} },
            _meta: {
              existingField: 'value',
            },
          },
        ],
      };

      const enriched = await enrichToolsWithSchemaHash(result);

      expect(enriched.tools[0]._meta!.existingField).toBe('value');
      expect(
        enriched.tools[0]._meta!['io.contextvm/common-schema'],
      ).toBeDefined();
    });
  });
});
