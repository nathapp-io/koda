import { Injectable } from '@nestjs/common';
import { TimelineService } from './timeline.service';

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

export interface GetProjectContextResponse {
  projectId: string;
  recentEvents?: RecentEvent[];
  statusChangeHistory?: RecentEvent[];
}

@Injectable()
export class ContextBuilderService {
  constructor(private readonly timelineService: TimelineService) {}

  async getProjectContext(query: GetProjectContextQuery): Promise<GetProjectContextResponse> {
    const response: GetProjectContextResponse = {
      projectId: query.projectId,
    };

    if (query.intent === 'plan') {
      return response;
    }

    if (query.intent === 'diagnose') {
      const timelineResult = await this.timelineService.getProjectTimeline({
        projectId: query.projectId,
        limit: 10,
      });

      response.recentEvents = timelineResult.events.map((e) => ({
        actorId: e.actorId,
        action: e.action,
        createdAt: e.createdAt,
      }));
    }

    if (query.intent === 'answer' && query.query) {
      const ticketIdMatch = query.query.match(/ticket[-_]?(\d+)|(\d+)/i);
      if (ticketIdMatch) {
        const ticketId = ticketIdMatch[0];
        const historyResult = await this.timelineService.getTicketHistory(ticketId);

        response.statusChangeHistory = historyResult.events.map((e) => ({
          actorId: e.actorId,
          action: e.action,
          createdAt: e.createdAt,
        }));
      }
    }

    return response;
  }
}