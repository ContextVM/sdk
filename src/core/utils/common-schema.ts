import canonicalizePackage from 'canonicalize';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface CommonToolSchemaDefinition {
  name: Tool['name'];
  inputSchema: Tool['inputSchema'];
  outputSchema?: Tool['outputSchema'];
}

type CanonicalizeFn = (input: unknown) => string | undefined;
const canonicalize = canonicalizePackage as unknown as CanonicalizeFn;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively removes documentation-only JSON Schema fields used by CEP-15.
 *
 * The normalization rule intentionally strips only `title` and `description`
 * while preserving all compatibility-relevant structure exactly as provided.
 *
 * @param schema The JSON Schema value to normalize.
 * @returns A normalized copy of the schema.
 */
export function normalizeSchema<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeSchema(item)) as T;
  }

  if (!isPlainObject(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = {};

  Object.keys(schema).forEach((key) => {
    if (
      key === 'title' ||
      key === 'description' ||
      key === 'default' ||
      key === 'examples' ||
      key === 'deprecated' ||
      key === 'readOnly' ||
      key === 'writeOnly' ||
      key.startsWith('x-')
    ) {
      return;
    }

    if (
      key === '$ref' &&
      typeof schema[key] === 'string' &&
      !(schema[key] as string).startsWith('#')
    ) {
      throw new Error(
        'External $ref pointers must be resolved before computing common schema hash',
      );
    }

    normalized[key] = normalizeSchema(schema[key]);
  });

  return normalized as T;
}

/**
 * Computes the CEP-15 schema hash for a common tool definition.
 *
 * @param definition Tool name and JSON Schemas participating in compatibility.
 * @returns A deterministic SHA-256 hash of the normalized schema payload.
 */
export function computeCommonSchemaHash(
  definition: CommonToolSchemaDefinition,
): string {
  const payload: CommonToolSchemaDefinition = {
    name: definition.name,
    inputSchema: normalizeSchema(definition.inputSchema),
  };

  if (definition.outputSchema !== undefined) {
    payload.outputSchema = normalizeSchema(definition.outputSchema);
  }

  const canonicalPayload = canonicalize(payload);
  if (canonicalPayload === undefined) {
    throw new Error('Failed to canonicalize common schema payload');
  }

  return bytesToHex(sha256(new TextEncoder().encode(canonicalPayload)));
}
