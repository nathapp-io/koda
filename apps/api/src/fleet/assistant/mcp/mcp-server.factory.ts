import { Logger } from '@nestjs/common';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { AgentPrincipal } from '../../../auth/principal/koda-principal.types';
import type { AssistantToolExecutor } from '../assistant-tool.executor';
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
 * 3-D18: one registration per MCP descriptor, in the catalog's order. Each handler runs the tool through the
 * executor as the authenticated agent with an `mcp` origin (a write runs at once, 3-D13); an executor throw is
 * logged and answered as a tool-level error so the client never sees the internals.
 */
export function kodaMcpToolRegistrations(
  executor: Pick<AssistantToolExecutor, 'executeFor'>,
  principal: AgentPrincipal,
): McpToolRegistration[] {
  return mcpToolDescriptors().map((descriptor) => ({
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
