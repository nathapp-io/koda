import { Controller, Delete, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { IncomingMessage } from 'http';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { Throttle } from '@nathapp/nestjs-throttler';
import { mcpConfig } from '../../../config/mcp.config';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { isAgentPrincipal, type AgentPrincipal, type KodaPrincipal } from '../../../auth/principal/koda-principal.types';
import { AssistantToolExecutor } from '../assistant-tool.executor';
import { createKodaMcpServer, kodaMcpToolRegistrations } from './mcp-server.factory';

/** The slice of Fastify's request and reply this route uses (`fastify` is not a direct dependency of the API). */
interface McpHttpRequest {
  /** Fastify's wrapper around the Node request; an Express request is itself the Node request and has none. */
  raw?: IncomingMessage;
  body?: unknown;
}
interface McpHttpReply {
  header(name: string, value: string): unknown;
  status(code: number): unknown;
  send(payload: Buffer): unknown;
}

/** The principal travels from the controller to the per-request server factory in `authInfo.extra`. */
const PRINCIPAL_KEY = 'principal';

/**
 * 3-D18: the koda tool layer over MCP, authenticated by the agent API key the global guard already checked.
 * POST carries the JSON-RPC traffic; GET and DELETE reach the SDK too, whose stateless legacy handling answers 405.
 */
// No @ApiTags/@ApiOperation (.nax/rules/api-controllers.md): a JSON-RPC protocol endpoint, not a REST contract, so it
// is excluded from OpenAPI like FleetConfigTestHooksController.
@ApiExcludeController()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
@Controller('mcp')
export class McpController {
  private readonly handler: McpHttpHandler;

  constructor(
    executor: AssistantToolExecutor,
    @Inject(mcpConfig.KEY) private readonly cfg: ConfigType<typeof mcpConfig>,
  ) {
    this.handler = createMcpHandler(
      (ctx) => {
        const principal = ctx.authInfo?.extra?.[PRINCIPAL_KEY] as AgentPrincipal;
        return createKodaMcpServer(kodaMcpToolRegistrations(executor, principal));
      },
      { responseMode: 'json' },
    );
  }

  @Post()
  post(@Principal() principal: KodaPrincipal, @Req() req: McpHttpRequest, @Res() reply: McpHttpReply) {
    return this.serve(principal, req, reply);
  }

  @Get()
  get(@Principal() principal: KodaPrincipal, @Req() req: McpHttpRequest, @Res() reply: McpHttpReply) {
    return this.serve(principal, req, reply);
  }

  @Delete()
  delete(@Principal() principal: KodaPrincipal, @Req() req: McpHttpRequest, @Res() reply: McpHttpReply) {
    return this.serve(principal, req, reply);
  }

  private async serve(principal: KodaPrincipal, req: McpHttpRequest, reply: McpHttpReply) {
    if (!this.cfg.mcpEnabled) throw new ConflictAppException({}, 'mcp.disabled');
    if (!principal || !isAgentPrincipal(principal)) throw new ForbiddenAppException({}, 'mcp.agentOnly');

    // Fastify (production) hands over `req.raw`; the Express app the integration helper boots passes the Node request
    // itself, with its body already parsed (an empty object on GET, which a web Request refuses).
    const node = req.raw ?? (req as unknown as IncomingMessage);
    const request = await toWebRequest(node, node.method === 'POST' ? req.body : undefined);
    const response = await this.handler.fetch(request, {
      authInfo: { token: '', clientId: principal.id, scopes: [], extra: { [PRINCIPAL_KEY]: principal } },
    });

    // The SDK's Response is written as is: an MCP client expects JSON-RPC bodies, not the JsonResponse envelope.
    response.headers.forEach((value, key) => reply.header(key, value));
    reply.status(response.status);
    return reply.send(Buffer.from(await response.arrayBuffer()));
  }
}
