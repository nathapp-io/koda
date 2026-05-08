import type { AgentAdapter, AgentCapability } from '../agent-registry.service';
import type { GetProjectContextResponse } from '../../context/context-builder.service';

export class NaxAdapter implements AgentAdapter {
  readonly agentId = 'nax';
  readonly name = 'NAX';
  readonly capabilities: AgentCapability[] = [
    'ticket_ops',
    'code_write',
    'planning',
  ];

  formatContext(ctx: GetProjectContextResponse): string {
    const lines: string[] = [];

    lines.push('=== KODA-PROJECT-CONTEXT ===');

    this.formatMeta(ctx, lines);
    this.formatTickets(ctx, lines);
    this.formatEvents(ctx, lines);
    this.formatDecisions(ctx, lines);
    this.formatDocuments(ctx, lines);
    this.formatMemory(ctx, lines);
    this.formatGraphAndIntel(ctx, lines);

    lines.push('=== END-CONTEXT ===');
    return lines.join('\n');
  }

  private formatMeta(ctx: GetProjectContextResponse, lines: string[]): void {
    lines.push(`Intent: ${ctx.meta.intent}`);
    lines.push(`Tokens: ${ctx.meta.tokensUsed}`);
    lines.push(`RetrievedAt: ${ctx.meta.retrievedAt.toISOString()}`);
    lines.push(`LatencyMs: ${ctx.meta.latencyMs}`);
  }

  private formatTickets(ctx: GetProjectContextResponse, lines: string[]): void {
    const { tickets } = ctx.canonicalState;
    if (!tickets || tickets.length === 0) {
      lines.push('TICKETS: []');
      return;
    }

    lines.push('---');
    for (const t of tickets) {
      const assigned = t.assignedToUserId
        ? ` assigned=${t.assignedToUserId}`
        : '';
      lines.push(
        `TICKET: id=${t.id} title="${t.title}" status=${t.status} ` +
        `priority=${t.priority}${assigned} createdAt=${t.createdAt.toISOString()}`,
      );
    }
  }

  private formatEvents(ctx: GetProjectContextResponse, lines: string[]): void {
    const { recentEvents } = ctx.canonicalState;
    if (!recentEvents || recentEvents.length === 0) {
      lines.push('EVENTS: []');
      return;
    }

    for (const e of recentEvents) {
      const payloadStr = e.payload ? JSON.stringify(e.payload) : '{}';
      const rationale = e.rationale ? ` rationale="${e.rationale}"` : '';
      lines.push(
        `EVENT: type=${e.eventType} action=${e.action} actor=${e.actorId} ` +
        `payload=${payloadStr}${rationale} at=${e.createdAt.toISOString()}`,
      );
    }
  }

  private formatDecisions(ctx: GetProjectContextResponse, lines: string[]): void {
    const { activeDecisions } = ctx.canonicalState;
    if (!activeDecisions || activeDecisions.length === 0) {
      lines.push('DECISIONS: []');
      return;
    }

    for (const d of activeDecisions) {
      const rationale = d.rationale ? ` rationale="${d.rationale}"` : '';
      lines.push(
        `DECISION: topic="${d.topic}" decision="${d.decision}"${rationale} at=${d.createdAt.toISOString()}`,
      );
    }
  }

  private formatDocuments(ctx: GetProjectContextResponse, lines: string[]): void {
    const { documents } = ctx.retrievedContext;
    if (documents.results.length === 0) {
      lines.push('DOCS: []');
      return;
    }

    for (const doc of documents.results) {
      lines.push(
        `DOC: source=${doc.source} sourceId=${doc.sourceId} ` +
        `score=${doc.score.toFixed(2)} content="${doc.content}"`,
      );
    }
  }

  private formatMemory(ctx: GetProjectContextResponse, lines: string[]): void {
    const { semanticMemory } = ctx.retrievedContext;
    if (semanticMemory.length === 0) {
      lines.push('MEMORY: []');
      return;
    }

    for (const m of semanticMemory) {
      const obj = m.object ? ` object="${m.object}"` : '';
      lines.push(
        `MEMORY: kind=${m.kind} confidence=${m.confidence.toFixed(1)} ` +
        `subject="${m.subject}" predicate="${m.predicate}"${obj} status=${m.status}`,
      );
    }
  }

  private formatGraphAndIntel(ctx: GetProjectContextResponse, lines: string[]): void {
    const { graphPaths, codeIntel } = ctx.retrievedContext;

    if (graphPaths && graphPaths.length > 0) {
      for (const p of graphPaths) {
        lines.push(`GRAPH: ${JSON.stringify(p)}`);
      }
    }

    if (codeIntel && codeIntel.length > 0) {
      for (const c of codeIntel) {
        lines.push(`CODE_INTEL: ${JSON.stringify(c)}`);
      }
    }
  }
}
