import { Injectable, Logger } from '@nestjs/common';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { runWithActionContext } from '../../action-context/action-context';
import type { McpToolRegistration } from '../../fleet/assistant/mcp/mcp-server.factory';
import { toMcpToolResult } from '../../fleet/assistant/mcp/mcp-tool-catalog';
import { ApprovalRequestQueries } from '../approval-request.queries';
import { ApprovalDecisionService } from '../approval-decision.service';
import type { ApprovalRequestStatus } from '../domain/approval.domain';

const STATUSES: ApprovalRequestStatus[] = ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'executed', 'failed'];

/** MCP-only tools: visibility is universal; the query service owns request visibility. */
@Injectable()
export class ApprovalMcpTools {
  private readonly logger = new Logger(ApprovalMcpTools.name);

  constructor(private readonly queries: ApprovalRequestQueries, private readonly decisions: ApprovalDecisionService) {}

  registrations(principal: AgentPrincipal): McpToolRegistration[] {
    const ref = { type: 'AGENT' as const, id: principal.id };
    return [{
      name: 'koda_list_approvals',
      description: 'List approval requests this agent can decide or opened itself, newest first, 20 per page. Each line names the request id, its status, the permission key it needs approval for, its project, who asked, the mode it requires and when it expires.',
      inputSchema: {
        type: 'object', properties: {
          status: { type: 'string', enum: [...STATUSES] },
          mine: { type: 'boolean' }, page: { type: 'integer', minimum: 1 },
        }, additionalProperties: false,
      },
      handler: (input) => runWithActionContext({ actor: ref, origin: 'mcp' }, async () => {
        const args = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
        const invalid = (field: string) => toMcpToolResult({ content: `invalid_input: ${field}`, isError: true });
        if (args.status !== undefined && !STATUSES.includes(args.status as ApprovalRequestStatus)) return invalid('status');
        if (args.page !== undefined && (typeof args.page !== 'number' || !Number.isInteger(args.page) || args.page < 1)) return invalid('page');
        if (args.mine !== undefined && typeof args.mine !== 'boolean') return invalid('mine');
        try {
          const page = await this.queries.list(ref, { status: args.status as ApprovalRequestStatus | undefined, mine: args.mine as boolean | undefined }, { current: (args.page as number | undefined) ?? 1, size: 20 });
          const lines = page.records.map((request) => `${request.id} ${request.status} ${request.permissionKey} project=${request.projectId ?? 'global'} actor=${request.actor.type}/${request.actor.id} requires=${request.requiredMode} expires=${request.expiresAt.toISOString()}`);
          if (lines.length === 0) return toMcpToolResult({ content: 'no approval requests', isError: false });
          if (page.hasNext) lines.push(`next page: ${page.current + 1}`);
          return toMcpToolResult({ content: lines.join('\n'), isError: false });
        } catch (error) {
          this.logger.error('MCP tool koda_list_approvals failed', error instanceof Error ? error.stack : String(error));
          return toMcpToolResult({ content: 'error: koda_list_approvals failed', isError: true });
        }
      }),
    }];
  }
}
