import { Logger } from '@nestjs/common';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { AgentPrincipal } from '../../../auth/principal/koda-principal.types';
import type { AssistantToolExecutor } from '../assistant-tool.executor';
import { mcpToolDescriptors, toMcpToolResult } from './mcp-tool-catalog';

const logger = new Logger('McpServerFactory');

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

/** 3-D18: the `koda` MCP server for one request, with every registration's JSON Schema wrapped for the SDK. */
export function createKodaMcpServer(registrations: McpToolRegistration[]): McpServer {
  const server = new McpServer({ name: 'koda', version: '1' });
  for (const registration of registrations) {
    server.registerTool(
      registration.name,
      { description: registration.description, inputSchema: fromJsonSchema(registration.inputSchema as JsonSchemaType) },
      registration.handler as never,
    );
  }
  return server;
}
