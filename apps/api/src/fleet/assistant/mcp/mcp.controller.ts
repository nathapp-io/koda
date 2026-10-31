import { Controller, Delete, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { IncomingMessage } from 'http';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { Throttle } from '@nathapp/nestjs-throttler';
import { mcpConfig } from '../../../config/mcp.config';
import { ApprovalMcpTools } from '../../../approvals/mcp/approval-mcp-tools';
import { MemoryMcpTools } from '../../../memory/mcp/memory-mcp-tools';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { isAgentPrincipal, type AgentPrincipal, type KodaPrincipal } from '../../../auth/principal/koda-principal.types';
import { PermissionService } from '../../../permissions/permission.service';
import { Requires } from '../../../permissions/requires.decorator';
import { RequiresGuard } from '../../../permissions/requires.guard';
import { AssistantToolExecutor } from '../assistant-tool.executor';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { createKodaMcpServer, kodaMcpToolRegistrations, visibleMcpToolNames } from './mcp-server.factory';

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
/** Permissions P1 US-005: this request's visible tool names travel the same way, computed per request. */
const VISIBLE_TOOLS_KEY = 'visibleTools';

/**
 * 3-D18: the koda tool layer over MCP, authenticated by the agent API key the global guard already checked.
 * POST carries the JSON-RPC traffic; GET and DELETE reach the SDK too, whose stateless legacy handling answers 405.
 */
// No @ApiTags/@ApiOperation (.nax/rules/api-controllers.md): a JSON-RPC protocol endpoint, not a REST contract, so it
// is excluded from OpenAPI like FleetConfigTestHooksController.
@ApiExcludeController()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
@Controller('mcp')
@UseGuards(RequiresGuard)
export class McpController {
  private readonly handler: McpHttpHandler;

  constructor(
    executor: AssistantToolExecutor,
    private readonly registry: AssistantToolRegistry,
    private readonly permissions: PermissionService,
    @Inject(mcpConfig.KEY) private readonly cfg: ConfigType<typeof mcpConfig>,
    approvalTools: ApprovalMcpTools,
    memoryTools: MemoryMcpTools,
  ) {
    this.handler = createMcpHandler(
      (ctx) => {
        const extra = ctx.authInfo?.extra;
        const principal = extra?.[PRINCIPAL_KEY] as AgentPrincipal;
        // Permissions P1 US-005: the request's own set, so the stateless handler registers exactly the tools this
        // agent may see. An absent set registers nothing rather than everything.
        const visible = (extra?.[VISIBLE_TOOLS_KEY] as ReadonlySet<string> | undefined) ?? new Set<string>();
        return createKodaMcpServer([
          ...kodaMcpToolRegistrations(executor, principal, visible),
          ...approvalTools.registrations(principal),
          ...memoryTools.registrations(principal),
        ]);
      },
      { responseMode: 'json' },
    );
  }

  @Post()
  @Requires('mcp.access')
  post(@Principal() principal: KodaPrincipal, @Req() req: McpHttpRequest, @Res() reply: McpHttpReply) {
    return this.serve(principal, req, reply);
  }

  @Get()
  @Requires('mcp.access')
  get(@Principal() principal: KodaPrincipal, @Req() req: McpHttpRequest, @Res() reply: McpHttpReply) {
    return this.serve(principal, req, reply);
  }

  @Delete()
  @Requires('mcp.access')
  delete(@Principal() principal: KodaPrincipal, @Req() req: McpHttpRequest, @Res() reply: McpHttpReply) {
    return this.serve(principal, req, reply);
  }

  private async serve(principal: KodaPrincipal, req: McpHttpRequest, reply: McpHttpReply) {
    if (!this.cfg.mcpEnabled) throw new ConflictAppException({}, 'mcp.disabled');
    if (!principal || !isAgentPrincipal(principal)) throw new ForbiddenAppException({}, 'mcp.agentOnly');

    // Permissions P1 US-005: which tools this agent may see, resolved from the registry's keys before the SDK builds
    // the server. A tool left out is never registered, so the SDK answers a call to it with its unknown-tool error.
    const visibleTools = await visibleMcpToolNames({ registry: this.registry, permissions: this.permissions }, principal);

    // Fastify (production) hands over `req.raw`; the Express app the integration helper boots passes the Node request
    // itself, with its body already parsed (an empty object on GET, which a web Request refuses).
    const node = req.raw ?? (req as unknown as IncomingMessage);
    const request = await toWebRequest(node, node.method === 'POST' ? req.body : undefined);
    const response = await this.handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: principal.id,
        scopes: [],
        extra: { [PRINCIPAL_KEY]: principal, [VISIBLE_TOOLS_KEY]: visibleTools },
      },
    });

    // The SDK's Response is written as is: an MCP client expects JSON-RPC bodies, not the JsonResponse envelope.
    response.headers.forEach((value, key) => reply.header(key, value));
    reply.status(response.status);
    return reply.send(Buffer.from(await response.arrayBuffer()));
  }
}
