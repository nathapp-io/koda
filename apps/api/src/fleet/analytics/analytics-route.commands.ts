import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { AnalyticsService } from './analytics.service';
import type { DeleteInput, DeletedView } from './analytics.types';
import { DeleteAnalyticsBody, DeleteAnalyticsQuery } from './dto/analytics-query.dto';

export const ANALYTICS_ROUTE_VARIANTS = { delete: 'rest:fleet-analytics.delete' } as const;

@Injectable()
export class AnalyticsRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly analytics: AnalyticsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<DeleteInput, DeletedView>({
      key: 'fleet.analytics.delete', variant: ANALYTICS_ROUTE_VARIANTS.delete,
      parse: (input) => ({
        ...parseBody(DeleteAnalyticsQuery, input),
        ...parseBody(DeleteAnalyticsBody, input),
      }),
      run: (principal, input) => this.analytics.deleteRows(principal.id, input, new Date()),
      toResult: (result) => result,
    }, this.loader));
  }
}
