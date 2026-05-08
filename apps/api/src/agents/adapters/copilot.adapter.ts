import type { AgentAdapter, AgentCapability } from '../agent-registry.service';
import type { GetProjectContextResponse } from '../../context/context-builder.service';

export class CopilotAdapter implements AgentAdapter {
  readonly agentId = 'copilot';
  readonly name = 'GitHub Copilot';
  readonly capabilities: AgentCapability[] = [
    'ticket_ops',
    'code_search',
    'code_write',
  ];

  formatContext(ctx: GetProjectContextResponse): string {
    const lines: string[] = [];

    lines.push('<!-- koda-context -->');

    this.formatCanonicalState(ctx, lines);
    this.formatRetrievedContext(ctx, lines);
    this.formatMeta(ctx, lines);

    lines.push('<!-- /koda-context -->');
    return lines.join('\n');
  }

  private formatCanonicalState(ctx: GetProjectContextResponse, lines: string[]): void {
    const { tickets, recentEvents, activeDecisions } = ctx.canonicalState;

    if (tickets && tickets.length > 0) {
      lines.push('## Tickets');
      for (const t of tickets) {
        const assigned = t.assignedToUserId ? ` @${t.assignedToUserId}` : '';
        lines.push(`- [${t.status}] ${t.title} (${t.priority})${assigned}`);
      }
    }

    if (recentEvents && recentEvents.length > 0) {
      lines.push('## Recent Events');
      for (const e of recentEvents) {
        lines.push(`- ${e.eventType}/${e.action} by ${e.actorId}`);
      }
    }

    if (activeDecisions && activeDecisions.length > 0) {
      lines.push('## Decisions');
      for (const d of activeDecisions) {
        const rationale = d.rationale ? ` (${d.rationale})` : '';
        lines.push(`- ${d.topic}: ${d.decision}${rationale}`);
      }
    }
  }

  private formatRetrievedContext(ctx: GetProjectContextResponse, lines: string[]): void {
    const { documents, semanticMemory, graphPaths, codeIntel } = ctx.retrievedContext;

    if (documents.results.length > 0) {
      lines.push('## Documents');
      for (const doc of documents.results) {
        lines.push(`- ${doc.sourceId}: ${doc.content}`);
      }
    }

    if (semanticMemory.length > 0) {
      lines.push('## Memory');
      for (const m of semanticMemory) {
        const obj = m.object ? ` → ${m.object}` : '';
        lines.push(`- ${m.subject} ${m.predicate}${obj}`);
      }
    }

    if (graphPaths && graphPaths.length > 0) {
      lines.push('## Entity Graph');
      for (const p of graphPaths) {
        lines.push(`- ${JSON.stringify(p)}`);
      }
    }

    if (codeIntel && codeIntel.length > 0) {
      lines.push('## Code Intelligence');
      for (const c of codeIntel) {
        lines.push(`- ${JSON.stringify(c)}`);
      }
    }
  }

  private formatMeta(ctx: GetProjectContextResponse, lines: string[]): void {
    lines.push(
      `> ${ctx.meta.intent} | ${ctx.meta.tokensUsed} tokens | ${ctx.meta.latencyMs}ms`,
    );
  }
}
