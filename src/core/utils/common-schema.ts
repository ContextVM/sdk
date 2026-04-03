import { createHash } from 'crypto';

export interface CommonToolSchemaDefinition {
  name: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeCanonicalJson(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Common schema canonicalization only supports finite numbers');
    }

    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonicalJson(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${serializeCanonicalJson(value[key])}`,
  );
  return `{${entries.join(',')}}`;
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
export function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeSchema(item));
  }

  if (!isPlainObject(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = {};

  Object.keys(schema).forEach((key) => {
    if (key === 'title' || key === 'description') {
      return;
    }

    normalized[key] = normalizeSchema(schema[key]);
  });

  return normalized;
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
  const payload: Record<string, unknown> = {
    name: definition.name,
    inputSchema: normalizeSchema(definition.inputSchema),
  };

  if (definition.outputSchema !== undefined) {
    payload.outputSchema = normalizeSchema(definition.outputSchema);
  }

  return createHash('sha256')
    .update(serializeCanonicalJson(payload as JsonValue))
    .digest('hex');
}
