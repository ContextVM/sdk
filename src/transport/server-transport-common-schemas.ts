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

function getCurrentSchemaHash(meta: Tool['_meta']): string | undefined {
  const commonSchemaMeta = meta?.[COMMON_SCHEMA_META_NAMESPACE];

  if (!isPlainObject(commonSchemaMeta)) {
    return undefined;
  }

  return typeof commonSchemaMeta.schemaHash === 'string'
    ? commonSchemaMeta.schemaHash
    : undefined;
}

function buildSchemaHash(tool: Pick<Tool, 'name' | 'inputSchema' | 'outputSchema'>): string {
  return computeCommonSchemaHash({
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  });
}

function mergeCommonSchemaMeta(
  meta: Tool['_meta'],
  schemaHash: string,
): { meta: NonNullable<Tool['_meta']>; didChange: boolean } {
  if (getCurrentSchemaHash(meta) === schemaHash && meta) {
    return {
      meta,
      didChange: false,
    };
  }

  const existingMeta = meta ?? {};
  const existingNamespace = existingMeta[COMMON_SCHEMA_META_NAMESPACE];

  return {
    meta: {
      ...existingMeta,
      [COMMON_SCHEMA_META_NAMESPACE]: {
        ...(isPlainObject(existingNamespace) ? existingNamespace : {}),
        schemaHash,
      },
    },
    didChange: true,
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

    let nextTools: Tool[] | undefined;

    result.tools.forEach((tool, index) => {
      if (!commonToolNames.has(tool.name)) {
        if (nextTools) {
          nextTools.push(tool);
        }
        return;
      }

      const schemaHash = buildSchemaHash(tool);
      const mergedMeta = mergeCommonSchemaMeta(tool._meta, schemaHash);

      if (!mergedMeta.didChange) {
        if (nextTools) {
          nextTools.push(tool);
        }
        return;
      }

      if (!nextTools) {
        nextTools = result.tools.slice(0, index);
      }

      nextTools.push({
        ...tool,
        _meta: mergedMeta.meta,
      });
    });

    if (!nextTools) {
      return result;
    }

    return {
      ...result,
      tools: nextTools,
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
 * Apply this decorator before connecting the transport so direct and announced `tools/list`
 * payloads stay consistent from the first announcement onward.
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
