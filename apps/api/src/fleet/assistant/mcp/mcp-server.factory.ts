import { Logger } from '@nestjs/common';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { AgentPrincipal } from '../../../auth/principal/koda-principal.types';
import { findCatalogEntry } from '../../../permissions/catalog';
import type { PermissionService } from '../../../permissions/permission.service';
import type { AssistantToolExecutor } from '../assistant-tool.executor';
import type { AssistantToolRegistry } from '../assistant-tool.registry';
import { mcpToolDescriptors, toMcpToolResult } from './mcp-tool-catalog';

const logger = new Logger('McpServerFactory');

/** The SDK's JSON-Schema validator provider, taken from `fromJsonSchema` (the interface itself is not exported). */
type JsonSchemaValidation = NonNullable<Parameters<typeof fromJsonSchema>[1]>;

/**
 * Branch review B1: the SDK validates every `tools/call` against the registered schema *before* the handler runs, so a
 * malformed `project` was refused by the SDK (`Input validation error: …`) and never reached `executeFor` — bypassing
 * the shared validation and audit contract, which owes `invalid_input: project` and an audit row with a null
 * `projectId`. The input schema stays advertised exactly as the descriptor declares it (3-D16, 3-D18); this provider
 * passes every argument through, so `executeFor` owns argument validation over MCP as it does for a thread call.
 */
const DELEGATE_VALIDATION_TO_EXECUTOR: JsonSchemaValidation = {
  getValidator:
    <T>(_schema: JsonSchemaType) =>
    (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined }),
};

/** 3-D18: one MCP tool as the server registers it; `handler` answers what `toMcpToolResult` builds. */
export interface McpToolRegistration {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (input: unknown) => Promise<unknown>;
}

/**
 * Permissions P1 US-005: the tool names one request's server registers — the MCP descriptors whose key the agent
 * holds somewhere, read from the tool registry rather than from a second permission map.
 *
 * A descriptor is visible when its tool is a workspace-scope one (`koda_my_projects` lists what the agent can
 * already reach, and the executor checks no key for it), when its catalog key is implicit (`koda_get_action`'s
 * `assistant.action.read` belongs to every authenticated principal), or when `projectIdsWithKey` answers the key
 * somewhere: `{ all: true }` for a global grant, else a non-empty project list. Listing is per key, not per project
 * (US-005 scope): a tool is offered when the agent may use it in at least one project, and an MCP call that names a
 * project where the key is missing is still refused by the executor.
 *
 * The distinct keys are resolved once each, in parallel, and a name the registry does not hold is never visible.
 */
export async function visibleMcpToolNames(
  deps: {
    registry: Pick<AssistantToolRegistry, 'get'>;
    permissions: Pick<PermissionService, 'projectIdsWithKey'>;
  },
  principal: AgentPrincipal,
): Promise<ReadonlySet<string>> {
  const descriptors = mcpToolDescriptors();
  const tools = descriptors.map((descriptor) => deps.registry.get(descriptor.name));
  const keys = [
    ...new Set(
      tools.flatMap((tool) =>
        tool === undefined || holdsWithoutProjectKey(tool) ? [] : [tool.key],
      ),
    ),
  ];
  const held = new Map(
    await Promise.all(
      keys.map(async (key): Promise<[string, boolean]> => {
        const scope = await deps.permissions.projectIdsWithKey(principal, key);
        return [key, scope.all === true || ('projectIds' in scope && scope.projectIds.length > 0)];
      }),
    ),
  );

  const visible = new Set<string>();
  descriptors.forEach((descriptor, index) => {
    const tool = tools[index];
    if (tool !== undefined && (holdsWithoutProjectKey(tool) || held.get(tool.key) === true)) {
      visible.add(descriptor.name);
    }
  });
  return visible;
}

/** A tool every agent reaches without holding a project key: a workspace-scope tool, or one on an implicit key. */
function holdsWithoutProjectKey(tool: { key: string; scope?: 'project' | 'workspace' }): boolean {
  return tool.scope === 'workspace' || findCatalogEntry(tool.key)?.access === 'implicit';
}

/**
 * 3-D18: one registration per visible MCP descriptor, in the catalog's order. Each handler runs the tool through the
 * executor as the authenticated agent with an `mcp` origin (a write runs at once, 3-D13); an executor throw is
 * logged and answered as a tool-level error so the client never sees the internals.
 *
 * Permissions P1 US-005: `visible` is the request's set from `visibleMcpToolNames`. A tool left out is never
 * registered, so a call to it is the SDK's own unknown-tool error — the client is told the tool does not exist
 * rather than that it was refused.
 */
export function kodaMcpToolRegistrations(
  executor: Pick<AssistantToolExecutor, 'executeFor'>,
  principal: AgentPrincipal,
  visible: ReadonlySet<string>,
): McpToolRegistration[] {
  return mcpToolDescriptors()
    .filter((descriptor) => visible.has(descriptor.name))
    .map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      handler: async (input: unknown) => {
        try {
          const result = await executor.executeFor(
            { principal, origin: { kind: 'mcp' }, disabled: false },
            { name: descriptor.name, input },
          );
          return toMcpToolResult(result);
        } catch (error) {
          logger.error(`MCP tool ${descriptor.name} failed`, error instanceof Error ? error.stack : String(error));
          return toMcpToolResult({ content: `error: ${descriptor.name} failed`, isError: true });
        }
      },
    }));
}

/** 3-D18: the `koda` MCP server for one request; the schema stays advertised, argument validation is the executor's (B1). */
export function createKodaMcpServer(registrations: McpToolRegistration[]): McpServer {
  const server = new McpServer({ name: 'koda', version: '1' });
  for (const registration of registrations) {
    server.registerTool(
      registration.name,
      {
        description: registration.description,
        inputSchema: fromJsonSchema(registration.inputSchema as JsonSchemaType, DELEGATE_VALIDATION_TO_EXECUTOR),
      },
      registration.handler as never,
    );
  }
  return server;
}
