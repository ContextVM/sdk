import {
  ListToolsResult,
  ListToolsResultSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) implementation.
 * Produces deterministic JSON string for hashing.
 */
function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    // Handle special cases per RFC 8785
    if (Number.isNaN(value)) {
      throw new Error('NaN cannot be canonicalized per RFC 8785');
    }
    if (value === Infinity || value === -Infinity) {
      throw new Error('Infinity cannot be canonicalized per RFC 8785');
    }
    // Use JSON's number serialization (IEEE 754 double-precision)
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    // JSON.stringify handles proper escaping
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements = value.map((item) => canonicalize(item)).join(',');
    return `[${elements}]`;
  }

  if (typeof value === 'object') {
    // Sort keys lexicographically per RFC 8785
    const keys = Object.keys(value).sort();
    const pairs = keys.map((key) => {
      const canonicalKey = JSON.stringify(key);
      const canonicalValue = canonicalize((value as Record<string, unknown>)[key]);
      return `${canonicalKey}:${canonicalValue}`;
    });
    return `{${pairs.join(',')}}`;
  }

  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}

/**
 * Computes SHA-256 hash of a canonicalized schema string.
 * Returns lowercase hex string (64 characters).
 */
async function computeSchemaHash(canonicalSchema: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalSchema);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonicalizes a tool's inputSchema using RFC 8785 JCS.
 * Returns the canonical JSON string (suitable for hashing or comparison).
 */
export function canonicalizeToolInputSchema(tool: Tool): string {
  return canonicalize(tool.inputSchema);
}

/**
 * Enriches a tools/list result with schemaHash metadata for each tool.
 *
 * Adds _meta["io.contextvm/common-schema"].schemaHash to each tool definition,
 * computed from the canonicalized inputSchema per RFC 8785 JCS.
 *
 * @param result - The tools/list result to enrich
 * @returns New result with schemaHash metadata added (does not mutate input)
 */
export async function enrichToolsWithSchemaHash(
  result: ListToolsResult,
): Promise<ListToolsResult> {
  const enrichedTools = await Promise.all(
    result.tools.map(async (tool) => {
      const canonicalSchema = canonicalizeToolInputSchema(tool);
      const schemaHash = await computeSchemaHash(canonicalSchema);

      return {
        ...tool,
        _meta: {
          ...tool._meta,
          'io.contextvm/common-schema': {
            schemaHash,
          },
        },
      };
    }),
  );

  return {
    ...result,
    tools: enrichedTools,
  };
}

/**
 * Synchronous version of enrichToolsWithSchemaHash for non-async contexts.
 * Requires pre-computed hash values.
 */
export function enrichToolsWithSchemaHashSync(
  result: ListToolsResult,
  computeHash: (tool: Tool) => string,
): ListToolsResult {
  const enrichedTools = result.tools.map((tool) => {
    const schemaHash = computeHash(tool);
    return {
      ...tool,
      _meta: {
        ...tool._meta,
        'io.contextvm/common-schema': {
          schemaHash,
        },
      },
    };
  });

  return {
    ...result,
    tools: enrichedTools,
  };
}
