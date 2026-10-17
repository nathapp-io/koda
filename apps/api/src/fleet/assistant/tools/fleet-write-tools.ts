import { Injectable, type OnModuleInit } from '@nestjs/common';
import { FleetJobsService } from '../../jobs/fleet-jobs.service';
import { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { dispatchJobTool } from './dispatch-job-tool';
import { requeueJobTool } from './requeue-job-tool';

/**
 * Fleet S5b 2b2 US-003 (2b2-D8): the fleet write tool group — the tools that propose dispatching, requeueing or
 * cancelling a fleet job of the thread's project and run it on approval. It registers with the registry at
 * bootstrap, like the other groups; `koda_requeue_job` (US-004) and `koda_cancel_job` (US-005) join it here.
 */
@Injectable()
export class FleetWriteTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly fleetJobs: FleetJobsService,
    private readonly knowledge: KnowledgeIndexService,
  ) {}

  onModuleInit(): void {
    this.registry.register(dispatchJobTool(this.fleetJobs, this.knowledge), requeueJobTool(this.fleetJobs, this.knowledge));
  }
}
