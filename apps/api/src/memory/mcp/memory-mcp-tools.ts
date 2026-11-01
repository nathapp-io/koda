import { Injectable, Logger } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { runWithActionContext } from '../../action-context/action-context';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import type { McpToolRegistration } from '../../fleet/assistant/mcp/mcp-server.factory';
import { toMcpToolResult } from '../../fleet/assistant/mcp/mcp-tool-catalog';
import { MemoryWriteService } from '../memory-write.service';

/** The direct MCP entry point for the same project-aware retire route used by REST. */
@Injectable()
export class MemoryMcpTools {
  private readonly logger = new Logger(MemoryMcpTools.name);

  constructor(
    private readonly memoryWrites: MemoryWriteService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  registrations(principal: AgentPrincipal): McpToolRegistration[] {
    const ref = { type: 'AGENT' as const, id: principal.id };
    return [{
      name: 'koda_retire_decision',
      description: 'Retire an active decision by its memory id. The project is derived from the decision; permission and approval are checked by the same gate as the REST route.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          reason: { type: 'string', maxLength: 500 },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: (input) => runWithActionContext({ actor: ref, origin: 'mcp' }, async () => {
        const args = input !== null && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {};
        const invalid = (field: string) => toMcpToolResult({ content: `invalid_input: ${field}`, isError: true });
        const unknown = Object.keys(args).find((key) => key !== 'id' && key !== 'reason');
        if (unknown !== undefined) return invalid(unknown);
        if (typeof args.id !== 'string' || args.id.length < 1 || args.id.length > 64) return invalid('id');
        if (args.reason !== undefined && (typeof args.reason !== 'string' || args.reason.length > 500)) return invalid('reason');

        try {
          const { projectId } = await this.memoryWrites.retireTarget(principal, args.id);
          const outcome = await this.routeGate.run({
            key: 'memory.decision.retire',
            variant: 'rest:memory.decision.retire',
            projectId,
            input: { id: args.id, body: { ...(args.reason === undefined ? {} : { reason: args.reason }) } },
          });
          const gateOutcome = outcome as unknown as { status: string; request?: { id: string } };
          if (gateOutcome.status === 'pending' && gateOutcome.request !== undefined) {
            return toMcpToolResult({ content: `approval request ${gateOutcome.request.id}`, isError: false });
          }
          if (gateOutcome.status === 'done' || gateOutcome.status === 'executed') {
            return toMcpToolResult({ content: `retired ${args.id}`, isError: false });
          }
          return toMcpToolResult({ content: 'error: koda_retire_decision failed', isError: true });
        } catch (error) {
          if (error instanceof NotFoundAppException && error.prefix === 'memory.notFound') {
            return toMcpToolResult({ content: 'decision not found', isError: true });
          }
          this.logger.error('MCP tool koda_retire_decision failed', error instanceof Error ? error.stack : String(error));
          return toMcpToolResult({ content: 'error: koda_retire_decision failed', isError: true });
        }
      }),
    }];
  }
}
