import type { AgentAdapter, AgentCapability } from '../agent-registry.service';
import type { GetProjectContextResponse } from '../../context/context-builder.service';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId = 'claude-code';
  readonly name = 'Claude Code';
  readonly capabilities: AgentCapability[] = [
    'ticket_ops',
    'code_search',
    'code_write',
    'planning',
  ];

  formatContext(ctx: GetProjectContextResponse): string {
    const lines: string[] = [];

    lines.push('<project-context>');
    lines.push('');

    this.formatCanonicalState(ctx, lines);
    lines.push('');
    this.formatRetrievedContext(ctx, lines);
    this.formatMeta(ctx, lines);

    lines.push('</project-context>');
    return lines.join('\n');
  }

  private formatCanonicalState(ctx: GetProjectContextResponse, lines: string[]): void {
    lines.push('## Canonical State');

    const { tickets, recentEvents, activeDecisions } = ctx.canonicalState;

    if (tickets && tickets.length > 0) {
      lines.push('');
      lines.push('### Tickets');
      for (const t of tickets) {
        const assigned = t.assignedToUserId
          ? ` (assigned: ${t.assignedToUserId})`
          : '';
        lines.push(`- [${t.priority}] ${t.title} (${t.status})${assigned}`);
      }
    }

    if (recentEvents && recentEvents.length > 0) {
      lines.push('');
      lines.push('### Recent Events');
      for (const e of recentEvents) {
        const payloadStr = e.payload ? ` | ${JSON.stringify(e.payload)}` : '';
        lines.push(`- ${e.eventType}: ${e.action}${payloadStr}`);
      }
    }

    if (activeDecisions && activeDecisions.length > 0) {
      lines.push('');
      lines.push('### Active Decisions');
      for (const d of activeDecisions) {
        const rationale = d.rationale ? ` — ${d.rationale}` : '';
        lines.push(`- ${d.topic}: ${d.decision}${rationale}`);
      }
    }
  }

  private formatRetrievedContext(ctx: GetProjectContextResponse, lines: string[]): void {
    lines.push('## Retrieved Context');
    const { documents, semanticMemory, graphPaths, codeIntel } = ctx.retrievedContext;

    if (documents.results.length > 0) {
      lines.push('');
      lines.push('### Documents');
      for (const doc of documents.results) {
        lines.push(`- ${doc.sourceId} (score: ${doc.score.toFixed(2)}): ${doc.content}`);
      }
    }

    if (semanticMemory.length > 0) {
      lines.push('');
      lines.push('### Project Memory');
      for (const m of semanticMemory) {
        const obj = m.object ? ` → ${m.object}` : '';
        lines.push(`- ${m.kind}(${m.confidence.toFixed(1)}): ${m.subject} ${m.predicate}${obj}`);
      }
    }

    if (graphPaths && graphPaths.length > 0) {
      lines.push('');
      lines.push('### Entity Graph');
      for (const p of graphPaths) {
        lines.push(`- ${JSON.stringify(p)}`);
      }
    }

    if (codeIntel && codeIntel.length > 0) {
      lines.push('');
      lines.push('### Code Intelligence');
      for (const c of codeIntel) {
        lines.push(`- ${JSON.stringify(c)}`);
      }
    }
  }

  private formatMeta(ctx: GetProjectContextResponse, lines: string[]): void {
    lines.push('');
    lines.push(
      `> Intent: ${ctx.meta.intent} | Tokens: ${ctx.meta.tokensUsed} | ` +
      `Retrieved: ${ctx.meta.retrievedAt.toISOString()} | Latency: ${ctx.meta.latencyMs}ms`,
    );
  }
}
