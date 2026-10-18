import { registerAs } from '@nestjs/config';

export interface IMcpConfig {
  /** Serves `/api/mcp` only when MCP_ENABLED is exactly `true`; anything else keeps the route answering 409. */
  mcpEnabled: boolean;
}

export const mcpConfig = registerAs('mcp', (): IMcpConfig => ({ mcpEnabled: process.env.MCP_ENABLED === 'true' }));
