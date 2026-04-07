import type { ListToolsResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { computeCommonSchemaHash } from '../core/utils/common-schema.js';
import type { NostrServerTransport } from './nostr-server-transport.js';

export const COMMON_SCHEMA_META_NAMESPACE = 'io.contextvm/common-schema';

export interface CommonSchemaToolConfig {
  name: Tool['name'];
}

export interface CommonToolSchemasOptions {
  tools: CommonSchemaToolConfig[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeCommonSchemaMeta(
  meta: Tool['_meta'],
  schemaHash: string,
): NonNullable<Tool['_meta']> {
  const existingMeta = meta ?? {};
  const existingNamespace = existingMeta[COMMON_SCHEMA_META_NAMESPACE];

  return {
    ...existingMeta,
    [COMMON_SCHEMA_META_NAMESPACE]: {
      ...(isPlainObject(existingNamespace) ? existingNamespace : {}),
      schemaHash,
    },
  };
}

function getCommonToolNames(
  options: CommonToolSchemasOptions,
): Set<CommonSchemaToolConfig['name']> {
  return new Set(options.tools.map((tool) => tool.name));
}

/**
 * Creates a pure transformer that enriches opted-in `tools/list` results with CEP-15 schema hashes.
 */
export function createCommonSchemaToolsResultTransformer(
  options: CommonToolSchemasOptions,
): (result: ListToolsResult) => ListToolsResult {
  const commonToolNames = getCommonToolNames(options);

  return (result: ListToolsResult): ListToolsResult => {
    if (!commonToolNames.size) {
      return result;
    }

    let didChange = false;

    const tools = result.tools.map((tool) => {
      if (!commonToolNames.has(tool.name)) {
        return tool;
      }

      const schemaHash = computeCommonSchemaHash({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      });

      const nextMeta = mergeCommonSchemaMeta(tool._meta, schemaHash);
      const currentSchemaHash = isPlainObject(
        tool._meta?.[COMMON_SCHEMA_META_NAMESPACE],
      )
        ? tool._meta?.[COMMON_SCHEMA_META_NAMESPACE].schemaHash
        : undefined;

      if (currentSchemaHash === schemaHash && nextMeta === tool._meta) {
        return tool;
      }

      didChange = true;
      return {
        ...tool,
        _meta: nextMeta,
      };
    });

    if (!didChange) {
      return result;
    }

    return {
      ...result,
      tools,
    };
  };
}

/**
 * Creates NIP-73 `i` / `k` tags for tools/list announcements of opted-in CEP-15 tools.
 */
export function createCommonSchemaAnnouncementTagsProducer(
  options: CommonToolSchemasOptions,
): (result: ListToolsResult) => string[][] {
  const commonToolNames = getCommonToolNames(options);

  return (result: ListToolsResult): string[][] => {
    if (!commonToolNames.size) {
      return [];
    }

    const iTags = result.tools.flatMap((tool) => {
      if (!commonToolNames.has(tool.name)) {
        return [];
      }

      const schemaHash = computeCommonSchemaHash({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      });

      return [['i', schemaHash, tool.name]];
    });

    if (!iTags.length) {
      return [];
    }

    return [...iTags, ['k', COMMON_SCHEMA_META_NAMESPACE]];
  };
}

/**
 * Attaches CEP-15 common-schema metadata injection to a NostrServerTransport.
 */
export function withCommonToolSchemas(
  transport: NostrServerTransport,
  options: CommonToolSchemasOptions,
): NostrServerTransport {
  transport.addListToolsResultTransformer(
    createCommonSchemaToolsResultTransformer(options),
  );
  transport.addListToolsAnnouncementTagsProducer(
    createCommonSchemaAnnouncementTagsProducer(options),
  );

  return transport;
}
