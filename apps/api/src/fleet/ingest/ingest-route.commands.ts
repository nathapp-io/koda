import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { IngestRequeueService } from './ingest-requeue.service';

export const INGEST_ROUTE_VARIANTS = {
  backfill: 'rest:fleet-ingest.backfill',
  rerunJob: 'rest:fleet-ingest.rerun-job',
  rerunOutdated: 'rest:fleet-ingest.rerun-outdated',
} as const;

@Injectable()
export class IngestRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly ingestRequeue: IngestRequeueService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<Record<string, never>, { queued: number }>({
      key: 'fleet.ingest.backfill', variant: INGEST_ROUTE_VARIANTS.backfill,
      parse: (input) => parseRouteInput(input, []),
      run: (principal) => this.ingestRequeue.backfill(principal.id),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ jobId: string }, { queued: number }>({
      key: 'fleet.ingest.rerun', variant: INGEST_ROUTE_VARIANTS.rerunJob,
      parse: (input) => parseRouteInput(input, ['jobId']),
      run: (principal, input) => this.ingestRequeue.rerunJob(principal.id, input.jobId),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<Record<string, never>, { queued: number }>({
      key: 'fleet.ingest.rerun', variant: INGEST_ROUTE_VARIANTS.rerunOutdated,
      parse: (input) => parseRouteInput(input, []),
      run: (principal) => this.ingestRequeue.rerunOutdated(principal.id),
      toResult: (result) => result,
    }, this.loader));
  }
}
