import { Injectable, Logger } from '@nestjs/common';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { runWithActionContext } from '../../action-context/action-context';
import type { McpToolRegistration } from '../../fleet/assistant/mcp/mcp-server.factory';
import { toMcpToolResult } from '../../fleet/assistant/mcp/mcp-tool-catalog';
import { ApprovalRequestQueries } from '../approval-request.queries';
import { ApprovalDecisionService } from '../approval-decision.service';
import type { ApprovalRequestStatus } from '../domain/approval.domain';
import { ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from '../domain/approval.errors';

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
    }, {
      name: 'koda_decide_approval',
      description: 'Approve or reject one pending approval request by its id. An approval runs the requested action at once; the answer is the request\'s new status. This agent may decide a request only when its permissions and the request\'s policy allow it; it may confirm its own request only when the request requires `self`.',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 },
        decision: { type: 'string', enum: ['approve', 'reject'] },
        comment: { type: 'string', maxLength: 2000 },
        params: { type: 'object' },
      }, required: ['id', 'decision'], additionalProperties: false },
      handler: (input) => runWithActionContext({ actor: ref, origin: 'mcp' }, async () => {
        const args = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
        const invalid = (field: string) => toMcpToolResult({ content: `invalid_input: ${field}`, isError: true });
        const unknown = Object.keys(args).find((key) => !['id', 'decision', 'comment', 'params'].includes(key));
        if (unknown !== undefined) return invalid(unknown);
        if (typeof args.id !== 'string' || args.id.length < 1 || args.id.length > 64) return invalid('id');
        if (args.decision !== 'approve' && args.decision !== 'reject') return invalid('decision');
        if (args.comment !== undefined && (typeof args.comment !== 'string' || args.comment.length > 2000)) return invalid('comment');
        if (Object.hasOwn(args, 'params') && (args.params === null || typeof args.params !== 'object' || Array.isArray(args.params)
          || (Object.getPrototypeOf(args.params) !== Object.prototype && Object.getPrototypeOf(args.params) !== null))) return invalid('params');
        try {
          await this.queries.get(ref, args.id);
          const comment = (args.comment as string | undefined) ?? null;
          const request = Object.hasOwn(args, 'params')
            ? await this.decisions.decide(args.id, args.decision, comment, undefined, args.params)
            : await this.decisions.decide(args.id, args.decision, comment);
          return toMcpToolResult({ content: `${request.id} ${request.status}`, isError: false });
        } catch (error) {
          if (error instanceof ApprovalRequestNotFoundError) return toMcpToolResult({ content: 'not_found', isError: true });
          if (error instanceof ApprovalRequestNotPendingError) return toMcpToolResult({ content: `not_pending: ${error.status}`, isError: true });
          if (error instanceof ApprovalRequestExpiredError) return toMcpToolResult({ content: 'expired', isError: true });
          if (error instanceof ApprovalDecideForbiddenError) return toMcpToolResult({ content: `forbidden: ${error.reason}`, isError: true });
          this.logger.error('MCP tool koda_decide_approval failed', error instanceof Error ? error.stack : String(error));
          return toMcpToolResult({ content: 'error: koda_decide_approval failed', isError: true });
        }
      }),
    }];
  }
}
