import { Injectable, Logger } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { MemoryItemRepository, MemoryItem } from './memory-item-repository';

export type Intent = 'answer' | 'diagnose' | 'plan' | 'update' | 'search';

export interface GetProjectContextQuery {
  projectId: string;
  actorId: string;
  intent: Intent;
  query?: string;
  ticketIds?: string[];
}

export interface RecentEvent {
  actorId: string;
  action: string;
  createdAt: Date;
}

export interface SemanticMemoryItem {
  id: string;
  kind: string;
  subject: string;
  predicate: string;
  object?: string;
  confidence?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetProjectContextResponse {
  projectId: string;
  recentEvents?: RecentEvent[];
  statusChangeHistory?: RecentEvent[];
  semanticMemory?: SemanticMemoryItem[];
}

@Injectable()
export class ContextBuilderService {
  private readonly logger = new Logger(ContextBuilderService.name);

  constructor(
    private readonly timelineService: TimelineService,
    private readonly memoryItemRepository: MemoryItemRepository,
  ) {}

  async getProjectContext(query: GetProjectContextQuery): Promise<GetProjectContextResponse> {
    const response: GetProjectContextResponse = {
      projectId: query.projectId,
    };

    if (query.intent === 'plan') {
      return response;
    }

    await this.loadSemanticMemory(query.projectId, response);

    if (query.intent === 'diagnose') {
      try {
        const timelineResult = await this.timelineService.getProjectTimeline({
          projectId: query.projectId,
          limit: 10,
        });

        response.recentEvents = timelineResult.events.map((e) => ({
          actorId: e.actorId,
          action: e.action,
          createdAt: e.createdAt,
        }));
      } catch (error) {
        this.logger.error(`Failed to get project timeline: ${error instanceof Error ? error.message : String(error)}`);
        response.recentEvents = [];
      }
    }

    if (query.intent === 'answer') {
      const extractedTicketIds: string[] = [];

      if (query.ticketIds && query.ticketIds.length > 0) {
        extractedTicketIds.push(...query.ticketIds);
      }

      if (query.query) {
        const ticketIdMatches = query.query.matchAll(/ticket[-_]?(\d+)|#(\d+)|([A-Z]+-\d+)/gi);
        for (const match of ticketIdMatches) {
          const ticketId = match[0];
          if (!extractedTicketIds.includes(ticketId)) {
            extractedTicketIds.push(ticketId);
          }
        }
      }

      if (extractedTicketIds.length > 0) {
        const allHistory: RecentEvent[] = [];
        for (const ticketId of extractedTicketIds) {
          if (!ticketId || ticketId.trim().length === 0) {
            continue;
          }
          try {
            const historyResult = await this.timelineService.getTicketHistory(ticketId);
            allHistory.push(
              ...historyResult.events.map((e) => ({
                actorId: e.actorId,
                action: e.action,
                createdAt: e.createdAt,
              }))
            );
          } catch (error) {
            this.logger.warn(`Failed to get ticket history for ${ticketId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (allHistory.length > 0) {
          response.statusChangeHistory = allHistory;
        }
      }
    }

    return response;
  }

  private async loadSemanticMemory(
    projectId: string,
    response: GetProjectContextResponse,
  ): Promise<void> {
    try {
      const memoryResult = await this.memoryItemRepository.findByProjectMemory({
        projectId,
      });
      response.semanticMemory = memoryResult.items
        .map((item: MemoryItem) => ({
          id: item.id,
          kind: item.kind,
          subject: item.subject,
          predicate: item.predicate,
          object: item.object,
          confidence: item.confidence,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 10);
    } catch (error) {
      this.logger.warn(`Failed to get project memory: ${error instanceof Error ? error.message : String(error)}`);
      response.semanticMemory = [];
    }
  }
}